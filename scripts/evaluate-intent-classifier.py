"""Measure a learned classifier; regression data is never production routing."""
import argparse
import importlib.util
import json
import statistics
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default=".local/intent-model")
    parser.add_argument("--cases", default="tests/fixtures/intent-gate-cases.json")
    parser.add_argument("--output", default="artifacts/intent-classifier/nli-probe.json")
    parser.add_argument("--profile")
    args = parser.parse_args()
    script = "intent-encoder-worker.py" if args.profile else "intent-classifier-worker.py"
    spec = importlib.util.spec_from_file_location("intent_worker", Path(__file__).with_name(script))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.Classifier(args.models, args.profile) if args.profile else module.Classifier(args.models)
    model.classify("Warm up the local classifier.")
    suite = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    rows = [{**case, **model.classify(case["text"], case.get("context", ""))} for case in suite["cases"]]
    durations = sorted(row["elapsedMs"] for row in rows)
    thresholds = []
    for threshold in [0.5, 0.7, 0.8, 0.9, 0.95]:
        selected = [row for row in rows if not row["abstained"] and row["scores"]["request"] >= threshold and row["scores"]["ready"] >= threshold]
        thresholds.append({"threshold": threshold, "selected": len(selected), "falseEarly": sum(not row["request"] or not row["ready"] for row in selected), "missedReadyRequests": sum(row["request"] and row["ready"] and row not in selected for row in rows)})
    report = {"scope": suite["scope"], "identity": model.identity, "rows": rows, "thresholds": thresholds, "latencyMs": {"median": statistics.median(durations), "p95": durations[int((len(durations)-1)*.95)], "max": max(durations)}}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"latencyMs": report["latencyMs"], "thresholds": thresholds}), flush=True)

if __name__ == "__main__":
    main()
