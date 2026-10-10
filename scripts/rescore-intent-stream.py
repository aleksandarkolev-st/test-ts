"""Offline exact-input parity and context ablation; no labels or routing rules."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--models', default='.local/intent-encoder')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raw = Path(args.audit).read_bytes()
    audit = json.loads(raw)
    profile = Path(args.profile)
    assert hashlib.sha256(profile.read_bytes()).hexdigest() == audit['classifier']['profileSha256']
    spec = importlib.util.spec_from_file_location('intent_worker', Path(__file__).with_name('intent-encoder-worker.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.Classifier(args.models, profile)
    model.classify('Warm up the classifier.')
    threshold = audit['classifier']['threshold']
    rows = []
    differences = []
    for round_ in audit['rounds']:
        for entry in round_['entries']:
            if entry.get('missingSubmission'):
                continue
            exact = model.classify(entry['text'], entry['context'])
            empty = model.classify(entry['text'], '')
            assert exact['abstained'] == entry['abstained']
            if not exact['abstained']:
                difference = max(abs(exact['scores'][key] - entry['scores'][key]) for key in ('request', 'ready'))
                assert difference <= 1e-4, f"Exact-input score mismatch: {entry['id']}, {difference}"
                differences.append(difference)

            def ready(result):
                return not result['abstained'] and all(result['scores'][key] >= threshold for key in ('request', 'ready'))

            rows.append({'round': round_['round'], **entry, 'exactReplay': exact, 'emptyContext': empty,
                         'readyWithExactContext': ready(exact), 'readyWithEmptyContext': ready(empty)})
    assert rows
    summary = {'inputs': len(rows), 'exactParityMaxScoreDifference': max(differences, default=0),
               'readyWithExactContext': sum(row['readyWithExactContext'] for row in rows),
               'readyWithEmptyContext': sum(row['readyWithEmptyContext'] for row in rows),
               'contextRaisedAboveThreshold': sum(row['readyWithExactContext'] and not row['readyWithEmptyContext'] for row in rows),
               'contextLoweredBelowThreshold': sum(not row['readyWithExactContext'] and row['readyWithEmptyContext'] for row in rows)}
    result = {'scope': 'Exact native classifier-input replay and removal-of-context ablation. No semantic ground truth is assigned. Threshold crossings do not establish correct readiness, safe early display or an improvement from removing context. Correlated inputs from each utterance are not independent samples.',
              'sourceAuditSha256': hashlib.sha256(raw).hexdigest(), 'identity': model.identity,
              'threshold': threshold, 'summary': summary, 'rows': rows}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
