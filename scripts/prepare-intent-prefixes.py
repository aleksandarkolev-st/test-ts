"""Prepare unlabeled, grouped character prefixes for offline supervision."""
import argparse
import hashlib
import json
import random
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--groups', type=int, default=60)
    parser.add_argument('--seed', type=int, default=57)
    args = parser.parse_args()
    raw = Path(args.source).read_bytes()
    source = json.loads(raw)
    digest = hashlib.sha256(raw).hexdigest()
    grouped = {}
    originals = []
    for index, row in enumerate(source['cases']):
        # Related contrastive episodes and punctuation variants stay together.
        key = f"episode:{row['episode']}" if 'episode' in row else f"case:{row.get('sourceCase', index)}"
        group = f'{digest}:{key}'
        item = {**row, 'sourceGroup': group}
        originals.append(item)
        grouped.setdefault(group, []).append(item)
    assert 1 <= args.groups <= len(grouped)
    rng = random.Random(args.seed)
    selected = rng.sample(sorted(grouped), args.groups)
    cases = []
    for group in selected:
        # Use one source variant, without relying on its intent label.
        row = rng.choice(grouped[group])
        text = row['text'].rstrip()
        if len(text) < 4:
            continue
        cuts = rng.sample(range(1, len(text)), min(2, len(text)-1))
        for cut in sorted(cuts):
            prefix = text[:cut].rstrip()
            if not prefix:
                continue
            cases.append({'id': len(cases), 'text': prefix, 'context': row.get('context', ''),
                          'sourceGroup': group, 'cutCharacters': cut,
                          'cutWithinWord': not text[cut-1].isspace() and not text[cut].isspace()})
    result = {'scope': 'Unlabeled synthetic character prefixes. No intent labels are inherited from future words. Labeling must see only each current prefix and previous context. Related variants require grouped splits. Never production routing.',
              'source': args.source, 'sourceSha256': digest, 'seed': args.seed,
              'selectedGroups': len(selected), 'originalCases': originals, 'cases': cases}
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'prefixes': len(cases), 'sourceGroups': len(selected),
                      'midWordCuts': sum(row['cutWithinWord'] for row in cases)}))


if __name__ == '__main__':
    main()
