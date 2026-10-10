"""Merge reviewed offline prefix annotations, preserving source groups."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--labels', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--prefixes-only', action='store_true')
    parser.add_argument('--review', help='Explicit offline label corrections with exact-text identities')
    parser.add_argument('--validation', help='Exclude exact current-text overlap with validation')
    args = parser.parse_args()
    raw = Path(args.labels).read_bytes()
    data = json.loads(raw)
    assert data['status'] == 'complete'
    review = []
    review_digest = None
    if args.review:
        review_raw = Path(args.review).read_bytes()
        review_digest = hashlib.sha256(review_raw).hexdigest()
        review = json.loads(review_raw)['corrections']
        indexed = {row['id']: row for row in data['cases']}
        assert len({item['id'] for item in review}) == len(review)
        for item in review:
            row = indexed[item['id']]
            assert row['text'] == item['text'], 'Review does not match the annotated input'
            assert item['label'] in ('background', 'unfinished_request', 'ready_request', 'ambiguous')
            row.update(label=item['label'], reason=item['reason'])
    rows = [] if args.prefixes_only else list(data['originalCases'])
    excluded = []
    for row in data['cases']:
        label = row['label']
        if label == 'ambiguous':
            excluded.append(row['id'])
            continue
        assert label in ('background', 'unfinished_request', 'ready_request')
        rows.append({**row, 'request': label != 'background', 'ready': label == 'ready_request'})
    overlaps = 0
    if args.validation:
        validation = json.loads(Path(args.validation).read_text(encoding='utf-8'))
        key = lambda row: ' '.join(row['text'].casefold().split())
        reserved = {key(row) for row in validation['cases']}
        retained = [row for row in rows if key(row) not in reserved]
        overlaps = len(rows)-len(retained)
        rows = retained
    seen = {}
    for row in rows:
        key = (row['text'], row.get('context', ''))
        value = (row['request'], row['ready'])
        if key in seen and seen[key] != value:
            raise ValueError(f'Conflicting source/prefix labels: {row["text"]!r}')
        seen[key] = value
    result = {'scope': 'Offline synthetic supervision, using model annotations of isolated available prefixes. Source and annotation labels require independent review; not human certification. Related prefixes and contrastive variants stay grouped. No runtime examples or routing rules.',
              'source': args.labels, 'sourceSha256': hashlib.sha256(raw).hexdigest(),
              'review': review, 'reviewSha256': review_digest,
              'validationExactTextOverlapsExcluded': overlaps,
              'ambiguousExcluded': excluded, 'prefixesOnly': args.prefixes_only, 'cases': rows}
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'cases': len(rows), 'groups': len({r['sourceGroup'] for r in rows}),
                      'ambiguousExcluded': len(excluded)}))


if __name__ == '__main__':
    main()
