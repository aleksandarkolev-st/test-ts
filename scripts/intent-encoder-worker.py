"""CPU sentence encoder plus supervised intent head; no rules or generation."""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

class Encoder:
    def __init__(self, models, threads=2):
        models = Path(models)
        manifest = json.loads((models / "manifest.json").read_text(encoding="utf-8"))
        for asset in manifest["assets"]:
            path = (models / asset["file"]).resolve()
            if models.resolve() not in path.parents:
                raise ValueError("Invalid asset path")
            data = path.read_bytes()
            if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise ValueError("Encoder asset verification failed")
        config = json.loads((models / "config.json").read_text(encoding="utf-8"))
        self.tokenizer = Tokenizer.from_file(str(models / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.enable_padding(pad_id=config["pad_token_id"])
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(models / "onnx/model_quint8_avx2.onnx"), options, providers=["CPUExecutionProvider"])
        self.names = {item.name for item in self.session.get_inputs()}
        self.identity = {"model": manifest["model"], "revision": manifest["revision"], "provider": "CPUExecutionProvider", "threads": threads}

    def features(self, text, context="", lexical=False):
        if not isinstance(text, str) or not text.strip() or len(text) > 32000 or not isinstance(context, str):
            raise ValueError("Invalid utterance")
        encoded = self.tokenizer.encode_batch([text, context[-1200:] or " "])
        # Publisher trained this encoder on <=256 tokens. Abstain on the current
        # utterance rather than truncating away an important trailing condition.
        if max(len(item.ids) for item in encoded) > 256:
            raise ValueError("input_limit")
        feeds = {"input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64), "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64), "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64)}
        hidden = self.session.run(None, {name: feeds[name] for name in self.names})[0]
        mask = feeds["attention_mask"][..., None]
        pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1)
        pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
        # Learn completion from contextual token representations as well as the
        # semantic embedding. No punctuation/word/domain allowlists are used.
        last = hidden[0, sum(encoded[0].attention_mask)-2]
        last /= max(float(np.linalg.norm(last)), 1e-12)
        context_feature = pooled[1] if context.strip() else np.zeros_like(pooled[1])
        feature = np.concatenate([pooled[0], last, context_feature])
        if lexical:
            # Generic learned sequence features retain grammar that mean pooling
            # loses. No word list, phrase rule, or class-specific feature exists.
            tokens = encoded[0].tokens[1:sum(encoded[0].attention_mask)-1]
            hashed = np.zeros(2048, dtype=np.float32)
            for width in (1, 2, 3):
                for position in range(len(tokens)-width+1):
                    gram = "\0".join(tokens[position:position+width])
                    for kind in ["any"] + (["start"] if position==0 else []) + (["end"] if position+width==len(tokens) else []):
                        digest = hashlib.blake2b((kind+"\0"+gram).encode("utf-8"), digest_size=4).digest()
                        hashed[int.from_bytes(digest,"little") % len(hashed)] += 1
            hashed /= max(float(np.linalg.norm(hashed)), 1e-12)
            feature = np.concatenate([feature, hashed])
        return feature, sum(encoded[0].attention_mask)

class Classifier:
    def __init__(self, models, profile, threads=2):
        self.encoder = Encoder(models, threads)
        data = Path(profile).read_bytes()
        head = json.loads(data)
        self.lexical = head["featureSchema"] == "mean-last-context-sequence-untruncated-v1"
        if head["encoder"] != self.encoder.identity["revision"] or head["featureSchema"] not in ("mean-last-context-untruncated-v1", "mean-last-context-sequence-untruncated-v1"):
            raise ValueError("Classifier profile does not match encoder")
        self.weights = np.asarray(head["weights"], dtype=np.float32)
        self.bias = np.asarray(head["bias"], dtype=np.float32)
        if self.weights.shape != (3200 if self.lexical else 1152, 3) or self.bias.shape != (3,) or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all():
            raise ValueError("Invalid classifier weights")
        self.identity = {**self.encoder.identity, "profileSha256": hashlib.sha256(data).hexdigest()}
    def classify(self, text, context=""):
        started = time.perf_counter()
        try:
            features, tokens = self.encoder.features(text, context, self.lexical)
            logits = features @ self.weights + self.bias
            exp = np.exp(logits - logits.max())
            probability = exp / exp.sum()
            return {"abstained": False, "scores": {"request": float(1-probability[0]), "background": float(probability[0]), "ready": float(probability[2]), "unfinished": float(probability[1])}, "tokens": tokens, "elapsedMs": (time.perf_counter()-started)*1000}
        except (ValueError, RuntimeError):
            return {"abstained": True, "reason": "input_limit_or_failure", "elapsedMs": (time.perf_counter()-started)*1000}

def main():
    # Rust writes UTF-8 NDJSON; Windows locale encodings must not reinterpret
    # exact identifiers, math, or the previous answer's Unicode punctuation.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    model = Classifier(args.models, args.profile)
    model.classify("Warm up the local classifier.")
    print(json.dumps({"event":"ready", **model.identity}), flush=True)
    for line in sys.stdin:
        if len(line) > 64000:
            return
        request = json.loads(line)
        if request.get("command") == "stop":
            return
        print(json.dumps({"id":request["id"], **model.classify(request.get("text"), request.get("context", ""))}), flush=True)

if __name__ == "__main__":
    main()
