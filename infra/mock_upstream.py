# ============================================================
# mock_upstream.py
# Purpose : Serve synthetic HTTP and TLS provider responses for NGINX checks
# Feature : Phase 3 network hardening
# Role    : Disposable integration-test upstream
# API Doc : OpenAI-compatible chat completions
# ============================================================
from __future__ import annotations

import json
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional


class UpstreamHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if body == b"redirect":
            self.send_response(302)
            self.send_header("Location", "https://outside.invalid/")
            self.end_headers()
            return

        observation = self.observation(length)
        request_body = json.loads(body or b"{}")
        if request_body.get("stream") is True:
            self.send_stream(observation)
            return
        self.send_json(observation)

    def observation(self, length: int) -> str:
        fields = (
            ("authorization", self.headers.get("Authorization", "")),
            ("api-key", self.headers.get("api-key", "")),
            ("x-api-key", self.headers.get("x-api-key", "")),
            ("cookie", self.headers.get("Cookie", "")),
            ("custom", self.headers.get("X-Custom-Auth", "")),
            ("type", self.headers.get("Content-Type", "")),
            ("accept", self.headers.get("Accept", "")),
            ("length", str(length)),
            ("agent", self.headers.get("User-Agent", "")),
            ("host", self.headers.get("Host", "")),
            ("path", self.path),
        )
        return ";".join(f"{key}={value}" for key, value in fields)

    def send_json(self, observation: str) -> None:
        response = {
            "id": "synthetic",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "synthetic response"},
                "finish_reason": "stop",
            }],
            "observation": observation,
        }
        self.send_body(json.dumps(response).encode(), "application/json")

    def send_stream(self, observation: str) -> None:
        data = {
            "id": "synthetic",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "synthetic",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "synthetic response"},
                "finish_reason": None,
            }],
            "observation": observation,
        }
        final = {**data, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        chunks = [
            f"data: {json.dumps(data)}\n\n",
            f"data: {json.dumps(final)}\n\n",
            "data: [DONE]\n\n",
        ]
        self.send_body("".join(chunks).encode(), "text/event-stream")

    def send_body(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def create_server(port: int, cert: Optional[str], key: Optional[str]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), UpstreamHandler)
    if cert and key:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def main() -> None:
    cert_dir = sys.argv[1]
    servers = [
        create_server(8080, None, None),
        create_server(8443, f"{cert_dir}/valid.crt", f"{cert_dir}/valid.key"),
        create_server(8444, f"{cert_dir}/wrong.crt", f"{cert_dir}/wrong.key"),
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


if __name__ == "__main__":
    main()
