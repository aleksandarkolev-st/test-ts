"""Download pinned data-only CPU classifier assets for local evaluation."""
import hashlib
import argparse
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / ".local" / "intent-model"
MODEL = "cross-encoder/nli-MiniLM2-L6-H768"
REVISION = "b95119ce93d3e065de6214e38cd4a97b0f2f2c6d"
ASSETS = {
    "onnx/model_quint8_avx2.onnx": (82823063, "44391a5241a62e0083c1a8899a71e69a092b95aea5ba89e14062925468eceac7", "sha256"),
    "tokenizer.json": (1356048, "8df0092a08e1d459f60ec541e08cd35a16362bfe", "git"),
    "config.json": (875, "f3d2c8b047a34c20737866987ba16ea6114c7b53", "git"),
    "README.md": (2695, "c424f2537691c27718354d28794160ba0c6175ec", "git"),
}


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--encoder", action="store_true")
    mode.add_argument("--training", action="store_true")
    args = parser.parse_args()
    dest, model, revision, assets = DEST, MODEL, REVISION, ASSETS
    if args.encoder or args.training:
        dest = ROOT / ".local" / "intent-encoder"
        model = "sentence-transformers/all-MiniLM-L6-v2"
        revision = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
        assets = {
            "onnx/model_quint8_avx2.onnx": (23046789, "b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21", "sha256"),
            "tokenizer.json": (466247, "cb202bfe2e3c98645018a6d12f182a434c9d3e02", "git"),
            "config.json": (612, "72b987fd805cfa2b58c4c8c952b274a11bfd5a00", "git"),
            "README.md": (10502, "44af2e3b0fa3a0b6239e48422972bf755f28fde0", "git"),
        }
        if args.training:
            dest = ROOT / ".local" / "intent-training-model"
            assets.pop("onnx/model_quint8_avx2.onnx")
            assets["model.safetensors"] = (90868376, "53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db", "sha256")
    records = []
    for name, (size, expected, kind) in assets.items():
        target = dest / name
        if target.exists():
            data = target.read_bytes()
        else:
            url = f"https://huggingface.co/{model}/resolve/{revision}/{name}"
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read(size + 1)
        if len(data) != size:
            raise ValueError(f"Wrong asset size: {name}")
        digest = hashlib.sha256(data).hexdigest()
        identity = digest if kind == "sha256" else hashlib.sha1(f"blob {size}\0".encode() + data).hexdigest()
        if identity != expected:
            raise ValueError(f"Pinned asset identity mismatch: {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records.append({"file": name, "bytes": size, "sha256": digest})
        print(f"Verified {name}: {size} bytes", flush=True)
    (dest / "manifest.json").write_text(json.dumps({"model": model, "revision": revision, "license": "Apache-2.0", "assets": records}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
