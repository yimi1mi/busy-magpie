"""Four concurrent agents for checking the multi-agent card.

    python tools/mock_multi.py 3500
    BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

START = time.time()
SEQ = 0
ACCOUNTS = [
    ("codex", "openai", "OpenAI", "openai", "account", "jonny.hong91@gmail.com", "gpt-6-astra", "xhigh"),
    ("dsh", "team", "team", "generic", "provider", "", "deepseek-v4-flash", "low"),
    ("claude", "anthropic", "Anthropic", "anthropic", "account", "work@example.com", "claude-sonnet-4-5", "high"),
    ("cursor", "openrouter", "OpenRouter", "openrouter", "key", "sk-or-v1-abcdefghijklmnop", "qwen3-coder", ""),
]


def make_route(index: int, seq: int) -> dict:
    agent, provider, name, icon, kind, who, model, effort = ACCOUNTS[index]
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    order = {
        "id": provider,
        "provider": provider,
        "name": name,
        "icon": icon,
        "kind": kind,
        "agent": agent,
        "model": model,
        "routing": "",
        "used": 0,
    }
    if who:
        order["who"] = who
        order["plan"] = "pro" if provider == "openai" else ""
    route = {
        "seq": seq,
        "id": 1792464002000 + index,
        "time": stamp,
        "agent": agent,
        "model": model,
        "effort": effort,
        "provider": provider,
        "order": [order],
        "tries": [
            {
                "id": provider,
                "model": model,
                "effort": effort,
                "start": stamp,
                "done": False,
            }
        ],
        "done": False,
    }
    return route


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
        if int(q.get("after", ["0"])[0]) and "wait" in q:
            time.sleep(2.5)
        SEQ += 1
        count = min(int(os.environ.get("MOCK_COUNT", len(ACCOUNTS))), len(ACCOUNTS))
        payload = {
            "object": "trace",
            "now": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            "seq": SEQ,
            "pid": 4242,
            "serves": "app",
            "totals": {"requests": 301, "rerouted": 2, "errors": 1},
            "routes": [make_route(i, SEQ) for i in range(count)],
        }
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3500
    print(f"mock multi trace on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
