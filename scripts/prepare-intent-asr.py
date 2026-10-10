"""Select isolated observed ASR candidates for offline prefix annotation."""
import argparse
import hashlib
import json
import random
from pathlib import Path


def prepare(raw, per_utterance, spacing_ms, seed):
    records = [json.loads(line) for line in raw.decode('utf-8-sig').splitlines() if line]
    assert records[0]['type'] == 'capture.started' and records[0]['schemaVersion'] == 1
    assert records[-1]['type'] == 'capture.finished' and records[-1]['complete'] is True
    utterances, active = {}, None
    for row in records[1:-1]:
        kind = row['type']
        if kind == 'utterance.started':
            assert active is None and row['id'] not in utterances
            assert row['sourceGroup'] and isinstance(row['context'], str)
            active = row['id']
            utterances[active] = {'metadata': row, 'candidates': []}
        elif kind in ('candidate', 'event', 'audio.finished', 'utterance.finished'):
            assert active == row['id'], 'Events must belong to the currently open utterance'
            if kind == 'candidate' and row['text']:
                assert isinstance(row['text'], str) and isinstance(row['observedAtMs'], int)
                utterances[active]['candidates'].append(row)
            elif kind == 'utterance.finished':
                assert row['complete'] is True and row['lastSpeechEndMs'] is not None
                assert row['lastFinalEndMs'] >= row['lastSpeechEndMs']
                active = None
        else:
            assert kind == 'device.selected', f'Unexpected record type: {kind}'
    assert active is None and len(utterances) == records[0]['utteranceCount']
    rng, cases = random.Random(seed), []
    for identifier, utterance in utterances.items():
        metadata = utterance['metadata']
        eligible, seen = [], set()
        for candidate in utterance['candidates']:
            if candidate['text'] in seen:
                continue
            seen.add(candidate['text'])
            if eligible and candidate['observedAtMs'] - eligible[-1]['observedAtMs'] < spacing_ms:
                continue
            eligible.append(candidate)
        assert eligible, f'No nonempty candidates captured for {identifier}'
        # Sample for offline supervision; this never changes live cadence.
        selected = rng.sample(eligible, min(per_utterance, len(eligible)))
        for candidate in sorted(selected, key=lambda item: item['observedAtMs']):
            cases.append({'id': len(cases), 'text': candidate['text'], 'context': metadata['context'],
                          'sourceGroup': metadata['sourceGroup'], 'sourceUtterance': identifier,
                          'waveSha256': metadata['waveSha256'], 'observedAtMs': candidate['observedAtMs'],
                          'floor': candidate['floor'], 'remoteQuiet': candidate['remoteQuiet'],
                          'remoteSpeaking': candidate['remoteSpeaking']})
    return {'scope': 'Unlabeled real Nemotron fragments of recorded speech. Offline data only, not answer latency or full application-state parity. Labels must see only the selected current words and previous context. Never inherit source utterance intent, completion, future words or answer text. Related variants retain caller-supplied source groups across train/validation splits.',
            'sourceSha256': hashlib.sha256(raw).hexdigest(), 'seed': seed,
            'perUtterance': per_utterance, 'minimumObservationSpacingMs': spacing_ms,
            'originalCases': [], 'cases': cases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capture', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--per-utterance', type=int, default=4)
    parser.add_argument('--spacing-ms', type=int, default=250)
    parser.add_argument('--seed', type=int, default=61)
    args = parser.parse_args()
    assert args.per_utterance > 0 and args.spacing_ms >= 0
    result = prepare(Path(args.capture).read_bytes(), args.per_utterance, args.spacing_ms, args.seed)
    result['source'] = args.capture
    with Path(args.output).open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2, ensure_ascii=False)
    print(json.dumps({'cases': len(result['cases']),
                      'groups': len({row['sourceGroup'] for row in result['cases']})}))


if __name__ == '__main__':
    main()
