"""Offline role-label ablation using verified remote-only transcript provenance."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--interview', required=True)
    parser.add_argument('--audit', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    interview_raw = Path(args.interview).read_bytes()
    interview = json.loads(interview_raw)
    audit_raw = Path(args.audit).read_bytes()
    audit = json.loads(audit_raw)
    assert interview['status'] == 'complete' and interview['stoppedCleanly']
    assert interview['speechConfiguration']['remoteOnly'], 'Cannot infer transcript speakers from a mixed-source run'
    assert hashlib.sha256(interview_raw).hexdigest() == audit['source']['sha256']
    assert hashlib.sha256(Path(args.profile).read_bytes()).hexdigest() == audit['classifier']['profileSha256']
    spec = importlib.util.spec_from_file_location('intent_worker', Path(__file__).with_name('intent-encoder-worker.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.Classifier('.local/intent-encoder', args.profile)
    model.classify('Warm up the classifier.')
    threshold = audit['classifier']['threshold']
    rows = []
    skipped = []
    for round_ in audit['rounds']:
        # The bootstrap answer is not saved as an interview row; never guess it.
        if round_['round'] == 1:
            skipped.append({'round': 1, 'reason': 'No saved bootstrap-answer provenance'})
            continue
        previous = interview['rows'][round_['round']-2]['answer'][-600:]
        assert previous
        for entry in round_['entries']:
            if entry.get('missingSubmission'):
                continue
            context = entry['context']
            assert context.endswith(previous), 'Prior-answer suffix does not match native context'
            history = context[:-len(previous)].rstrip('\n')
            labeled = '\n'.join([*(f'User: {line}' for line in history.split('\n') if line), f'Assistant: {previous}'])[-1200:]
            exact = model.classify(entry['text'], context)
            changed = model.classify(entry['text'], labeled)
            assert exact['abstained'] == entry['abstained']
            if not exact['abstained']:
                assert max(abs(exact['scores'][key]-entry['scores'][key]) for key in ('request', 'ready')) <= 1e-4
            ready = lambda result: not result['abstained'] and all(result['scores'][key] >= threshold for key in ('request', 'ready'))
            rows.append({**entry, 'round': round_['round'], 'labeledContext': labeled, 'labeledResult': changed,
                         'originalAboveThreshold': ready(exact), 'labeledAboveThreshold': ready(changed)})
    result = {'scope': 'Diagnostic role-label ablation, not production promotion or semantic labels. Remote-only capture proves all retained transcript fragments are remote; the prior assistant-answer suffix is checked against the saved answer. Bootstrap provenance is unavailable and is excluded. New labels can change history token retention. Correlated samples are not independent observations.',
              'interviewSha256': hashlib.sha256(interview_raw).hexdigest(), 'auditSha256': hashlib.sha256(audit_raw).hexdigest(),
              'identity': model.identity, 'threshold': threshold, 'skipped': skipped,
              'summary': {'inputs': len(rows), 'originalAboveThreshold': sum(row['originalAboveThreshold'] for row in rows),
                          'labeledAboveThreshold': sum(row['labeledAboveThreshold'] for row in rows),
                          'exactFinalOriginalAboveThreshold': sum(row['exactFinalRecognizedText'] and row['originalAboveThreshold'] for row in rows),
                          'exactFinalLabeledAboveThreshold': sum(row['exactFinalRecognizedText'] and row['labeledAboveThreshold'] for row in rows)},
              'rows': rows}
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result['summary']), flush=True)


if __name__ == '__main__':
    main()
