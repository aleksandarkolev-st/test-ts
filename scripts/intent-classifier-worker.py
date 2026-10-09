"""Persistent, CPU-only NLI intent probe. No generation or network access.

Hypotheses describe the output classes; they are not trigger phrases, examples,
or answer templates. Scores are model probabilities, not calibrated confidence.
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HYPOTHESES = {
    "request": "The speaker is asking the listener to respond, explain, solve, clarify, or take an action.",
    "background": "The speaker is providing information or background without asking the listener for a response.",
    "ready": "The speaker has expressed a complete request that the listener can respond to now.",
    "unfinished": "The speaker is still expressing an unfinished request and more words are needed to know what is being asked.",
}


class Classifier:
    def __init__(self, models, threads=2):
        models = Path(models)
        manifest = json.loads((models / "manifest.json").read_text(encoding="utf-8"))
        for asset in manifest["assets"]:
            path = models / asset["file"]
            if path.resolve().parent != models.resolve() and models.resolve() not in path.resolve().parents:
                raise ValueError("Invalid asset path")
            data = path.read_bytes()
            if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise ValueError("Classifier asset verification failed")
        config = json.loads((models / "config.json").read_text(encoding="utf-8"))
        labels = {name.lower(): int(index) for index, name in config["id2label"].items()}
        self.entailment = labels["entailment"]
        self.tokenizer = Tokenizer.from_file(str(models / "tokenizer.json"))
        self.tokenizer.no_truncation()
        pad_id = int(config["pad_token_id"])
        self.tokenizer.enable_padding(pad_id=pad_id, pad_token=self.tokenizer.id_to_token(pad_id))
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(models / "onnx/model_quint8_avx2.onnx"), options, providers=["CPUExecutionProvider"])
        self.names = {item.name for item in self.session.get_inputs()}
        self.max_tokens = min(int(config.get("max_position_embeddings", 512)), 512)
        self.identity = {"model": manifest["model"], "revision": manifest["revision"], "provider": "CPUExecutionProvider", "threads": threads}

    def classify(self, text, context=""):
        started = time.perf_counter()
        if not isinstance(text, str) or not text.strip() or len(text) > 32000:
            raise ValueError("Invalid utterance")
        # Do not silently discard a trailing condition. Oversize input abstains.
        # Recent conversational context is optional; the current utterance is exact.
        premise = ("Previous conversation: " + context[-1200:] + "\nCurrent speaker: " + text) if context else text
        encoded = self.tokenizer.encode_batch([(premise, hypothesis) for hypothesis in HYPOTHESES.values()])
        if max(len(item.ids) for item in encoded) > self.max_tokens:
            return {"abstained": True, "reason": "input_limit", "elapsedMs": (time.perf_counter() - started) * 1000}
        feeds = {
            "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
            "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
            "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64),
        }
        logits = self.session.run(None, {name: feeds[name] for name in self.names})[0]
        exp = np.exp(logits - np.max(logits, axis=1, keepdims=True))
        probabilities = exp / exp.sum(axis=1, keepdims=True)
        return {"abstained": False, "scores": {name: float(probabilities[i, self.entailment]) for i, name in enumerate(HYPOTHESES)}, "tokens": len(encoded[0].ids), "elapsedMs": (time.perf_counter() - started) * 1000}


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--threads", type=int, default=2, choices=range(1, 5))
    args = parser.parse_args()
    classifier = Classifier(args.models, args.threads)
    classifier.classify("Warm up the local classifier.")
    print(json.dumps({"event": "ready", **classifier.identity}), flush=True)
    for line in sys.stdin:
        if len(line) > 64000:
            raise ValueError("Classifier input limit exceeded")
        request = json.loads(line)
        if request.get("command") == "stop":
            return
        try:
            result = classifier.classify(request.get("text"), request.get("context", ""))
        except (ValueError, KeyError, RuntimeError):
            result = {"abstained": True, "reason": "classification_failed"}
        print(json.dumps({"id": request["id"], **result}), flush=True)


if __name__ == "__main__":
    main()
