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
from intent_tokens import joint_inputs

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

    def features(self, text, context="", lexical=False, joint=False):
        if not isinstance(text, str) or not text.strip() or len(text) > 32000 or not isinstance(context, str):
            raise ValueError("Invalid utterance")
        if joint:
            # One attention pass learns the relationship between the utterance
            # and conversation, instead of adding two independent embeddings.
            # Only classifier history is bounded; current words are never cut.
            current = self.tokenizer.encode(text, add_special_tokens=False)
            if not current.ids or len(current.ids) > 254:
                raise ValueError("input_limit")
            previous = self.tokenizer.encode(context[-1200:], add_special_tokens=False)
            budget = 253-len(current.ids)
            history = previous.ids[-budget:] if budget>0 else []
            cls = self.tokenizer.token_to_id("[CLS]")
            sep = self.tokenizer.token_to_id("[SEP]")
            if cls is None or sep is None:
                raise ValueError("Unsupported encoder tokenizer")
            if history:
                ids = [cls]+history+[sep]+current.ids+[sep]
                split = len(history)+2
                types = [0]*split+[1]*(len(current.ids)+1)
            else:
                ids = [cls]+current.ids+[sep]
                split = 1
                types = [0]*len(ids)
            feeds = {"input_ids":np.asarray([ids],dtype=np.int64),
                "attention_mask":np.ones((1,len(ids)),dtype=np.int64),
                "token_type_ids":np.asarray([types],dtype=np.int64)}
            hidden = self.session.run(None,{name:feeds[name] for name in self.names})[0][0]
            def unit(vector):
                return vector/max(float(np.linalg.norm(vector)),1e-12)
            current_mean = unit(hidden[split:-1].mean(axis=0))
            last = unit(hidden[-2])
            context_mean = unit(hidden[1:split-1].mean(axis=0)) if history else np.zeros_like(last)
            return np.concatenate([current_mean,last,context_mean]),len(current.ids)+2
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

class FineTunedClassifier:
    def __init__(self,models,head,digest,threads):
        root=Path(models).resolve()
        manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
        if head['encoder']!=manifest['revision']:
            raise ValueError('Fine-tuned model does not match tokenizer revision')
        records=[next(asset for asset in manifest['assets'] if asset['file']=='tokenizer.json'),head['trainedModel']]
        for asset in records:
            path=(root/asset['file']).resolve()
            if root not in path.parents:
                raise ValueError('Invalid fine-tuned asset path')
            raw=path.read_bytes()
            if len(raw)!=asset['bytes'] or hashlib.sha256(raw).hexdigest()!=asset['sha256']:
                raise ValueError('Fine-tuned asset verification failed')
        self.temperature=float(head['temperature'])
        if not np.isfinite(self.temperature) or not 0.01<=self.temperature<=100:
            raise ValueError('Invalid classifier temperature')
        self.tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'))
        self.tokenizer.no_truncation();self.tokenizer.no_padding()
        options=ort.SessionOptions();options.intra_op_num_threads=threads;options.inter_op_num_threads=1
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        self.session=ort.InferenceSession(str(root/head['trainedModel']['file']),options,providers=['CPUExecutionProvider'])
        if {item.name for item in self.session.get_inputs()}!={'input_ids','attention_mask','token_type_ids','current_mask'}:
            raise ValueError('Invalid fine-tuned input contract')
        self.identity={'model':manifest['model'],'revision':manifest['revision'],'provider':'CPUExecutionProvider',
            'threads':threads,'profileSha256':digest,'trainedModelSha256':head['trainedModel']['sha256']}

    def classify(self,text,context=''):
        started=time.perf_counter()
        try:
            inputs=joint_inputs(self.tokenizer,text,context)
            logits=self.session.run(None,inputs)[0]
            if logits.shape!=(1,3) or not np.isfinite(logits).all():
                raise ValueError('Invalid classifier logits')
            logits=logits[0]/self.temperature
            exp=np.exp(logits-logits.max());probability=exp/exp.sum()
            return {'abstained':False,'scores':{'request':float(1-probability[0]),'background':float(probability[0]),
                'ready':float(probability[2]),'unfinished':float(probability[1])},
                'tokens':int(inputs['current_mask'].sum())+2,'elapsedMs':(time.perf_counter()-started)*1000}
        except (ValueError,RuntimeError):
            return {'abstained':True,'reason':'input_limit_or_failure','elapsedMs':(time.perf_counter()-started)*1000}

class Classifier:
    def __init__(self, models, profile, threads=2):
        data = Path(profile).read_bytes()
        head = json.loads(data)
        if head['classes']!=['background','unfinished_request','ready_request']:
            raise ValueError('Classifier profile class order is invalid')
        self.tuned=None
        if head['featureSchema']=='finetuned-joint-readiness-v1':
            self.tuned=FineTunedClassifier(models,head,hashlib.sha256(data).hexdigest(),threads)
            self.identity=self.tuned.identity
            return
        self.encoder = Encoder(models, threads)
        self.lexical = head["featureSchema"] == "mean-last-context-sequence-untruncated-v1"
        self.joint = head["featureSchema"] == "joint-current-last-context-untruncated-v1"
        if head["encoder"] != self.encoder.identity["revision"] or head["featureSchema"] not in ("mean-last-context-untruncated-v1", "mean-last-context-sequence-untruncated-v1", "joint-current-last-context-untruncated-v1"):
            raise ValueError("Classifier profile does not match encoder")
        if head["classes"] != ["background","unfinished_request","ready_request"]:
            raise ValueError("Classifier profile class order is invalid")
        self.weights = np.asarray(head["weights"], dtype=np.float32)
        self.bias = np.asarray(head["bias"], dtype=np.float32)
        width = 3200 if self.lexical else 1152
        self.hidden = None
        if head.get("headKind","linear") == "mlp-tanh-v1":
            self.hidden = np.asarray(head["hiddenWeights"],dtype=np.float32)
            self.hidden_bias = np.asarray(head["hiddenBias"],dtype=np.float32)
            self.mean = np.asarray(head["featureMean"],dtype=np.float32)
            self.scale = np.asarray(head["featureScale"],dtype=np.float32)
            if self.hidden.ndim!=2 or self.hidden.shape[0]!=width or not 1<=self.hidden.shape[1]<=256:
                raise ValueError("Invalid hidden classifier dimensions")
            if self.mean.shape!=(width,) or self.scale.shape!=(width,) or self.hidden_bias.shape!=(self.hidden.shape[1],):
                raise ValueError("Invalid classifier normalization")
            if not all(np.isfinite(item).all() for item in [self.hidden,self.hidden_bias,self.mean,self.scale]) or not (self.scale>0).all():
                raise ValueError("Invalid hidden classifier weights")
            width = self.hidden.shape[1]
        elif head.get("headKind","linear") != "linear":
            raise ValueError("Unknown classifier head")
        if self.weights.shape != (width, 3) or self.bias.shape != (3,) or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all():
            raise ValueError("Invalid classifier weights")
        self.identity = {**self.encoder.identity, "profileSha256": hashlib.sha256(data).hexdigest()}
    def classify(self, text, context=""):
        if self.tuned is not None:
            return self.tuned.classify(text,context)
        started = time.perf_counter()
        try:
            features, tokens = self.encoder.features(text, context, self.lexical, self.joint)
            if self.hidden is not None:
                features = np.tanh(((features-self.mean)/self.scale)@self.hidden+self.hidden_bias)
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
