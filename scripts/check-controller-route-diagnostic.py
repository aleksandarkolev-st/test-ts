"""Finite diagnostic of an unchanged recorded algorithm under a declared interface.

This does not repair/rename the function or normalize its returned statuses.
The oracle's expected labels are supplied by the diagnostic specification.
Original required-interface failures remain in the separate strict checker.
Run after captures and compilation queues, before subsequent live inference.
"""
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import random
import re
import sys


def main():
    journal_path, specification_path, output_path = map(Path, sys.argv[1:4])
    data = journal_path.read_bytes()
    journal = json.loads(data)
    spec = json.loads(specification_path.read_text())
    assert journal['status'] == 'complete' and journal['stoppedCleanly']
    assert spec['journalSha256'] == hashlib.sha256(data).hexdigest()
    oracle_path = Path(__file__).with_name('check-controller-answer-python.py')
    oracle_spec = importlib.util.spec_from_file_location('independent_route_oracle', oracle_path)
    oracle = importlib.util.module_from_spec(oracle_spec)
    oracle_spec.loader.exec_module(oracle)
    output_path.mkdir(parents=True, exist_ok=True)
    results = []
    for item in spec['checks']:
        row = next(r for r in journal['rows'] if r['round'] == item['round'])
        assert hashlib.sha256(row['answer'].encode()).hexdigest() == item['answerSha256']
        labels = item['expectedStatuses']
        assert set(labels) == {'UNREACHABLE', 'FINITE', 'UNBOUNDED'}
        assert len(set(labels.values())) == 3
        result = {'round': row['round'], 'answerSha256': item['answerSha256'],
                  'entryPoint': item['function'], 'expectedStatuses': labels,
                  'strictOriginalInterfaceSuccess': False, 'algorithmRepaired': False}
        results.append(result)
        try:
            code = re.findall(r'```(?:python|py|python3)\s*\n([\s\S]*?)```', row['answer'])[item.get('block', 0)]
            source = output_path / f"round-{row['round']}.py"
            source.write_text(code, encoding='utf-8')
            result['codeSha256'] = hashlib.sha256(code.encode()).hexdigest()
            module_spec = importlib.util.spec_from_file_location(f"recorded_diagnostic_{row['round']}", source)
            module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            function = getattr(module, item['function'])
            failures, count = [], 0

            def check(n, edges, start, target):
                nonlocal count
                status, cost = oracle.route_oracle(n, edges, start, target)
                expected = (labels[status], cost)
                count += 1
                try:
                    actual = function(n, list(edges), start, target)
                    valid = actual == expected and (cost is None or type(actual[1]) is int)
                    if not valid:
                        failures.append({'n': n, 'edges': edges, 's': start, 't': target,
                                         'expected': expected, 'actual': repr(actual)})
                except Exception as error:
                    failures.append({'n': n, 'edges': edges, 's': start, 't': target,
                                     'expected': expected, 'exception': repr(error)})

            positions = [(u, v) for u in range(3) for v in range(3) if u != v]
            for weights in itertools.product([None, -1, 0, 1], repeat=len(positions)):
                edges = [(u, v, w) for (u, v), w in zip(positions, weights) if w is not None]
                for start in range(3):
                    for target in range(3):
                        check(3, edges, start, target)
            rng = random.Random(17739)
            for _ in range(2000):
                n = rng.randrange(1, 5)
                edges = [(rng.randrange(n), rng.randrange(n),
                          rng.choice([-10**12, -1, 0, 1, 10**12]))
                         for _ in range(rng.randrange(11))]
                for start in range(n):
                    for target in range(n):
                        check(n, edges, start, target)
            result.update({'comparisons': count, 'mismatchCount': len(failures),
                           'firstFailures': failures[:12], 'pass': not failures})
        except Exception as error:
            result.update({'pass': False, 'failure': repr(error)})
    report = {'journalSha256': spec['journalSha256'], 'specificationSha256': hashlib.sha256(specification_path.read_bytes()).hexdigest(),
              'graderSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'oracleSha256': hashlib.sha256(oracle_path.read_bytes()).hexdigest(), 'results': results,
              'scope': 'Declared alternate-interface diagnostic only. Source and actual returned values unchanged; only independent expected oracle labels differ from the original strict contract. Exhaustive three-vertex graphs plus seeded multigraph/self-loop/extreme-weight probes supplement the separately reviewed proof. No original interface pass, universal complexity proof, or inference latency claim.'}
    (output_path / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps([{'round': r['round'], 'pass': r['pass'], 'comparisons': r.get('comparisons'),
                       'mismatchCount': r.get('mismatchCount')} for r in results]))


if __name__ == '__main__':
    main()
