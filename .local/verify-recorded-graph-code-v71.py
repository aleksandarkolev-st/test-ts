"""Independent finite-graph oracle; executes an unchanged recorded Python body."""
import ast
import hashlib
import itertools
import json
import pathlib
import random
import runpy
import sys
import time

source, output, seed_text = sys.argv[1:]
source = pathlib.Path(source)
raw = source.read_bytes()
tree = ast.parse(raw, filename=str(source))
entries = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)
           and len(node.args.args) == 4 and not node.args.vararg and not node.args.kwarg]
if len(entries) != 1:
    raise ValueError('Expected one explicitly selected four-argument graph entry point')
namespace = runpy.run_path(str(source), run_name='recorded_graph_oracle')
function = namespace[entries[0]]

def oracle(n, edges):
    # Independent all-pairs algorithm. No Bellman-Ford or retained-edge filter.
    dist = [[None] * n for _ in range(n)]
    for i in range(n):
        dist[i][i] = 0
    for u, v, weight in edges:
        if dist[u][v] is None or weight < dist[u][v]:
            dist[u][v] = weight
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if dist[i][k] is None or dist[k][j] is None:
                    continue
                candidate = dist[i][k] + dist[k][j]
                if dist[i][j] is None or candidate < dist[i][j]:
                    dist[i][j] = candidate
    result = []
    for s in range(n):
        for t in range(n):
            if dist[s][t] is None:
                expected = ('unreachable', None)
            elif any(dist[k][k] < 0 and dist[s][k] is not None and dist[k][t] is not None for k in range(n)):
                expected = ('unbounded', None)
            else:
                expected = ('finite', dist[s][t])
            result.append((s, t, expected))
    return result

started = time.monotonic()
graphs = queries = failures = 0
samples = []
outcomes = {'unreachable': 0, 'finite': 0, 'unbounded': 0}

def check(n, edges, family):
    global graphs, queries, failures
    graphs += 1
    for s, t, expected in oracle(n, edges):
        queries += 1
        outcomes[expected[0]] += 1
        try:
            actual = function(n, list(edges), s, t)
            mismatch = actual != expected
            actual = repr(actual)
        except Exception as error:
            actual = repr(error)
            mismatch = True
        if mismatch:
            failures += 1
            if len(samples) < 12:
                samples.append({'family': family, 'vertices': n, 'edges': edges,
                                'source': s, 'target': t, 'expected': expected, 'actual': actual})

exhaustive = []
for n, alphabet in [(1, (None, -1, 0, 1)), (2, (None, -1, 0, 1)), (3, (None, -1, 1))]:
    positions = list(itertools.product(range(n), repeat=2))
    before_graphs, before_queries = graphs, queries
    for weights in itertools.product(alphabet, repeat=n*n):
        edges = [(u, v, weight) for (u, v), weight in zip(positions, weights) if weight is not None]
        check(n, edges, 'exhaustive_weight_alphabet')
    exhaustive.append({'vertices': n, 'weightAlphabet': alphabet,
                       'graphs': graphs-before_graphs, 'queries': queries-before_queries})

check(3, [(0, 1, 10**12), (0, 1, -10**12), (1, 2, 10**12),
          (2, 2, 0), (2, 1, 10**12)], 'parallel_edges_and_large_exact_weights')
check(4, [(0, 1, 10**12), (1, 2, 10**12), (2, 3, 10**12)], 'large_exact_finite_path')
check(4, [(0, 1, 1), (0, 2, 0), (2, 2, -1)], 'reachable_cycle_without_target_path')
check(4, [(0, 1, 1), (2, 2, -1), (2, 1, 0)], 'cycle_with_target_path_without_source_path')
rng = random.Random(int(seed_text[:16], 16))
before_graphs, before_queries = graphs, queries
for _ in range(200):
    n = rng.randrange(4, 9)
    edges = [(rng.randrange(n), rng.randrange(n), rng.choice([-10**12, -1, 0, 1, 10**12]))
             for _ in range(rng.randrange(n*n+1))]
    check(n, edges, 'source_hash_seeded_larger_multigraphs')

report = {'status': 'completed', 'sourceCodeSha256': hashlib.sha256(raw).hexdigest(),
          'pythonVersion': sys.version, 'pythonExecutable': sys.executable,
          'entryPoint': entries[0], 'graphs': graphs, 'queries': queries,
          'failures': failures, 'failureSamples': samples, 'expectedOutcomes': outcomes,
          'exhaustiveFamilies': exhaustive,
          'randomizedFamily': {'seedHex': seed_text[:16], 'graphs': graphs-before_graphs,
                               'queries': queries-before_queries, 'vertices': [4, 8]},
          'durationSeconds': time.monotonic()-started,
          'scope': 'Independent Floyd-Warshall walk-classification oracle on finite declared test families. '
                   'The recorded implementation is unchanged. This does not prove all inputs, interface naming, '
                   'complexity, ASR accuracy, old-code retention, or full interview correctness.'}
pathlib.Path(output).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'graphs': graphs, 'queries': queries, 'failures': failures}))
