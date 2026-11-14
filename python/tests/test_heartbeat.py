import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from autocare_heartbeat import ENV_URL, Result, beat, monitored, payload, redact

OK = (200, {"status": "ok", "health": "healthy"})


class Stub:
    """A stand-in for AutoCare: answers from `script`, one entry per request."""

    def __init__(self, script):
        seen = self.seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                seen.append({"path": self.path, "type": self.headers.get("Content-Type"), "body": json.loads(raw or b"null")})
                status, body = script[min(len(seen) - 1, len(script) - 1)]
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/v1/autocare/webhook/42/s3cret-value"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class HeartbeatTest(unittest.TestCase):
    def stub(self, script):
        s = Stub(script)
        self.addCleanup(s.close)
        return s

    def test_a_success_is_one_post_and_the_health_comes_back(self):
        s = self.stub([OK])
        self.assertEqual(beat(s.url), Result(ok=True, health="healthy"))
        self.assertEqual(s.seen, [{"path": "/api/v1/autocare/webhook/42/s3cret-value", "type": "application/json", "body": {"status": "success"}}])

    def test_the_payload_carries_only_what_was_given(self):
        self.assertEqual(payload(), {"status": "success"})
        self.assertEqual(payload(latency_ms=840.6), {"status": "success", "latency_ms": 841})
        self.assertEqual(payload(error=RuntimeError("CRM said 401")), {"status": "failure", "error_message": "CRM said 401"})
        self.assertEqual(payload(status="failure"), {"status": "failure"})
        self.assertEqual(payload(status="success", error="ignored"), {"status": "success"})
        self.assertEqual(payload(latency_ms=-5), {"status": "success"})
        self.assertEqual(len(payload(error="x" * 2000)["error_message"]), 500)

    def test_a_5xx_is_retried_and_a_4xx_is_not(self):
        flaky = self.stub([(503, {}), (502, {}), OK])
        self.assertEqual(beat(flaky.url, retry_delay=0.001), Result(ok=True, health="healthy"))
        self.assertEqual(len(flaky.seen), 3)

        down = self.stub([(500, {})])
        gave_up = beat(down.url, retry_delay=0.001)
        self.assertEqual((gave_up.ok, gave_up.status, len(down.seen)), (False, 500, 3))

        for status, words in ((404, "does not know this heartbeat address"), (400, "not active")):
            s = self.stub([(status, {})])
            r = beat(s.url, retry_delay=0.001)
            self.assertFalse(r.ok)
            self.assertIn(words, r.error)
            self.assertEqual(len(s.seen), 1)

    def test_nothing_listening_is_reported_never_raised_and_the_secret_stays_out(self):
        s = Stub([OK])
        dead = s.url
        s.close()
        r = beat(dead, retries=1, retry_delay=0.001)
        self.assertFalse(r.ok)
        self.assertIn("Could not reach", r.error)
        self.assertNotIn("s3cret-value", r.error)
        self.assertEqual(redact("https://api.example.com/api/v1/autocare/webhook/42/s3cret-value"),
                         "https://api.example.com/api/v1/autocare/webhook/42/***")

    def test_a_bad_address_is_refused_before_anything_is_sent(self):
        saved = os.environ.pop(ENV_URL, None)
        self.addCleanup(lambda: os.environ.__setitem__(ENV_URL, saved) if saved is not None else os.environ.pop(ENV_URL, None))
        with self.assertRaisesRegex(ValueError, "No heartbeat address"):
            beat()
        with self.assertRaisesRegex(ValueError, "not a web address"):
            beat("not a url")
        with self.assertRaisesRegex(ValueError, "must be https"):
            beat("http://api.example.com/api/v1/autocare/webhook/1/abc")
        s = self.stub([OK])
        os.environ[ENV_URL] = s.url
        self.assertTrue(beat().ok)

    def test_monitored_passes_the_result_and_the_error_through(self):
        s = self.stub([OK])

        @monitored(s.url)
        def fine():
            return "done"

        @monitored(s.url)
        def broken():
            raise RuntimeError("sheet not found")

        self.assertEqual(fine(), "done")
        with self.assertRaisesRegex(RuntimeError, "sheet not found"):
            broken()
        self.assertEqual(s.seen[0]["body"]["status"], "success")
        self.assertIsInstance(s.seen[0]["body"]["latency_ms"], int)
        self.assertEqual((s.seen[1]["body"]["status"], s.seen[1]["body"]["error_message"]), ("failure", "sheet not found"))

    def test_a_heartbeat_that_cannot_be_sent_does_not_replace_the_result(self):
        s = Stub([OK])
        dead = s.url
        s.close()

        @monitored(dead, retries=0)
        def fine():
            return 7

        self.assertEqual(fine(), 7)


if __name__ == "__main__":
    unittest.main()
