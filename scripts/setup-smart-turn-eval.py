"""Fetch pinned, public evaluation assets; never downloads executable pickle files."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / ".local" / "smart-turn-3.2"
HF_REV = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93"
SOURCE_REV = "74cc42dd0a587082e8176c21e997794905599374"
MODEL_SHA = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"
ASSETS = {
    "smart-turn-v3.2-cpu.onnx": f"https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/{HF_REV}/smart-turn-v3.2-cpu.onnx",
    "_whisper_features.py": f"https://raw.githubusercontent.com/pipecat-ai/pipecat/{SOURCE_REV}/src/pipecat/audio/turn/smart_turn/_whisper_features.py",
    "LICENSE": f"https://raw.githubusercontent.com/pipecat-ai/pipecat/{SOURCE_REV}/LICENSE",
}

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    records = []
    for name, url in ASSETS.items():
        target = DEST / name
        if target.exists():
            data = target.read_bytes()
        else:
            with urllib.request.urlopen(url, timeout=45) as response:
                data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError("Evaluation asset exceeds its size limit")
        digest = hashlib.sha256(data).hexdigest()
        if name.endswith(".onnx") and digest != MODEL_SHA:
            raise ValueError("Model checksum differs from the publisher's pinned file")
        target.write_bytes(data)
        records.append({"file": name, "url": url, "bytes": len(data), "sha256": digest})
        print(f"Verified {name}: {len(data)} bytes", flush=True)
    (DEST / "sources.json").write_text(json.dumps(records, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
