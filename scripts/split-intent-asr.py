"""Group-isolated ASR training assembly; fresh evaluation never selects a model."""
import argparse
import hashlib
import json
from pathlib import Path


def assemble(prefixes, base, development, group_roles):
    assert all(role in ('training', 'validation') for role in group_roles.values())
    key = lambda row: ' '.join(row['text'].casefold().split())
    development_groups = {row['sourceGroup'] for row in development['cases']}
    base_groups = {row['sourceGroup'] for row in base['cases']}
    evaluation_groups = {group for group, role in group_roles.items() if role == 'validation'}
    training_groups = {group for group, role in group_roles.items() if role == 'training'}
    assert training_groups and evaluation_groups
    assert not (training_groups | evaluation_groups) & (development_groups | base_groups)
    assert not base_groups & development_groups
    training, evaluation = [], []
    for row in prefixes['cases']:
        assert isinstance(row['request'], bool) and isinstance(row['ready'], bool)
        assert not row['ready'] or row['request']
        group = row['sourceGroup']
        assert group in group_roles, 'Unrecognized source group'
        (training if group_roles[group] == 'training' else evaluation).append(row)
    assert training and evaluation
    reserved = {key(row) for row in development['cases'] + evaluation}
    combined = base['cases'] + training
    retained = [row for row in combined if key(row) not in reserved]
    assert retained
    assert not {key(row) for row in retained} & reserved
    scope = ('Offline isolated ASR supervision. Fresh evaluation groups are excluded '
             'from training and from epoch, temperature, threshold and runtime-policy '
             'selection. Synthetic model annotations require review; not human '
             'certification or a production promotion.')
    return {
        'training': {'scope': scope, 'cases': retained},
        'evaluation': {'scope': scope, 'cases': evaluation},
        'audit': {'scope': scope, 'freshTrainingVariants': len(training),
                  'freshEvaluationVariants': len(evaluation),
                  'exactTextOverlapsExcludedFromTraining': len(combined)-len(retained),
                  'freshTrainingGroups': sorted(training_groups),
                  'freshEvaluationGroups': sorted(evaluation_groups)},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prefixes', required=True, help='Reviewed supervised prefixes')
    parser.add_argument('--sources', required=True, help='Frozen source identities and roles')
    parser.add_argument('--base', required=True)
    parser.add_argument('--development', required=True, help='Existing epoch/temperature selection data')
    parser.add_argument('--output', required=True, help='New workspace directory')
    args = parser.parse_args()
    identity = {}
    def read(name, file):
        raw = Path(file).read_bytes()
        identity[name] = {'file': file, 'sha256': hashlib.sha256(raw).hexdigest()}
        return json.loads(raw)
    sources = read('sources', args.sources)
    roles = {}
    for source in sources['sources']:
        assert source['role'] in ('training', 'validation')
        raw = Path(source['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == source['sha256']
        data = json.loads(raw)
        for index, row in enumerate(data['cases']):
            group = row.get('sourceGroup')
            if group is None:
                suffix = f"episode:{row['episode']}" if 'episode' in row else f"case:{row.get('sourceCase', index)}"
                group = f"{source['sha256']}:{suffix}"
            assert roles.get(group, source['role']) == source['role'], 'Related source groups cross roles'
            roles[group] = source['role']
    result = assemble(read('prefixes', args.prefixes), read('base', args.base),
                      read('development', args.development), roles)
    target = Path(args.output).resolve()
    assert Path.cwd().resolve() in target.parents
    target.mkdir(parents=True, exist_ok=False)
    for name, data in result.items():
        data['inputs'] = identity
        (target / f'{name}.json').write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result['audit']))


if __name__ == '__main__':
    main()
