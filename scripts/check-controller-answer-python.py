"""Post-capture independent finite oracles for exact recorded Python code.

No function renaming, return-value normalization, code repair or expected answer
is supplied to the assistant. These checks assess a finite domain, not a proof
for every allowed input. Run only after measured native inference has stopped.
"""
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path
import random
import re
import sys
from decimal import Decimal, localcontext


def route_oracle(n, edges, source, target):
    adjacency = [[] for _ in range(n)]
    for u, v, cost in edges:
        adjacency[u].append((v, cost))

    def reachable(start):
        seen, pending = {start}, [start]
        while pending:
            for v, _ in adjacency[pending.pop()]:
                if v not in seen:
                    seen.add(v)
                    pending.append(v)
        return seen

    forward = reachable(source)
    if target not in forward:
        return "UNREACHABLE", None
    relevant = {v for v in forward if target in reachable(v)}
    # Enumerate simple cycles and simple s->t paths. Removing nonnegative
    # cycles leaves a simple minimum walk; a relevant negative cycle is unbounded.
    for start in relevant:
        def cycle(node, visited, total):
            for nxt, cost in adjacency[node]:
                if nxt == start and total + cost < 0:
                    return True
                if nxt in relevant and nxt not in visited:
                    if cycle(nxt, visited | {nxt}, total + cost):
                        return True
            return False
        if cycle(start, {start}, 0):
            return "UNBOUNDED", None
    costs = [0] if source == target else []

    def paths(node, visited, total):
        for nxt, cost in adjacency[node]:
            if nxt not in relevant or nxt in visited:
                continue
            if nxt == target:
                costs.append(total + cost)
            else:
                paths(nxt, visited | {nxt}, total + cost)
    paths(source, {source}, 0)
    return "FINITE", min(costs)


def check_route(function):
    count, failures = 0, []

    def check(n, edges, source, target):
        nonlocal count
        expected = route_oracle(n, edges, source, target)
        count += 1
        try:
            actual = function(n, list(edges), source, target)
            if actual != expected:
                failures.append({"n": n, "edges": edges, "s": source, "t": target,
                                 "expected": expected, "actual": repr(actual)})
        except Exception as error:
            failures.append({"n": n, "edges": edges, "s": source, "t": target,
                             "expected": expected, "exception": repr(error)})

    positions = [(u, v) for u in range(3) for v in range(3) if u != v]
    for weights in itertools.product([None, -1, 0, 1], repeat=len(positions)):
        edges = [(u, v, cost) for (u, v), cost in zip(positions, weights) if cost is not None]
        for source in range(3):
            for target in range(3):
                check(3, edges, source, target)
    rng = random.Random(17739)
    for _ in range(2000):
        n = rng.randrange(1, 5)
        edges = [(rng.randrange(n), rng.randrange(n), rng.choice([-10**12, -1, 0, 1, 10**12]))
                 for _ in range(rng.randrange(11))]
        for source in range(n):
            for target in range(n):
                check(n, edges, source, target)
    return {"comparisons": count, "mismatchCount": len(failures), "firstFailures": failures[:12],
            "scope": "Exhaustive 3-vertex directed graphs without self-loops over absent/-1/0/1 edges; seeded multigraph/self-loop/extreme-weight probes up to 4 vertices. Complexity proof still requires manual review."}


def check_float(function):
    rng = random.Random(18913)
    inputs = [0.0, math.ulp(0.0), sys.float_info.min, 1.0, 1e100, 1e308, sys.float_info.max]
    inputs += [math.ldexp(rng.uniform(1, 2), rng.randrange(-1074, 1023)) for _ in range(3000)]
    failures, max_relative = [], Decimal(0)
    with localcontext() as context:
        context.prec = 760  # Resolves rationalized result at the largest binary64 input.
        for x in inputs:
            value = Decimal.from_float(x)
            expected = Decimal(1) / ((value * value + 1).sqrt() + value)
            try:
                actual = function(x)
                error = abs(Decimal.from_float(actual) / expected - 1)
                max_relative = max(max_relative, error)
                # Relative tolerance applies only to normal exact results.
                # Subnormal results have an absolute rounding bound instead.
                tolerance = Decimal.from_float(math.ulp(actual)) * 4
                if not (math.isfinite(actual) and actual > 0) or abs(Decimal.from_float(actual) - expected) > tolerance:
                    failures.append({"x": x, "actual": actual, "expected": str(expected), "relativeError": str(error)})
            except Exception as error:
                failures.append({"x": x, "exception": repr(error)})
    return {"comparisons": len(inputs), "mismatchCount": len(failures), "firstFailures": failures[:12],
            "maxObservedRelativeError": str(max_relative), "scope": "760-digit Decimal oracle, four-ULP finite probe tolerance, gradual underflow on this host. It does not certify a supplied analytical error bound or flush-to-zero behavior."}


