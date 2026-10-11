import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "oracles", Path(__file__).parents[1] / "check-controller-answer-python.py")
oracles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracles)


class RouteOracleTests(unittest.TestCase):
    def test_negative_cycle_requires_both_reachability_conditions(self):
        query = oracles.route_oracle
        self.assertEqual(query(4, [(0, 1, 2), (1, 1, -1), (0, 3, 7)], 0, 3), ("FINITE", 7))
        self.assertEqual(query(4, [(0, 3, 7), (1, 1, -1), (1, 3, 1)], 0, 3), ("FINITE", 7))
        self.assertEqual(query(4, [(0, 1, 2), (1, 1, -1), (1, 3, 7)], 0, 3), ("UNBOUNDED", None))

    def test_empty_walk_parallel_edges_self_loops_and_unreachable(self):
        query = oracles.route_oracle
        self.assertEqual(query(1, [], 0, 0), ("FINITE", 0))
        self.assertEqual(query(1, [(0, 0, -1)], 0, 0), ("UNBOUNDED", None))
        self.assertEqual(query(2, [(0, 1, 10**12), (0, 1, -10**12)], 0, 1), ("FINITE", -10**12))
        self.assertEqual(query(2, [(0, 0, -1)], 0, 1), ("UNREACHABLE", None))


if __name__ == "__main__":
    unittest.main()
