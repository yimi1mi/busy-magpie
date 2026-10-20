"""A tiny stand-in for magpie's local routing trace.

Useful for checking the widget without sending real requests:

    python tools/mock_trace.py 3499
    $env:BUSY_MAGPIE_GATEWAY='http://127.0.0.1:3499'
    .\\bin\\Debug\\net10.0-windows\\BusyMagpie.exe

It alternates a long in-flight OpenAI request with a finished one, using the
same field names as GET /v1/magpie/trace.
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


START = time.time()
SEQ = 0
TOTAL = 224


def route(seq: int, elapsed: float) -> dict:
    phase = elapsed % 18.0
    in_flight = phase < 12.0
    if not in_flight:
        return {
            "seq": seq,
            "id": 1792464001969,
            "time": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            "agent": "codex",
            "session": "01a1546e-3108-7473-8dc6-cac5a0121412",
            "model": "gpt-6-astra",
            "effort": "xhigh",
            "provider": "openai",
            "order": [
                {
                    "id": "codex",
                    "provider": "openai",
                    "name": "OpenAI",
                    "icon": "openai",
                    "who": "jonny.hong91@gmail.com",
                    "kind": "account",
                    "agent": "codex",
                    "plan": "pro",
                    "model": "gpt-6-astra",
                    "routing": "",
                    "used": 0,
                }
            ],
            "tries": [
                {
                    "id": "codex",
                    "model": "gpt-6-astra",
                    "effort": "xhigh",
                    "start": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
                    "done": True,
                    "status": 200,
                    "ms": 23614,
                    "ttft": 20814,
                    "served": "gpt-6-astra",
                }
            ],
            "done": True,
            "status": 200,
            "ms": 23614,
            "tokens": 229924,
            "out": 410,
            "served": "gpt-6-astra",
        }

    return {
        "seq": seq,
        "id": 1792464001969,
        "time": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "agent": "codex",
        "session": "01a1546e-3108-7473-8dc6-cac5a0121412",
        "model": "gpt-6-astra",
        "effort": "xhigh",
        "provider": "openai",
        "order": [
            {
                "id": "codex",
                "provider": "openai",
                "name": "OpenAI",
                "icon": "openai",
                "who": "jonny.hong91@gmail.com",
                "kind": "account",
                "agent": "codex",
                "plan": "pro",
                "model": "gpt-6-astra",
                "routing": "",
                "used": 0,
            }
        ],
        "tries": [
            {
                "id": "codex",
                "model": "gpt-6-astra",
                "effort": "xhigh",
                "start": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
                "done": False,
            }
        ],
        "done": False,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        global SEQ
        parsed = urlparse(self.path)
        if parsed.path not in ("/v1/magpie/trace", "/"):
            self.send_error(404)
            return

        q = parse_qs(parsed.query)
        after = int(q.get("after", ["0"])[0])
        if after and "wait" in q:
            time.sleep(2.5)
        SEQ += 1
        elapsed = time.time() - START
        payload = {
            "object": "trace",
            "now": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            "seq": SEQ,
            "pid": 4242,
            "serves": "app",
            "totals": {"requests": TOTAL, "rerouted": 0, "errors": 0},
            "routes": [route(SEQ, elapsed)],
        }
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3499
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock trace on http://127.0.0.1:{port}/v1/magpie/trace", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