def exact_walk_oracle(n, edges, source, target, length):
    """Independent forward DP; no exponentiation or generated witness code."""
    distances = [None] * n
    distances[source] = 0
    for _ in range(length):
        following = [None] * n
        for u, v, weight in edges:
            if distances[u] is not None:
                candidate = distances[u] + weight
                if following[v] is None or candidate < following[v]:
                    following[v] = candidate
        distances = following
    return distances[target]


def check_exact_walk(function):
    count, indexed, maximum_nodes, failures = 0, 0, 0, []

    def check(n, edges, source, target, length, huge=None):
        nonlocal count, indexed, maximum_nodes
        count += 1
        expected = exact_walk_oracle(n, edges, source, target, length) if huge is None else huge[0]
        try:
            status, cost, witness = function(n, list(edges), source, target, length)
            if expected is None:
                assert (status, cost, witness) == ("unreachable", None, None)
                return
            assert status == "finite" and type(cost) is int and cost == expected
            assert witness is not None
            if hasattr(witness, "nodes"):
                node_count = len(witness.nodes)
                maximum_nodes = max(maximum_nodes, node_count)
                assert node_count <= n + len(edges) + 2 * n * n * (length.bit_length() + 1)
            if huge is None:
                current, total = source, 0
                for position in range(length):
                    edge_id = witness.edge_at(position)
                    indexed += 1
                    assert type(edge_id) is int and 0 <= edge_id < len(edges)
                    u, v, weight = edges[edge_id]
                    assert u == current
                    current, total = v, total + weight
                assert current == target and total == cost
            else:
                for position in [0, 1, length // 2, length - 2, length - 1]:
                    edge_id = witness.edge_at(position)
                    indexed += 1
                    assert edge_id == huge[1](position)
        except Exception as error:
            failures.append({"n": n, "edges": edges, "s": source, "t": target, "length": length,
                             "expectedCost": expected, "exception": repr(error)})

    positions = [(u, v) for u in range(2) for v in range(2)]
    for weights in itertools.product([None, -1, 0, 1], repeat=4):
        edges = [(u, v, weight) for (u, v), weight in zip(positions, weights) if weight is not None]
        for source in range(2):
            for target in range(2):
                for length in range(6):
                    check(2, edges, source, target, length)
    rng = random.Random(19071)
    for _ in range(300):
        n = rng.randrange(1, 5)
        edges = [(rng.randrange(n), rng.randrange(n), rng.choice([-10**12, -2, 0, 3, 10**12]))
                 for _ in range(rng.randrange(11))]
        check(n, edges, rng.randrange(n), rng.randrange(n), rng.randrange(9))
    length = 10**18
    check(1, [(0, 0, -4), (0, 0, 3)], 0, 0, length, (-4 * length, lambda _: 0))
    check(2, [(0, 1, 5), (0, 1, -2), (1, 1, -3)], 0, 1, length,
          (-2 - 3 * (length - 1), lambda i: 1 if i == 0 else 2))
    check(2, [(0, 1, -2), (1, 0, 5)], 0, 0, length,
          (3 * (length // 2), lambda i: i % 2))
    check(2, [(0, 1, -7)], 0, 1, length, (None, None))
    return {"comparisons": count, "indexedEdgesChecked": indexed, "maxReturnedNodes": maximum_nodes,
            "mismatchCount": len(failures), "firstFailures": failures[:12],
            "scope": "Forward-DP oracle for exhaustive 2-vertex absent/-1/0/1 graphs at lengths0..5; seeded small signed multigraphs. Four exact10^18-length contracts and sampled indexed retrieval; available returned-node counts are bounded. Not exhaustive huge-witness expansion, runtime asymptotic certification or a substitute for proof review."}


def monitor_oracle(outcomes):
    numerator, denominator, successes, first = 1, 1, 0, None
    for previous, outcome in enumerate(outcomes):
        if 75 * successes > 7 * previous:
            numerator *= 15 if outcome else 135
            denominator *= 14 if outcome else 136
        successes += outcome
        if first is None and numerator >= 20 * denominator:
            first = previous + 1
    return first


def check_monitor(function):
    failures, count = [], 0

    class OneShot:
        def __init__(self, values):
            self.values, self.used, self.consumed = values, False, 0

        def __iter__(self):
            assert not self.used, "Iterable consumed more than once"
            self.used = True
            for value in self.values:
                self.consumed += 1
                yield value

    def check(values, invalid=False):
        nonlocal count
        count += 1
        stream = OneShot(values)
        try:
            if invalid:
                try:
                    function(stream)
                except ValueError:
                    return
                raise AssertionError("Invalid outcome accepted or skipped after crossing")
            expected = monitor_oracle(values)
            actual = function(stream)
            assert actual == expected and (actual is None or type(actual) is int)
            assert stream.consumed == len(values), "Finite input not fully validated"
        except Exception as error:
            failures.append({"values": values, "invalid": invalid, "exception": repr(error)})

    for length in range(11):
        for bits in itertools.product([0, 1], repeat=length):
            check(list(bits))
    rng = random.Random(82731)
    for _ in range(400):
        check([rng.randrange(2) for _ in range(rng.randrange(251))])
    for values in [[0] * 1000, [1] * 44, [1] * 45, [1] * 1000, [1] * 45 + [0] * 1000]:
        check(values)
    for bad in [True, False, -1, 2, 0.0, 1.0, "1", None]:
        for prefix in [[], [1] * 45]:
            check(prefix + [bad], invalid=True)
    return {"comparisons": count, "mismatchCount": len(failures), "firstFailures": failures[:12],
            "scope": "Independent integer-product oracle: all binary strings through length10, seeded finite traces and long crossing/noncrossing traces. One-shot consumption and invalid values before/after crossing checked. Exact arithmetic and pre-fetch choice also require source review; this does not empirically prove Ville's inequality."}


def check_pipeline(function):
    failures, checked = [], 0
    try:
        rows = function()
        assert type(rows) is list and len(rows) == 8
        stages = ["preparation", "copy", "kernel"]
        durations = [96, 125, 96]
        for index, row in enumerate(rows):
            for stage, duration in zip(stages, durations):
                start, finish = row[stage]
                assert type(start) is int and type(finish) is int and start >= 0
                assert finish - start == duration
                checked += 1
                if index:
                    assert start >= rows[index - 1][stage][1]
                    checked += 1
            assert row["copy"][0] >= row["preparation"][1]
            assert row["kernel"][0] >= row["copy"][1]
            checked += 2
            if index >= 2:
                assert row["preparation"][0] >= rows[index - 2]["copy"][1]
                assert row["copy"][0] >= rows[index - 2]["kernel"][1]
                checked += 2
        assert rows[-1]["kernel"][1] == 96 + 8 * 125 + 96
        checked += 1
    except Exception as error:
        failures.append({"exception": repr(error)})
    return {"comparisons": checked, "mismatchCount": len(failures), "firstFailures": failures,
            "scope": "Actual returned eight-input 96/125/96 schedule: integer stage durations, serial resources, separate host/copy and device/kernel slot release inequalities and attainment of the independently derived1192 lower bound. One specified instance, not a general scheduling theorem."}


def main():
    journal_path, spec_path, output_path = map(Path, sys.argv[1:4])
    data = journal_path.read_bytes()
    journal, spec = json.loads(data), json.loads(spec_path.read_text())
    assert journal["status"] == "complete"
    assert spec["journalSha256"] == hashlib.sha256(data).hexdigest()
    output_path.mkdir(parents=True, exist_ok=True)
    results = []
    for item in spec["checks"]:
        row = next(row for row in journal["rows"] if row["round"] == item["round"])
        blocks = re.findall(r"```(?:python|py|python3)\s*\n([\s\S]*?)```", row["answer"])
        result = {"round": item["round"], "kind": item["kind"], "entryPoint": item["function"],
                  "contractScope": item.get("scope", "Original required source contract"),
                  "answerSha256": hashlib.sha256(row["answer"].encode()).hexdigest()}
        results.append(result)
        try:
            code = blocks[item.get("block", 0)]
            source = output_path / f"round-{item['round']}-block-{item.get('block', 0)}.py"
            source.write_text(code, encoding="utf-8")
            result["codeSha256"] = hashlib.sha256(code.encode()).hexdigest()
            module_name = f"recorded_{item['round']}_{item.get('block', 0)}"
            module_spec = importlib.util.spec_from_file_location(module_name, source)
            module = importlib.util.module_from_spec(module_spec)
            sys.modules[module_name] = module
            try:
                module_spec.loader.exec_module(module)
                function = getattr(module, item["function"])
                result.update({"route": check_route, "float-rationalization": check_float, "exact-length-walk": check_exact_walk, "predictable-monitor": check_monitor, "two-slot-pipeline": check_pipeline}[item["kind"]](function))
            finally:
                sys.modules.pop(module_name, None)
            result["pass"] = result["mismatchCount"] == 0
        except Exception as error:
            result.update({"pass": False, "failure": repr(error)})
    report = {"journalSha256": hashlib.sha256(data).hexdigest(), "graderSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "results": results,
              "scope": "Exact source fences and required entry points, without return contract normalization. Finite oracles complement, and do not replace, proof review."}
    (output_path / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(results))


if __name__ == "__main__":
    main()
