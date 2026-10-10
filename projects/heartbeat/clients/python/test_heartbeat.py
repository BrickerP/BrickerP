"""unittest suite for heartbeat.py against a tiny in-process HTTP server.

Run with:  python3 -m unittest discover -s clients/python -v
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List
from unittest import mock

import heartbeat


class _StubServer:
    """Records every request; behaviour is controlled through ``next_status``/``delay``."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.next_status = 200
        self.next_body: Any = {"ok": True, "state": "up", "p95Ms": 2400, "nextDeadline": "2026-10-10T00:00:00Z"}
        self.delay = 0.0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server naming
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = raw
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                if outer.delay:
                    time.sleep(outer.delay)
                payload = json.dumps(outer.next_body).encode()
                try:
                    self.send_response(outer.next_status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # client gave up (timeout test)

            def log_message(self, *args: Any) -> None:  # silence
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.httpd.block_on_close = False
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)

    def start(self) -> "_StubServer":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def monitor_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}/v1/monitors/scan-batch"


def _closed_port_url() -> str:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}/v1/monitors/x"


class BeatTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = _StubServer().start()
        self.addCleanup(self.server.stop)
        self.url = self.server.monitor_url
        self.token = "hb_test-token-0123456789"

    def last(self) -> Dict[str, Any]:
        self.assertTrue(self.server.requests, "no request reached the stub server")
        return self.server.requests[-1]

    def test_beat_posts_json_with_bearer_and_beat_suffix(self) -> None:
        result = heartbeat.beat(self.url, self.token, duration_ms=2400, meta={"batch": 7})
        req = self.last()
        self.assertEqual(req["path"], "/v1/monitors/scan-batch/beat")
        self.assertEqual(req["headers"]["Authorization"], f"Bearer {self.token}")
        self.assertEqual(req["headers"]["Content-Type"], "application/json")
        self.assertEqual(req["body"], {"status": "ok", "durationMs": 2400.0, "meta": {"batch": 7}})
        self.assertEqual(result["state"], "up")
        self.assertEqual(result["p95Ms"], 2400)

    def test_beat_url_is_not_doubled(self) -> None:
        heartbeat.beat(self.url + "/beat/", self.token)
        self.assertEqual(self.last()["path"], "/v1/monitors/scan-batch/beat")
        self.assertEqual(self.last()["body"], {"status": "ok"})

    def test_fail_status_and_non_serialisable_meta(self) -> None:
        heartbeat.beat(self.url, self.token, status="fail", meta={"when": object()})
        body = self.last()["body"]
        self.assertEqual(body["status"], "fail")
        self.assertIn("object object", body["meta"]["when"])  # default=str fallback

    def test_invalid_status_is_a_programming_error(self) -> None:
        with self.assertRaises(ValueError):
            heartbeat.beat(self.url, self.token, status="meh")
        self.assertEqual(self.server.requests, [])

    def test_http_error_is_logged_not_raised(self) -> None:
        self.server.next_status = 401
        self.server.next_body = {"error": "unauthorized"}
        with self.assertLogs("heartbeat", level="WARNING") as logs:
            result = heartbeat.beat(self.url, "wrong-token")
        self.assertIsNone(result)
        self.assertIn("HTTP 401", "\n".join(logs.output))

    def test_connection_refused_is_logged_not_raised(self) -> None:
        with self.assertLogs("heartbeat", level="WARNING") as logs:
            result = heartbeat.beat(_closed_port_url(), self.token, duration_ms=1)
        self.assertIsNone(result)
        self.assertIn("could not reach", "\n".join(logs.output))

    def test_timeout_returns_quickly(self) -> None:
        self.server.delay = 2.0
        started = time.perf_counter()
        with self.assertLogs("heartbeat", level="WARNING"):
            result = heartbeat.beat(self.url, self.token, timeout=0.2)
        self.assertIsNone(result)
        self.assertLess(time.perf_counter() - started, 1.5)

    def test_env_fallback_and_missing_config(self) -> None:
        with mock.patch.dict(os.environ, {"HEARTBEAT_URL": self.url, "HEARTBEAT_TOKEN": "env-token-000000000"}):
            heartbeat.beat(duration_ms=5)
        self.assertEqual(self.last()["headers"]["Authorization"], "Bearer env-token-000000000")

        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertLogs("heartbeat", level="WARNING"):
                self.assertIsNone(heartbeat.beat(duration_ms=5))


class SpanAndTimedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = _StubServer().start()
        self.addCleanup(self.server.stop)
        self.url = self.server.monitor_url
        self.token = "hb_test-token-0123456789"

    def last_body(self) -> Dict[str, Any]:
        self.assertTrue(self.server.requests)
        return self.server.requests[-1]["body"]

    def test_span_reports_duration_and_meta(self) -> None:
        with heartbeat.span(self.url, self.token, meta={"job": "scan"}) as s:
            time.sleep(0.05)
            s.meta["rows"] = 3
        body = self.last_body()
        self.assertEqual(body["status"], "ok")
        self.assertGreaterEqual(body["durationMs"], 45)
        self.assertEqual(body["meta"], {"job": "scan", "rows": 3})
        self.assertEqual(s.result["state"], "up")
        self.assertIsNotNone(s.duration_ms)

    def test_span_reports_fail_and_reraises(self) -> None:
        with self.assertRaises(RuntimeError):
            with heartbeat.span(self.url, self.token):
                raise RuntimeError("sqlite locked")
        body = self.last_body()
        self.assertEqual(body["status"], "fail")
        self.assertEqual(body["meta"]["error"], "RuntimeError: sqlite locked")

    def test_span_manual_fail(self) -> None:
        with heartbeat.span(self.url, self.token) as s:
            s.fail("no rows written")
        body = self.last_body()
        self.assertEqual(body["status"], "fail")
        self.assertEqual(body["meta"]["error"], "no rows written")

    def test_span_survives_unreachable_server(self) -> None:
        with self.assertLogs("heartbeat", level="WARNING"):
            with heartbeat.span(_closed_port_url(), self.token) as s:
                pass
        self.assertIsNone(s.result)

    def test_timed_sync(self) -> None:
        @heartbeat.timed(self.url, self.token)
        def work(x: int) -> int:
            """doc"""
            return x * 2

        self.assertEqual(work(21), 42)
        self.assertEqual(work.__name__, "work")
        self.assertEqual(work.__doc__, "doc")
        self.assertEqual(self.last_body()["status"], "ok")
        self.assertIn("durationMs", self.last_body())

    def test_timed_sync_failure_reraises(self) -> None:
        @heartbeat.timed(self.url, self.token)
        def boom() -> None:
            raise ValueError("bad batch")

        with self.assertRaises(ValueError):
            boom()
        self.assertEqual(self.last_body()["status"], "fail")
        self.assertIn("ValueError: bad batch", self.last_body()["meta"]["error"])

    def test_timed_async(self) -> None:
        @heartbeat.timed(self.url, self.token, meta={"mode": "async"})
        async def work() -> str:
            await asyncio.sleep(0.02)
            return "done"

        self.assertEqual(asyncio.run(work()), "done")
        body = self.last_body()
        self.assertEqual(body["status"], "ok")
        self.assertGreaterEqual(body["durationMs"], 15)
        self.assertEqual(body["meta"], {"mode": "async"})

    def test_timed_async_failure_reraises(self) -> None:
        @heartbeat.timed(self.url, self.token)
        async def boom() -> None:
            raise KeyError("missing")

        with self.assertRaises(KeyError):
            asyncio.run(boom())
        self.assertEqual(self.last_body()["status"], "fail")

    def test_heartbeat_class_binds_url_and_token(self) -> None:
        hb = heartbeat.Heartbeat(self.url, self.token)
        hb.beat(duration_ms=1)
        self.assertEqual(self.server.requests[-1]["headers"]["Authorization"], f"Bearer {self.token}")

        @hb.timed()
        def work() -> int:
            return 1

        work()
        with hb.span() as s:
            s.meta["k"] = "v"
        self.assertEqual(len(self.server.requests), 3)
        self.assertEqual(self.last_body()["meta"], {"k": "v"})


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = _StubServer().start()
        self.addCleanup(self.server.stop)

    def test_cli_sends_a_beat(self) -> None:
        with mock.patch("sys.stdout"):
            code = heartbeat._main([self.server.monitor_url, "tok", "--duration-ms", "12", "--meta", '{"a":1}'])
        self.assertEqual(code, 0)
        body = self.server.requests[-1]["body"]
        self.assertEqual(body, {"status": "ok", "durationMs": 12.0, "meta": {"a": 1}})

    def test_cli_times_a_command_and_propagates_exit_code(self) -> None:
        code = heartbeat._main([self.server.monitor_url, "tok", "--", "python3", "-c", "import sys; sys.exit(3)"])
        self.assertEqual(code, 3)
        body = self.server.requests[-1]["body"]
        self.assertEqual(body["status"], "fail")
        self.assertEqual(body["meta"]["exitCode"], 3)
        self.assertEqual(body["meta"]["command"], "python3")


if __name__ == "__main__":
    unittest.main()
