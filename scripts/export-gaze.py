"""Export released FLX checkpoints, then check trained-graph parity on CPU/DML.

Uses the checkpoint's original graph, not a recreation in modern Keras.
Conversion dependencies live in .local/gaze-convert; TensorFlow is not needed
by the camera process. Invoke from the repository root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
import numpy as np
import onnx
import onnxruntime as ort
import tensorflow as tf
import tf2onnx
from dxgi_adapters import adapters

INPUTS = ["inputs/input_img:0", "inputs/input_fp:0", "inputs/input_ang:0"]
OUTPUT = "tower_0/warping_model/apply_lcm/Add:0"


def examples():
    rng = np.random.default_rng(1209070)
    # Smooth and textured image probes, plus all intended correction extremes.
    yy, xx = np.mgrid[:48, :64].astype(np.float32)
    image = np.stack([xx / 63, yy / 47, np.full_like(xx, .5)], axis=-1)
    anchor_points = [(16, 24), (24, 19), (40, 19), (48, 24), (40, 29), (24, 29)]
    anchors = np.stack([a for x, y in anchor_points for a in (xx-x, yy-y)], axis=-1)
    for index, angle in enumerate([(0, 0), (5, 0), (10, 0), (15, 0), (10, -3), (10, 3)]):
        eye = image if index % 2 == 0 else rng.uniform(0, 1, (48, 64, 3)).astype(np.float32)
        yield {INPUTS[0]: eye[None].copy(), INPUTS[1]: anchors[None].copy(), INPUTS[2]: np.array([angle], np.float32)}


def runtime(model, provider, device, profile=False):
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = 1
    options.enable_profiling = profile
    options.profile_file_prefix = "artifacts/gaze/onnx-profile"
    providers = [("DmlExecutionProvider", {"device_id": device})] if provider == "dml" else ["CPUExecutionProvider"]
    return ort.InferenceSession(str(model), sess_options=options, providers=providers)


def export(eye, args):
    prefix = args.weights / eye / eye
    graph = tf.Graph()
    with graph.as_default():
        phase = tf.constant(False, name="inference_phase")
        saver = tf.compat.v1.train.import_meta_graph(str(prefix)+".meta", clear_devices=True,
                                                    input_map={"model_control/phase_train:0": phase})
        config = tf.compat.v1.ConfigProto(intra_op_parallelism_threads=1, inter_op_parallelism_threads=1)
        with tf.compat.v1.Session(graph=graph, config=config) as session:
            saver.restore(session, str(prefix))
            probes = list(examples())
            reference = [session.run(OUTPUT, feed_dict=probe) for probe in probes]
            frozen = tf.compat.v1.graph_util.convert_variables_to_constants(session, graph.as_graph_def(), [OUTPUT.split(":")[0]])
    destination = args.output / f"flx-{eye.lower()}.onnx"
    model, _ = tf2onnx.convert.from_graph_def(frozen, input_names=INPUTS, output_names=[OUTPUT],
                                              opset=17, shape_override={INPUTS[0]: [1,48,64,3], INPUTS[1]: [1,48,64,12], INPUTS[2]: [1,2]})
    model.doc_string = "Released WangWilly/gaze-correction-cam v0.1.1 FLX checkpoint; inference phase frozen false. BSD-3-Clause."
    onnx.checker.check_model(model)
    onnx.save(model, str(destination))
    cpu = runtime(destination, "cpu", args.device)
    dml = runtime(destination, "dml", args.device, profile=True)
    evidence = {"eye": eye, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "probes": []}
    for probe, expected in zip(probes, reference):
        cpu_output = cpu.run(None, probe)[0]
        gpu_output = dml.run(None, probe)[0]
        cpu_error = float(np.max(np.abs(cpu_output-expected)))
        gpu_error = float(np.max(np.abs(gpu_output-expected)))
        # Floating-point convolution fusion/reordering can change the last
        # bits. Limits correspond to 0.13 (CPU) / 0.51 (DML) levels in RGB8.
        if not np.isfinite(gpu_output).all() or cpu_error > .0005 or gpu_error > .002:
            raise RuntimeError(f"{eye} failed trained-graph parity: CPU {cpu_error}, DML {gpu_error}")
        evidence["probes"].append({"angle": probe[INPUTS[2]].tolist()[0], "cpu_max_abs_error":cpu_error, "dml_max_abs_error":gpu_error})
    probe = probes[2]
    for _ in range(20):
        dml.run(None, probe)
    samples = []
    for _ in range(100):
        started = time.perf_counter()
        dml.run(None, probe)
        samples.append((time.perf_counter()-started)*1000)
    profile = Path(dml.end_profiling())
    events = json.loads(profile.read_text())
    providers = sorted({e.get("args", {}).get("provider", "") for e in events if e.get("cat")=="Node"})
    evidence.update({"dml_device_id":args.device, "profile":str(profile), "executed_providers":providers,
                     "inference_ms_median":float(np.median(samples)), "inference_ms_p95":float(np.percentile(samples,95))})
    # Provider registration alone cannot establish GPU execution. Record and
    # require a DML kernel event in the actual ORT execution profile.
    if "DmlExecutionProvider" not in providers:
        raise RuntimeError(f"{eye}: no DirectML execution found in profile: {providers}")
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, default=Path(".local/gaze-weights/weights/warping_model/flx/12"))
    parser.add_argument("--output", type=Path, default=Path("models/gaze"))
    parser.add_argument("--device", type=int)
    args = parser.parse_args()
    available = [a for a in adapters() if not a["software"]]
    if args.device is None:
        args.device = max(available, key=lambda a:a["dedicated_video_bytes"])["index"]
    selected = next((a for a in available if a["index"] == args.device), None)
    if selected is None:
        raise RuntimeError("Choose a hardware DirectML adapter")
    args.output.mkdir(parents=True, exist_ok=True)
    Path("artifacts/gaze").mkdir(parents=True, exist_ok=True)
    tf.compat.v1.disable_eager_execution()
    evidence = {"source":"WangWilly/gaze-correction-cam v0.1.1 released original FLX graphs", "scope":"numeric parity and local inference; not camera naturalness", "adapter":selected, "models":[]}
    for eye in ["L", "R"]:
        evidence["models"].append(export(eye, args))
    Path("artifacts/gaze/export-parity.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
