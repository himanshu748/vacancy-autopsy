"""Offline checks protecting benchmark accounting and summary definitions."""
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench_cost_latency import BenchmarkDeadline, enforce_budget, percentile, summarize, token_cost, wait_same_future
from data import DataError


class BenchmarkAccountingTests(unittest.TestCase):
    def test_hard_run_deadline_is_not_swallowed_as_local_pending_wait(self):
        class InterruptedFuture:
            def result(self, timeout):
                raise BenchmarkDeadline()
            def done(self):
                return False
        with self.assertRaises(BenchmarkDeadline):
            wait_same_future(InterruptedFuture(), 180, lambda: self.fail("hard deadline swallowed"))

    def test_pending_wait_observes_same_future_until_result(self):
        class PendingFuture:
            calls = 0
            def result(self, timeout):
                self.calls += 1
                if self.calls == 1:
                    raise TimeoutError()
                return "original accepted result"
            def done(self):
                return False
        future = PendingFuture()
        observations = []
        self.assertEqual(wait_same_future(future, 180, lambda: observations.append("pending")), "original accepted result")
        self.assertEqual(future.calls, 2)
        self.assertEqual(observations, ["pending"])

    def test_terminal_future_timeout_is_not_polled_as_pending(self):
        class FailedFuture:
            def result(self, timeout):
                raise TimeoutError()
            def done(self):
                return True
        with self.assertRaises(TimeoutError):
            wait_same_future(FailedFuture(), 180, lambda: self.fail("terminal future marked pending"))

    def test_budget_reserves_full_next_response_and_rejects_overage(self):
        enforce_budget(2.95, .05, 3)
        with self.assertRaises(DataError):
            enforce_budget(2.95, .0501, 3)
        with self.assertRaises(DataError):
            enforce_budget(0, float("nan"), 3)

    def test_uncached_cost_uses_both_actual_token_counts(self):
        self.assertAlmostEqual(token_cost(1000, 100, {"prefill": .195, "sample": .6}), .000255)

    def test_linear_percentiles_include_slow_tail(self):
        self.assertEqual(percentile([1, 2, 3, 4], .5), 2.5)
        self.assertAlmostEqual(percentile([1, 2, 3, 4], .95), 3.85)

    def test_invalid_output_is_scored_and_not_dropped_from_cost(self):
        rows = [{"gold": {"employer": "Acme", "title": "Engineer", "job_id": "123", "ats": "greenhouse"}}]
        result = summarize(rows, [{"raw": "invalid", "latency_seconds": 4, "input_tokens": 1000, "output_tokens": 10}],
                           {"prefill": 1, "sample": 2})
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["metrics"]["exact_record_accuracy"], 0)
        self.assertEqual(result["metrics"]["invalid_json_count"], 1)
        self.assertAlmostEqual(result["usd_per_1000_listings"], 1.02)


if __name__ == "__main__":
    unittest.main()
