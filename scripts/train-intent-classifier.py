"""Train a regularized learned head; validation selects parameters, not test data."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np

def load(path):
    spec = importlib.util.spec_from_file_location("encoder", Path(__file__).with_name("intent-encoder-worker.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Encoder(path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default=".local/intent-encoder")
    parser.add_argument("--train", default="artifacts/intent-classifier/generated-training.json")
    parser.add_argument("--validation", default="artifacts/intent-classifier/generated-validation.json")
    parser.add_argument("--output", default=".local/intent-encoder/profile.json")
    parser.add_argument("--lexical", action="store_true")
    args = parser.parse_args()
    encoder = load(args.models)
    training = json.loads(Path(args.train).read_text(encoding="utf-8"))["cases"]
    validation = json.loads(Path(args.validation).read_text(encoding="utf-8"))["cases"]
    assert not {row["text"] for row in training} & {row["text"] for row in validation}, "Training/validation overlap"
    def vectorize(rows):
        x = np.asarray([encoder.features(row["text"], row.get("context", ""), args.lexical)[0] for row in rows])
        y = np.asarray([2 if row["ready"] else 1 if row["request"] else 0 for row in rows])
        return x, y
    x, y = vectorize(training)
    vx, vy = vectorize(validation)
    def softmax(logits):
        exp = np.exp(logits - logits.max(axis=1, keepdims=True))
        return exp / exp.sum(axis=1, keepdims=True)
    candidates = []
    for regularization in [0.001, 0.01, 0.1, 1.0]:
        weights = np.zeros((x.shape[1], 3))
        bias = np.zeros(3)
        targets = np.eye(3)[y]
        for _ in range(2500):
            difference = (softmax(x@weights+bias)-targets)/len(y)
            weights -= 0.5*(x.T@difference+regularization*weights)
            bias -= 0.5*difference.sum(axis=0)
        probability = softmax(vx@weights+bias)
        loss = float(-np.log(np.maximum(probability[np.arange(len(vy)), vy], 1e-9)).mean())
        candidates.append((loss, regularization, weights, bias, probability))
    loss, regularization, weights, bias, probability = min(candidates, key=lambda item:item[0])
    result = {"encoder": encoder.identity["revision"], "featureSchema":"mean-last-context-untruncated-v1", "classes":["background","unfinished_request","ready_request"], "weights":weights.tolist(), "bias":bias.tolist(), "regularization":regularization, "validationLoss":loss, "trainingSha256":hashlib.sha256(Path(args.train).read_bytes()).hexdigest(), "validationSha256":hashlib.sha256(Path(args.validation).read_bytes()).hexdigest(), "trainingCount":len(y), "validationCount":len(vy), "scope":"Synthetic model-labeled training; not human accuracy certification. Learned weights only, no training examples in production."}
    if args.lexical:
        result["featureSchema"]="mean-last-context-sequence-untruncated-v1"
    Path(args.output).write_text(json.dumps(result), encoding="utf-8")
    print(json.dumps({"profile":args.output, "validationLoss":loss, "regularization":regularization, "accuracy":float((probability.argmax(axis=1)==vy).mean())}), flush=True)

if __name__ == "__main__":
    main()
