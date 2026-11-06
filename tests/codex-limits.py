# Run: python3 tests/codex-limits.py
import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
LIMITS = ROOT / "usage/account-limits"
MODULE = runpy.run_path(str(LIMITS))
BUCKET = {"planType": "pro", "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 2000000000},
          "secondary": {"usedPercent": 51, "windowDurationMins": 10080, "resetsAt": 2000100000}}

# A real stdio peer: verifies the handshake and records every request (no network or account access).
SERVER = '''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
Path(os.environ["HERDR_APP_HOME"], "pid").write_text(str(os.getpid()))
for line in sys.stdin:
    m = json.loads(line)
    with open(Path(os.environ["HERDR_APP_HOME"], "requests"), "a") as f:
        f.write(line)
    if m["method"] == "initialize":
        assert m["params"]["clientInfo"]["name"] == "herdr_usage"
        print(json.dumps({"id": m["id"], "result": {}}), flush=True)
    elif m["method"] == "initialized":
        ready = True
    elif m["method"] == "account/rateLimits/read":
        assert ready
        print(json.dumps({"method": "account/updated", "params": {}}), flush=True)
        response = {"error": {"message": "offline"}} if os.environ.get("FAIL") else {"result": json.loads(os.environ["RESPONSE"])}
        print(json.dumps({"id": m["id"], **response}), flush=True)
    else:
        raise AssertionError("unexpected request")
'''


class LimitsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="herdr-limits-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        peer = self.home / "codex"
        peer.write_text(SERVER)
        peer.chmod(0o755)
        self.env = {**os.environ, "HERDR_APP_HOME": str(self.home), "HOME": str(self.home),
                    "PATH": str(self.home) + os.pathsep + os.environ["PATH"],
                    "RESPONSE": json.dumps({"rateLimits": BUCKET})}
        self.cache = self.home / "data/usage/codex-limits.json"

    def run_helper(self):
        r = subprocess.run([sys.executable, str(LIMITS), "codex"], env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout else None

    def requests(self):
        return [json.loads(s)["method"] for s in (self.home / "requests").read_text().splitlines()]

    def test_concurrent_views_share_one_request_and_server_exits(self):
        readers = [subprocess.Popen([sys.executable, str(LIMITS), "codex"], env=self.env, stdout=subprocess.PIPE) for _ in range(4)]
        readings = [json.loads(p.communicate(timeout=15)[0]) for p in readers]
        self.assertTrue(all(u == readings[0] for u in readings))
        self.assertEqual(readings[0]["five"], 12)
        self.assertEqual(readings[0]["week"], 51)
        self.assertEqual(self.requests(), ["initialize", "initialized", "account/rateLimits/read"])
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.home / "pid").read_text()), 0)

    def test_failed_refresh_preserves_reading_timestamp_and_backs_off(self):
        original = self.run_helper()
        self.cache.write_text(json.dumps({"checked": 0, "data": original}))
        self.env["FAIL"] = "1"
        self.assertEqual(self.run_helper(), original)
        self.assertEqual(self.run_helper(), original)
        self.assertEqual(len(self.requests()), 6)

    def test_corrupt_cache_is_replaced(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text('{"checked": "broken"}')
        self.assertEqual(self.run_helper()["week"], 51)

    def test_weekly_only_multi_bucket_and_invalid_values(self):
        read = MODULE["reading"]({"rateLimits": BUCKET, "rateLimitsByLimitId": {
            "codex": {"primary": BUCKET["secondary"], "secondary": None}}})
        self.assertEqual(read["week"], 51)
        self.assertIsNone(read["five"])
        for invalid in [True, -1, 101, float("nan"), "25"]:
            read = MODULE["reading"]({"rateLimits": {"primary": {**BUCKET["primary"], "usedPercent": invalid}}})
            self.assertIsNone(read["five"])

    def test_timeout_shuts_down_private_server(self):
        with patch.dict(os.environ, self.env), patch("select.select", return_value=([], [], [])):
            with self.assertRaises(TimeoutError):
                MODULE["query"]()

    def test_usage_has_account_limits_without_any_session(self):
        r = subprocess.run(["bash", str(ROOT / "usage/codex-usage"), "99999999"], env=self.env,
                           capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        u = json.loads(r.stdout)
        self.assertEqual(u["source"], "api")
        self.assertEqual(u["week"], 51)
        self.assertNotIn("ctx", u)

    def test_no_api_reading_falls_back_to_logs_and_backs_off(self):
        self.env["FAIL"] = "1"
        sessions = self.home / ".codex/sessions/2026/11/05"
        sessions.mkdir(parents=True)
        (sessions / "rollout-test.jsonl").write_text(json.dumps({"timestamp": "2026-11-05T00:00:00Z",
            "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
                "plan_type": "pro", "primary": {"used_percent": 22, "window_minutes": 10080, "resets_at": 2000000000}}}},
            separators=(",", ":")) + "\n")
        r = subprocess.run(["bash", str(ROOT / "usage/codex-usage")], env=self.env,
                           capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["week"], 22)
        self.assertEqual(json.loads(r.stdout)["source"], "log")
        self.assertIsNone(self.run_helper())
        self.assertEqual(len(self.requests()), 3)


