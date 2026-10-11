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
            source = output_path / f"round-{item['round']}.py"
            source.write_text(code, encoding="utf-8")
            result["codeSha256"] = hashlib.sha256(code.encode()).hexdigest()
            module_spec = importlib.util.spec_from_file_location(f"recorded_{item['round']}", source)
            module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            function = getattr(module, item["function"])
            result.update({"route": check_route, "float-rationalization": check_float}[item["kind"]](function))
            result["pass"] = result["mismatchCount"] == 0
        except Exception as error:
            result.update({"pass": False, "failure": repr(error)})
    report = {"journalSha256": hashlib.sha256(data).hexdigest(), "results": results,
              "scope": "Exact source fences and required entry points, without return contract normalization. Finite oracles complement, and do not replace, proof review."}
    (output_path / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(results))


if __name__ == "__main__":
    main()
