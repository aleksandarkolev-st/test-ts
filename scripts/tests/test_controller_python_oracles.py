"""Regression checks for the independent post-capture Python grader."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("controller_python_oracles", Path(__file__).parents[1] / "check-controller-answer-python.py")
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class Witness:
    def __init__(self, edges=None, formula=None):
        self.edges, self.formula = edges, formula

    def edge_at(self, position):
        return self.formula(position) if self.formula else self.edges[position]


def reference_walk(n, edges, source, target, length):
    # Small reference uses explicit edge lists. Huge cases are separate known
    # closed forms; this fixture does not implement min-plus exponentiation.
    if length == 10**18:
        if n == 1:
            return "finite", -4 * length, Witness(formula=lambda _: 0)
        if len(edges) == 3:
            return "finite", -2 - 3 * (length - 1), Witness(formula=lambda i: 1 if i == 0 else 2)
        if len(edges) == 2:
            return "finite", 3 * (length // 2), Witness(formula=lambda i: i % 2)
        return "unreachable", None, None
    current = {source: (0, [])}
    for _ in range(length):
        following = {}
        for index, (u, v, weight) in enumerate(edges):
            if u in current:
                cost, walk = current[u]
                if v not in following or cost + weight < following[v][0]:
                    following[v] = (cost + weight, walk + [index])
        current = following
    if target not in current:
        return "unreachable", None, None
    cost, walk = current[target]
    return "finite", cost, Witness(edges=walk)


class ExactWalkOracleTests(unittest.TestCase):
    def test_length_is_exact_and_real_loops_are_edges(self):
        self.assertIsNone(grader.exact_walk_oracle(2, [(0, 1, -7)], 0, 1, 2))
        self.assertEqual(grader.exact_walk_oracle(1, [(0, 0, -4)], 0, 0, 5), -20)
        self.assertEqual(grader.exact_walk_oracle(2, [], 1, 1, 0), 0)
        self.assertIsNone(grader.exact_walk_oracle(2, [], 0, 1, 0))

    def test_parallel_edges_and_zero_cost_are_not_missing(self):
        self.assertEqual(grader.exact_walk_oracle(2, [(0, 1, 5), (0, 1, 0)], 0, 1, 1), 0)
        self.assertEqual(grader.exact_walk_oracle(2, [(0, 1, -2), (1, 0, 5)], 0, 0, 4), 6)

    def test_accepts_valid_small_walks_and_huge_indexed_contracts(self):
        report = grader.check_exact_walk(reference_walk)
        self.assertEqual(report["comparisons"], 6448)
        self.assertEqual(report["mismatchCount"], 0, report["firstFailures"])
        self.assertGreater(report["indexedEdgesChecked"], 15)

    def test_rejects_correct_cost_with_broken_witness(self):
        def broken(*args):
            status, cost, witness = reference_walk(*args)
            return status, cost, Witness(formula=lambda _: -1) if witness else None
        report = grader.check_exact_walk(broken)
        self.assertGreater(report["mismatchCount"], 0)

    def test_does_not_normalize_required_status(self):
        def uppercase(*args):
            status, cost, witness = reference_walk(*args)
            return status.upper(), cost, witness
        self.assertEqual(grader.check_exact_walk(uppercase)["mismatchCount"], 6448)


class MonitorOracleTests(unittest.TestCase):
    def test_first_crossing_and_predictability(self):
        self.assertIsNone(grader.monitor_oracle([1] * 44))
        self.assertEqual(grader.monitor_oracle([1] * 45), 45)
        self.assertEqual(grader.monitor_oracle([1] * 45 + [0] * 1000), 45)
        self.assertIsNone(grader.monitor_oracle([0] * 1000))

    def test_rejects_early_return_that_skips_invalid_tail(self):
        def early_return(values):
            prefix = []
            for value in values:
                if isinstance(value, bool) or type(value) is not int or value not in (0, 1):
                    raise ValueError("bad")
                prefix.append(value)
                crossing = grader.monitor_oracle(prefix)
                if crossing:
                    return crossing
            return None
        report = grader.check_monitor(early_return)
        self.assertGreaterEqual(report["mismatchCount"], 8)


class PipelineOracleTests(unittest.TestCase):
    @staticmethod
    def schedule():
        rows = []
        for i in range(8):
            prep = [0, 96][i] if i < 2 else 96 + 125 * (i - 1)
            copy, kernel = 96 + 125 * i, 221 + 125 * i
            rows.append({"preparation": (prep, prep + 96), "copy": (copy, copy + 125), "kernel": (kernel, kernel + 96)})
        return rows

    def test_accepts_feasible_bound_attaining_schedule(self):
        self.assertEqual(grader.check_pipeline(self.schedule)["mismatchCount"], 0)

    def test_rejects_unrestricted_prep_that_reuses_owned_host_slot(self):
        rows = self.schedule()
        rows[2]["preparation"] = (192, 288)
        self.assertEqual(grader.check_pipeline(lambda: rows)["mismatchCount"], 1)

    def test_rejects_plausible_table_with_wrong_stage_duration(self):
        rows = self.schedule()
        rows[7]["kernel"] = (1096, 1191)
        self.assertEqual(grader.check_pipeline(lambda: rows)["mismatchCount"], 1)


if __name__ == "__main__":
    unittest.main()
