"""Evaluate a learned local endpoint classifier on recorded interview pauses.

This is a diagnostic, not live endpointing or meeting latency certification.
The only future information used is the offline continuation/ending label.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import time
import wave

# Control this probe's CPU use without modifying app or machine settings.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / ".local" / "smart-turn-3.2"
MODEL_SHA = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"

def workspace_path(value):
    path = Path(value)
    path = (path if path.is_absolute() else ROOT / path).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError("Evaluation files must stay in the workspace")
    return path

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def stats(values):
    ordered = sorted(values)
    if not ordered:
        return None
    return {"count": len(values), "median": ordered[len(values)//2],
            "p95": ordered[math.ceil(len(values)*.95)-1], "max": ordered[-1]}

def summarize(rows):
    points = [point for row in rows for point in row["cuts"]]
    curves = []
    for threshold in [.5, .8, .9, .95, .99]:
        tp = sum(p["complete"] and p["probability"] > threshold for p in points)
        fn = sum(p["complete"] and p["probability"] <= threshold for p in points)
        fp = sum(not p["complete"] and p["probability"] > threshold for p in points)
        tn = sum(not p["complete"] and p["probability"] <= threshold for p in points)
        curves.append({"threshold": threshold, "trueEndingsAccepted": tp, "trueEndingsRejected": fn,
                       "internalPausesAccepted": fp, "internalPausesRejected": tn,
                       "questionsWithPrematureEndpoint": sum(any(not p["complete"] and p["probability"] > threshold for p in row["cuts"]) for row in rows)})
    return {"waves": len(rows), "candidates": len(points), "thresholds": curves,
            "featureMs": stats([p["featureMs"] for p in points]),
            "inferenceMs": stats([p["inferenceMs"] for p in points]),
            "pipelineMs": stats([p["pipelineMs"] for p in points]),
            "decisionFromLastVoiceMs": stats([p["decisionFromLastVoiceMs"] for p in points])}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cuts", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--threads", type=int, default=1, choices=[1, 2, 4])
    args = parser.parse_args()
    cuts_path, output = workspace_path(args.cuts), workspace_path(args.output)
    model = ASSETS / "smart-turn-v3.2-cpu.onnx"
    if sha(model) != MODEL_SHA:
        raise ValueError("Pinned model checksum mismatch")
    sources = json.loads((ASSETS / "sources.json").read_text(encoding="utf-8"))
    for asset in sources:
        if sha(ASSETS / asset["file"]) != asset["sha256"]:
            raise ValueError("Evaluation asset changed after download")
    spec = importlib.util.spec_from_file_location("smart_turn_features", ASSETS / "_whisper_features.py")
    features = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(features)
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    before = time.perf_counter()
    session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter()-before)*1000
    zeros = features.compute_whisper_log_mel_features(np.zeros(128000, dtype=np.float32))[None]
    for _ in range(3):
        session.run(None, {"input_features": zeros})
    fixture = json.loads(cuts_path.read_text(encoding="utf-8"))
    report = {"status": "in_progress", "model": "smart-turn-v3.2-cpu", "sources": sources,"quietMs": fixture["quietMs"],
              "scope": "Offline synthetic questions at production-VAD quiet candidates. Inference sees only the prefix available at each candidate. Each complete wave is one question; all earlier pauses are continuation labels. No live ASR/answer service timing, human-audio certification or held-out threshold selection.",
              "environment": {"python": platform.python_version(), "numpy": np.__version__, "onnxruntime": ort.__version__,
                              "provider": session.get_providers(), "intraOpThreads": args.threads, "loadMs": load_ms},
              "inputSha256": sha(cuts_path), "vadSha256": fixture["vadSha256"],"vadProbeSha256": fixture["probeSha256"], "probeSha256": sha(Path(__file__)), "rows": []}
    def persist():
        report["summary"] = summarize(report["rows"])
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    for row in fixture["rows"]:
        file = workspace_path(row["wave"])
        if sha(file) != row["sha256"]:
            raise ValueError("Recorded wave changed after VAD probe")
        with wave.open(str(file), "rb") as recording:
            if (recording.getnchannels(), recording.getframerate(), recording.getsampwidth()) != (1, 16000, 2):
                raise ValueError("Expected mono PCM16 at 16 kHz")
            audio = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2").astype(np.float32)/32768.
        # A live stream continues to capture silence after playback ends.
        audio = np.pad(audio, (0, 16000))
        judged = {"wave": str(file.relative_to(ROOT)), "sha256": row["sha256"], "cuts": []}
        for cut in row["cuts"]:
            endpoint = cut["availableAtMs"]*16
            observed = audio[max(0, endpoint-128000):endpoint]
            observed = np.pad(observed, (128000-len(observed), 0))
            start = time.perf_counter()
            input_features = features.compute_whisper_log_mel_features(observed)[None]
            computed = time.perf_counter()
            probability = float(session.run(None, {"input_features": input_features})[0].reshape(-1)[0])
            finished = time.perf_counter()
            if not 0 <= probability <= 1 or not math.isfinite(probability):
                raise ValueError("Model did not return a finite sigmoid probability")
            duration = (finished-start)*1000
            judged["cuts"].append({**cut, "probability": probability,
                                   "featureMs": (computed-start)*1000, "inferenceMs": (finished-computed)*1000,
                                   "pipelineMs": duration, "decisionFromLastVoiceMs": cut["availableAtMs"]-cut["lastVoiceMs"]+duration})
        report["rows"].append(judged)
        persist()
        print(f"Scored {file.parent.name}/{file.name}: {len(judged['cuts'])} pauses", flush=True)
    report["status"] = "complete"
    persist()
    print(json.dumps(report["summary"], indent=2))

if __name__ == "__main__":
    main()