class ClaudeTest(unittest.TestCase):
    def test_keychain_token_is_used_only_in_request_to_anthropic(self):
        payload = {"five_hour": {"utilization": 25, "resets_at": "2026-11-05T10:00:00Z"},
                   "seven_day_sonnet": {"utilization": 12, "resets_at": None}, "extra_usage": {"utilization": 99}}
        with patch.dict(os.environ, {}, clear=True), patch("sys.platform", "darwin"), \
             patch("subprocess.run", return_value=SimpleNamespace(returncode=0,
                   stdout=b'{"claudeAiOauth":{"accessToken":"test-secret","refreshToken":"never-use"}}')) as security, \
             patch("urllib.request.urlopen") as opened:
            opened.return_value.__enter__.return_value = io.StringIO(json.dumps(payload))
            data = MODULE["claude_reading"](MODULE["claude_query"]())
            request = opened.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.anthropic.com/api/oauth/usage")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-secret")
            self.assertEqual(security.call_args.args[0], ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])
        self.assertEqual(data["five"], 25)
        self.assertEqual(data["five_reset"], 1793872800)
        self.assertEqual(data["limits"]["seven_day_sonnet"]["used_percentage"], 12)
        self.assertIsNone(data["week"])
        self.assertNotIn("secret", json.dumps(data))
        self.assertNotIn("extra_usage", data["limits"])

    def test_file_credentials_and_missing_login(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": folder}, clear=True):
            path = Path(folder) / ".credentials.json"
            path.write_text('{"claudeAiOauth":{"accessToken":"file-secret"}}')
            with patch("urllib.request.urlopen") as opened:
                opened.return_value.__enter__.return_value = io.StringIO('{}')
                MODULE["claude_query"]()
                self.assertEqual(opened.call_args.args[0].get_header("Authorization"), "Bearer file-secret")
            path.write_text('{}')
            with self.assertRaises(ValueError):
                MODULE["claude_query"]()

    def test_rate_limit_preserves_reading_and_honors_retry_after(self):
        main = MODULE["main"]
        old = {"at": 100, "source": "api", "five": 25}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"HERDR_APP_HOME": folder}), \
             patch.dict(main.__globals__, {"claude_query": lambda: (_ for _ in ()).throw(
                 urllib.error.HTTPError("https://api.anthropic.com/api/oauth/usage", 429, "rate limited", {"Retry-After": "1800"}, io.BytesIO()))}):
            path = Path(folder) / "data/usage/claude-limits.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"checked": 0, "data": old}))
            with redirect_stdout(io.StringIO()) as out:
                main("claude")
            self.assertEqual(json.loads(out.getvalue()), old)
            cache = json.loads(path.read_text())
            self.assertEqual(cache["data"]["at"], 100)
            self.assertGreater(cache["checked"], __import__("time").time() + 1500)


if __name__ == "__main__":
    unittest.main()
