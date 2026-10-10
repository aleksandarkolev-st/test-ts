"""Prepare recorded-speech inputs from offline episodes without inheriting labels."""
import argparse
import hashlib
import json
from pathlib import Path


def inputs(sources):
    utterances, metadata = [], []
    for source in sources:
        raw = source.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        data = json.loads(raw)
        assert data['cases'], 'Empty source corpus'
        for index, row in enumerate(data['cases']):
            assert isinstance(row['text'], str) and row['text'].strip()
            assert isinstance(row.get('context', ''), str)
            group = row.get('sourceGroup')
            if group is None:
                key = f"episode:{row['episode']}" if 'episode' in row else f"case:{row.get('sourceCase', index)}"
                group = f'{digest}:{key}'
            assert isinstance(group, str) and group
            identifier = f'{digest[:12]}-{index:04d}'
            utterances.append({'id': identifier, 'wave': f'{identifier}.wav',
                               'sourceGroup': group, 'context': row.get('context', ''), 'text': row['text']})
        metadata.append({'file': str(source), 'sha256': digest, 'cases': len(data['cases']),
                         'role': data.get('role'), 'scope': data.get('scope')})
    assert len({row['id'] for row in utterances}) == len(utterances), 'Duplicate source or identity collision'
    return utterances, metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', action='append', required=True)
    parser.add_argument('--output', required=True, help='New workspace directory')
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--gpu-name')
    parser.add_argument('--chunk-ms', type=int, default=160)
    args = parser.parse_args()
    root = Path.cwd().resolve()
    target = Path(args.output).resolve()
    assert root in target.parents, 'Output must stay in the workspace'
    assert args.chunk_ms in (80, 160, 560, 1120)
    runtime, model = Path(args.runtime).resolve(strict=True), Path(args.model).resolve(strict=True)
    assert runtime.is_file() and model.is_file()
    utterances, metadata = inputs([Path(source).resolve(strict=True) for source in args.source])
    manifest = {'runtime': str(runtime), 'model': str(model), 'gpuName': args.gpu_name,
                'chunkMs': args.chunk_ms, 'utterances': [{k: v for k, v in row.items() if k != 'text'} for row in utterances]}
    target.mkdir(parents=True, exist_ok=False)
    for row in utterances:
        (target / f"{row['id']}.txt").write_text(row['text'], encoding='utf-8')
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    (target / 'sources.json').write_text(json.dumps({'scope': 'Offline speech preparation only. Source labels are not copied to the ASR manifest or fragment annotations. Related variants retain their source groups.',
                                                    'sources': metadata}, indent=2), encoding='utf-8')
    print(json.dumps({'utterances': len(utterances), 'sourceGroups': len({row['sourceGroup'] for row in utterances}),
                      'output': str(target)}))


if __name__ == '__main__':
    main()
