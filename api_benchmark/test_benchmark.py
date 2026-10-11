"""Offline tests: no real credentials, no external API calls."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace as NS

import benchmark as b


class Usage:
    def __init__(self, **values):
        self.values = values

    def model_dump(self):
        return self.values


def chunk(answer="", reasoning="", finish=None, usage=None):
    return NS(model="mock-model", id="mock-id", system_fingerprint="mock-fp", usage=usage,
              choices=[NS(index=0, delta=NS(content=answer, reasoning_content=reasoning), finish_reason=finish)])


class Stream:
    def __init__(self, events, delay=.002):
        self.events, self.delay, self.closed = events, delay, False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def __aiter__(self):
        for event in self.events:
            await asyncio.sleep(self.delay)
            if isinstance(event, Exception):
                raise event
            yield event


class Client:
    def __init__(self, events, delay=.002, error=None):
        self.events, self.delay, self.error = events, delay, error
        self.calls = []
        self.chat = NS(completions=NS(create=self.create))

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        self.stream = Stream(self.events, self.delay)
        return self.stream


class Tests(unittest.IsolatedAsyncioTestCase):
    def args(self, extra=()):
        return b.parser().parse_args(list(extra))

    async def test_reasoning_usage_and_cost(self):
        args = self.args(["--thinking", "enabled", "--input-price", "1", "--cache-price", ".1", "--output-price", "2"])
        usage = Usage(prompt_tokens=10000, completion_tokens=500, prompt_cache_hit_tokens=9000,
                      prompt_cache_miss_tokens=1000, completion_tokens_details={"reasoning_tokens": 100})
        client = Client([chunk(), chunk(reasoning="thinking"), chunk(answer="a"), chunk(answer="b"), chunk(finish="stop", usage=usage)])
        row = await b.one_request(client, args, "prompt", "speed", 1)
        self.assertTrue(row["success"])
        self.assertGreater(row["first_answer_s"], row["ttft_s"])
        self.assertGreater(row["e2e_s"], row["last_answer_s"])
        self.assertEqual(row["answer_tokens"], 400)
        self.assertAlmostEqual(row["estimated_cost"], .0029)
        self.assertAlmostEqual(row["cache_hit_ratio"], .9)
        self.assertEqual(row["content_chunks"], 3)
        self.assertTrue(client.stream.closed)

    async def test_single_chunk_no_fake_rate_and_missing_usage(self):
        row = await b.one_request(Client([chunk(answer="abc", finish="stop")]), self.args(), "p", "s", 1)
        self.assertTrue(row["success"])
        self.assertIsNone(row["output_tokens_per_s_est"])
        self.assertIsNone(row["estimated_cost"])
        self.assertIsNone(row["cache_hit_ratio"])

    async def test_no_reasoning_breakdown_does_not_guess(self):
        row = await b.one_request(Client([chunk(reasoning="r"), chunk(answer="a", finish="stop", usage=Usage(prompt_tokens=10, completion_tokens=5))]),
                                  self.args(["--thinking", "enabled"]), "p", "s", 1)
        self.assertIsNone(row["answer_tokens"])
        self.assertIsNone(row["answer_tokens_per_s_est"])

    async def test_timeout_closes_stream(self):
        client = Client([chunk(answer="slow")], delay=.1)
        row = await b.one_request(client, self.args(["--timeout", ".01"]), "p", "s", 1)
        self.assertEqual(row["error_type"], "RequestDeadlineExceeded")
        self.assertTrue(client.stream.closed)

    async def test_disconnect_no_answer_and_length(self):
        for events, expected in [([chunk(answer="a"), RuntimeError("private")], "RuntimeError"),
                                 ([chunk(answer="a")], "IncompleteStream"),
                                 ([chunk(reasoning="r", finish="length")], "NoAnswer")]:
            row = await b.one_request(Client(events), self.args(), "p", "s", 1)
            self.assertFalse(row["success"])
            self.assertEqual(row["error_type"], expected)
            self.assertNotIn("private", json.dumps(row))
        row = await b.one_request(Client([chunk(answer="a", finish="length")]), self.args(), "p", "s", 1)
        self.assertTrue(row["success"])
        self.assertTrue(row["truncated"])

    async def test_fatal_balance_stops_new_requests(self):
        error = RuntimeError("secret")
        error.status_code = 402
        rows, summary, fatal = await b.run_stage(Client([], error=error), self.args(["--requests", "10"]), "p", "id", "s", 1, "unique", lambda r: None)
        self.assertTrue(fatal)
        self.assertEqual(len(rows), 1)
        self.assertEqual(summary["skipped"], 9)
        self.assertEqual(summary["errors"], {"402": 1})

    async def test_cache_primer_excluded_but_logged(self):
        client = Client([chunk(answer="ok", finish="stop")])
        logged = []
        rows, summary, fatal = await b.run_stage(client, self.args(["--requests", "3", "--cache-wait", "0"]), "p", "id", "s", 1, "repeat", logged.append)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(logged), 4)
        self.assertEqual(logged[0]["phase"], "primer")
        self.assertEqual(len({r["prompt_sha256"] for r in logged}), 1)
        self.assertFalse(fatal)

    async def test_concurrency_and_unique_prefixes(self):
        active, peak = 0, 0
        original = b.one_request

        async def monitored(*args, **kwargs):
            nonlocal active, peak
            active += 1
            peak = max(active, peak)
            try:
                return await original(*args, **kwargs)
            finally:
                active -= 1
        b.one_request = monitored
        try:
            rows, summary, _ = await b.run_stage(Client([chunk(answer="a", finish="stop")]), self.args(["--requests", "9"]), "p", "id", "s", 3, "unique", lambda r: None)
        finally:
            b.one_request = original
        self.assertEqual(peak, 3)
        self.assertEqual(len(rows), 9)
        self.assertEqual(len({r["prompt_sha256"] for r in rows}), 9)
        self.assertEqual(summary["succeeded"], 9)

    def test_percentiles(self):
        self.assertEqual(b.percentile([1, 2, 3, 4, 5], .5), 3)
        self.assertAlmostEqual(b.percentile([1, 2, 3, 4, 5], .95), 4.8)
        self.assertIsNone(b.percentile([], .95))


class HTTPIntegration(unittest.TestCase):
    def test_real_sdk_sse_and_files(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if body["stream_options"] != {"include_usage": True}:
                    self.send_error(400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for delta, finish, usage in [({}, None, None), ({"content": "hello"}, None, None),
                                             ({"content": "world"}, None, None),
                                             ({}, "stop", {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110,
                                                           "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 100})]:
                    item = {"id": "local-test", "object": "chat.completion.chunk", "created": 1, "model": "mock",
                            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], "usage": usage}
                    self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as out:
                env = dict(os.environ, BENCH_OFFLINE_KEY="fake-local-only", NO_PROXY="127.0.0.1,localhost")
                result = subprocess.run([sys.executable, str(Path(b.__file__)), "--base-url", f"http://127.0.0.1:{server.server_port}/v1",
                                         "--api-key-env", "BENCH_OFFLINE_KEY", "--out", out, "--requests", "2"],
                                        env=env, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                folder = next(Path(out).iterdir())
                summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
                self.assertEqual(summary["stages"]["speed_c1"]["succeeded"], 2)
                self.assertTrue((folder / "requests.csv").exists())
                self.assertTrue((folder / "report.md").exists())
                for file in folder.iterdir():
                    self.assertNotIn("fake-local-only", file.read_text(encoding="utf-8-sig"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
