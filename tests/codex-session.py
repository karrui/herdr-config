# Run: python3 tests/codex-session.py
import json
from pathlib import Path
import runpy
import unittest

summarize = runpy.run_path(str(Path(__file__).resolve().parents[1] / "usage/codex-session"))["summarize"]


def model(name):
    return json.dumps({"type": "turn_context", "payload": {"model": name}})


def usage(inp, cached, out, reasoning=0, written=0):
    return json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": inp, "cached_input_tokens": cached,
                              "cache_write_input_tokens": written, "output_tokens": out, "reasoning_output_tokens": reasoning},
        "last_token_usage": {"total_tokens": 100}, "model_context_window": 1000}}})


class SessionTest(unittest.TestCase):
    def test_cached_input_and_reasoning_are_not_double_counted(self):
        u = summarize([model("gpt-6.1-sol"), usage(100000, 80000, 10000, 9000)])
        self.assertAlmostEqual(u["cost"], 0.02 * 2 + 0.08 * 0.10 + 0.01 * 10)
        self.assertEqual(u["ctx"], 10)

    def test_model_switches_duplicate_counters_and_resets(self):
        rows = [model("gpt-6.1-sol"), usage(100000, 0, 1000), usage(100000, 0, 1000),
                model("gpt-6.1-terra"), usage(200000, 50000, 2000), usage(10000, 0, 100)]
        u = summarize(rows)
        self.assertAlmostEqual(u["cost"], 0.21 + 0.05 + 0.05 * 0.05 + 0.005 + 0.01 + 0.0005)
        self.assertEqual(u["model"], "gpt-6.1-terra")

    def test_long_context_is_per_request_and_cache_writes_have_their_own_rate(self):
        u = summarize([model("gpt-6.1-sol"), usage(300000, 200000, 10000, written=50000)])
        self.assertAlmostEqual(u["cost"], (0.05 * 2 + 0.2 * 0.1 + 0.05 * 2.5) * 2 + 0.01 * 10 * 1.5)
        u = summarize([model("gpt-6.1-sol"), usage(200000, 0, 1000), usage(400000, 0, 2000)])
        self.assertAlmostEqual(u["cost"], 0.82, msg="400K session total is two short requests")

    def test_snapshot_model_and_malformed_trailing_line(self):
        u = summarize([model("gpt-6.1-sol-2026-10-01"), usage(1000, 0, 100), '{"type":"token_count"'])
        self.assertAlmostEqual(u["cost"], 0.003)

    def test_unpriced_models_and_missing_totals_do_not_show_partial_cost(self):
        self.assertIsNone(summarize([model("gpt-6.1-sol")])["cost"])
        for name in ["future-model", None]:
            self.assertIsNone(summarize([model(name), usage(1000, 0, 100), model("gpt-6.1-sol"), usage(2000, 0, 200)])["cost"])
        last_only = json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"total_tokens": 10}}}})
        self.assertIsNone(summarize([model("gpt-6.1-sol"), last_only, usage(1000, 0, 100)])["cost"])

    def test_invalid_counters_are_not_priced(self):
        for values in [(1, 2, 1), (-1, 0, 1), (True, 0, 1), (1.5, 0, 1)]:
            self.assertIsNone(summarize([model("gpt-6.1-sol"), usage(*values)])["cost"])


if __name__ == "__main__":
    unittest.main()
