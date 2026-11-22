#!/usr/bin/env python3
# ============================================================
# self_check.py
# Purpose : Exercise NGINX socket policy against local synthetic services
# Feature : Phase 3 network hardening
# Role    : Disposable integration test
# API Doc : docs/implementation_plan.md, Phase 3
# ============================================================
from __future__ import annotations

import http.client
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

IMAGE = "nginx:1.30.7-alpine"
PYTHON_IMAGE = "python:3-alpine"
SYNTHETIC_KEY = "phase3-test-key"


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str) -> None:
        super().__init__("localhost", timeout=2)
        self.socket_path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").replace(SYNTHETIC_KEY, "[redacted]")
        raise RuntimeError(f"Command failed: {command[0]} (exit {result.returncode}): {error[-500:]}")


def render_template(template: str) -> str:
    rendered = template
    rendered = rendered.replace("https://openrouter.ai", "https://mock-upstream:8443")
    rendered = rendered.replace("https://api.openai.com", "https://mock-upstream:8443")
    rendered = rendered.replace("https://opencode.ai", "https://mock-upstream:8443")
    rendered = rendered.replace("http://ollama:11434", "http://mock-upstream:8080")
    rendered = rendered.replace("/etc/ssl/cert.pem", "/etc/nginx/test-ca.crt")
    return rendered


def request(socket_path: str, path: str, method: str = "POST") -> tuple[int, str]:
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request(
            method,
            path,
            headers={
                "Authorization": "Bearer caller-key",
                "api-key": "caller-api-key",
                "x-api-key": "caller-x-api-key",
                "Cookie": "session=caller-cookie",
                "X-Custom-Auth": "caller-custom-auth",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Host": "forged",
            },
            body=b"{}",
        )
        response = connection.getresponse()
        return response.status, response.read().decode("utf-8")
    finally:
        connection.close()


def request_redirect(socket_path: str) -> tuple[int, str | None]:
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request(
            "POST",
            "/openai/v1/chat/completions",
            headers={"X-Redirect": "yes"},
            body=b"redirect",
        )
        response = connection.getresponse()
        return response.status, response.getheader("Location")
    finally:
        connection.close()


def create_test_certs(directory: Path) -> Path:
    certs = directory / "certs"
    certs.mkdir(mode=0o700)
    ca_key, ca_cert = certs / "ca.key", certs / "ca.crt"
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(ca_key), "-out", str(ca_cert), "-subj", "/CN=SF Self Check CA",
         "-days", "1", "-addext", "basicConstraints=critical,CA:TRUE",
         "-addext", "keyUsage=critical,keyCertSign,cRLSign"])
    for name, san in (("valid", "DNS:api.openai.com,DNS:opencode.ai,DNS:openrouter.ai"),
                      ("wrong", "DNS:wrong.invalid")):
        key, csr, cert = certs / f"{name}.key", certs / f"{name}.csr", certs / f"{name}.crt"
        ext = certs / f"{name}.ext"
        ext.write_text(f"subjectAltName={san}\n", encoding="ascii")
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(key), "-out", str(csr), "-subj", f"/CN={name}.invalid"])
        run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca_cert),
             "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(cert),
             "-days", "1", "-extfile", str(ext)])
        for path in (key, csr, cert, ext):
            path.chmod(0o600)
    return certs


def check_provider_routes(socket_dir: Path) -> None:
    public_socket = str(socket_dir / "public.sock")
    status, body = request(public_socket, "/openrouter/api/v1/chat/completions")
    if status != 200 or f"Bearer {SYNTHETIC_KEY}" not in body:
        raise RuntimeError(f"OpenRouter route failed: status={status}, "
                           f"body={body.replace(SYNTHETIC_KEY, '[redacted]')}")
    assert "api-key=;x-api-key=;" in body
    assert "cookie=;custom=;" in body
    assert "type=application/json;accept=application/json;length=2;" in body
    assert "agent=software-factory-egress;" in body
    assert "host=openrouter.ai;" in body
    assert "path=/api/v1/chat/completions" in body
    status, body = request(public_socket, "/openai/v1/chat/completions")
    assert status == 200 and "authorization=Bearer phase3-openai-key" in body
    assert "path=/v1/chat/completions" in body
    status, body = request(public_socket, "/opencode-go/inference/go/chat/completions")
    assert status == 200 and "authorization=Bearer phase3-opencode-key" in body
    assert "path=/inference/go/chat/completions" in body
    status, _ = request(str(socket_dir / "tlsbad-public.sock"),
                        "/openrouter/api/v1/chat/completions")
    assert status == 502
    redirect_status, location = request_redirect(public_socket)
    if redirect_status != 302 or location is not None:
        raise RuntimeError(f"Redirect handling failed: status={redirect_status}, "
                           f"location={location}")


def check_local_and_path_policy(socket_dir: Path) -> None:
    public_socket = str(socket_dir / "public.sock")
    local_socket = str(socket_dir / "local.sock")
    status, _ = request(local_socket, "/openrouter/api/v1/chat/completions")
    assert status == 403
    status, body = request(local_socket, "/ollama-local/v1/chat/completions")
    assert status == 200 and "authorization=;" in body
    assert "path=/v1/chat/completions" in body

    status, _ = request(public_socket, "/openrouter/api/v1/files")
    assert status == 404
    status, _ = request(public_socket, "/openrouter/api/v1/chat/completions-extra")
    assert status == 404
    status, _ = request(public_socket, "/openrouter/api/v1/chat/completions/../files")
    assert status == 404
    status, _ = request(public_socket, "/openrouter/api/v1/chat/completions?url=http://evil")
    assert status == 400
    status, _ = request(
        public_socket,
        "http://evil/openrouter/api/v1/chat/completions",
    )
    assert status == 200
    status, _ = request(public_socket, "/openrouter/api/v1/chat/completions", method="GET")
    assert status == 405
    status, _ = request(
        public_socket,
        "/openrouter/api/v1/chat/completions",
        method="CONNECT",
    )
    assert status >= 400


def check_rate_limit(public_socket: str) -> None:
    rate_limited = sum(
        request(public_socket, "/openrouter/api/v1/chat/completions")[0] == 429
        for _ in range(30)
    )
    assert rate_limited > 0


def run_checks(socket_dir: Path) -> None:
    public_socket = str(socket_dir / "public.sock")
    check_provider_routes(socket_dir)
    check_local_and_path_policy(socket_dir)
    check_rate_limit(public_socket)
    print("NGINX egress self-check passed: route, privacy, method, traversal and rate checks")


def run_client(volume: str, script: Path, containers: tuple[str, str]) -> None:
    proxy, mock = containers
    uid, gid = os.getuid(), os.getgid()
    command = [
        "docker", "run", "--rm", "--network", "none", "--user", f"{uid}:{gid}",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--mount", f"type=volume,src={volume},dst=/run/factory,readonly",
        "--mount", f"type=bind,src={script},dst=/workspace/self_check.py,readonly",
        "--entrypoint", "python3", "python:3-alpine", "/workspace/self_check.py", "--client",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        error = result.stderr.replace(SYNTHETIC_KEY, "[redacted]")
        logs = subprocess.run(["docker", "logs", proxy], capture_output=True,
                              text=True, check=False).stderr
        mock_logs = subprocess.run(["docker", "logs", mock], capture_output=True,
                                   text=True, check=False).stderr
        raise RuntimeError(f"The isolated policy client failed: {error[-800:]} "
                           f"proxy={logs[-300:]} mock={mock_logs[-300:]}")
    print(result.stdout.strip())


def run_agent_check(volume: str) -> None:
    image = os.environ.get("FACTORY_EGRESS_AGENT_CHECK_IMAGE")
    if not image:
        return
    uid, gid = os.getuid(), os.getgid()
    command = [
        "docker", "run", "--rm", "--network", "none", "--user", f"{uid}:{gid}",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
        "--security-opt", "systempaths=unconfined",
        "--memory", "2g", "--cpus", "1", "--pids-limit", "256",
        "--tmpfs", f"/tmp:rw,nosuid,nodev,size=256m,uid={uid},gid={gid}",
        "--mount", f"type=volume,src={volume},dst=/run/factory,readonly", image,
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        error = result.stderr.replace(SYNTHETIC_KEY, "[redacted]")
        output = result.stdout.replace(SYNTHETIC_KEY, "[redacted]")
        raise RuntimeError(
            f"The isolated agent check failed (exit {result.returncode}): "
            f"stdout={output[-1200:]} stderr={error[-1200:]}"
        )
    print(result.stdout.strip())


def check_invalid_key(entrypoint: Path) -> None:
    probe = 'fake";\nmalicious'
    command = [
        "docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--env", f"OPENROUTER_API_KEY={probe}",
        "--mount", f"type=bind,src={entrypoint},dst=/tmp/entrypoint.sh,readonly",
        "--entrypoint", "/bin/sh", IMAGE, "/tmp/entrypoint.sh", "nginx", "-v",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode == 0 or probe in result.stdout + result.stderr:
        raise RuntimeError("Unsafe proxy key input was accepted or echoed")


def wait_for_sockets() -> Path:
    socket_dir = Path("/run/factory")
    for _ in range(50):
        try:
            public_status, _ = request(str(socket_dir / "public.sock"), "/healthz")
            local_status, _ = request(str(socket_dir / "local.sock"), "/healthz")
            if public_status == 204 and local_status == 204:
                return socket_dir
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    raise RuntimeError("Proxy sockets did not become ready")


def prepare_config(root: Path, source_dir: Path) -> Path:
    config_dir = root / "config"
    config_dir.mkdir(mode=0o700, parents=True)
    template = (source_dir / "nginx.conf").read_text(encoding="utf-8")
    headers = (source_dir / "proxy-llm-headers.conf.template").read_text(encoding="utf-8")
    config = config_dir / "nginx.conf.template"
    config.write_text(render_template(template), encoding="utf-8")
    config.chmod(0o600)
    headers_path = config_dir / "proxy-llm-headers.conf.template"
    headers_path.write_text(headers, encoding="utf-8")
    headers_path.chmod(0o600)
    return config_dir


def prepare_volume(volume: str) -> None:
    uid, gid = os.getuid(), os.getgid()
    run(
        [
            "docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
            "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--mount",
            f"type=volume,src={volume},dst=/run/factory", "--entrypoint", "sh",
            "alpine:latest", "-ec", f"chown {uid}:{gid} /run/factory; chmod 0700 /run/factory",
        ]
    )


def start_mock(name: str, network: str, fixtures: tuple[Path, Path]) -> None:
    script, certs = fixtures
    uid, gid = os.getuid(), os.getgid()
    run(
        [
            "docker", "run", "--detach", "--name", name, "--network", network,
            "--network-alias", "mock-upstream", "--user", f"{uid}:{gid}",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64",
            "--tmpfs", f"/tmp:rw,nosuid,nodev,noexec,uid={uid},gid={gid},mode=0700",
            "--mount", f"type=bind,src={script},dst=/mock_upstream.py,readonly",
            "--mount", f"type=bind,src={certs},dst=/certs,readonly",
            "--entrypoint", "python3", PYTHON_IMAGE, "/mock_upstream.py", "/certs",
        ]
    )


def start_proxy(name: str, network: str, mounts: list[str]) -> None:
    uid, gid = os.getuid(), os.getgid()
    run(
        [
            "docker", "run", "--detach", "--name", name, "--network", network,
            "--user", f"{uid}:{gid}", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.5",
            "--pids-limit", "64", "--tmpfs",
            f"/tmp:rw,nosuid,nodev,noexec,uid={uid},gid={gid},mode=0700",
            "--tmpfs", f"/etc/nginx/conf.d:rw,nosuid,nodev,noexec,uid={uid},gid={gid},mode=0700",
            "--env", "NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/templates",
            "--env", "NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx",
            "--env", "NGINX_ENVSUBST_FILTER=^(OPENROUTER_API_KEY|OPENAI_API_KEY|OPENCODE_API_KEY)$",
            "--env", f"OPENROUTER_API_KEY={SYNTHETIC_KEY}",
            "--env", "OPENAI_API_KEY=phase3-openai-key",
            "--env", "OPENCODE_API_KEY=phase3-opencode-key",
            "--env", "NGINX_ENTRYPOINT_QUIET_LOGS=1", *mounts,
            "--entrypoint", "/bin/sh", IMAGE, "/etc/nginx/entrypoint.sh", "nginx",
            "-c", "/tmp/nginx/nginx.conf", "-g", "daemon off;",
        ]
    )


def cleanup(containers: tuple[str, ...], network: str, volume: str) -> None:
    subprocess.run(["docker", "rm", "--force", *containers], capture_output=True)
    subprocess.run(["docker", "network", "rm", network], capture_output=True)
    subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


@dataclass(frozen=True)
class TestFixture:
    network: str
    mock_name: str
    proxy_name: str
    tlsbad_name: str
    volume: str
    config_dir: Path
    tlsbad_dir: Path
    certs: Path
    entrypoint: Path
    source_dir: Path


def create_fixture(root: Path, source_dir: Path, entrypoint: Path) -> TestFixture:
    suffix = secrets.token_hex(4)
    config_dir = prepare_config(root / "main", source_dir)
    tlsbad_dir = prepare_config(root / "tlsbad", source_dir)
    tlsbad_template = tlsbad_dir / "nginx.conf.template"
    tlsbad_template.write_text(
        tlsbad_template.read_text(encoding="utf-8")
        .replace("https://mock-upstream:8443", "https://mock-upstream:8444")
        .replace("/run/factory/public.sock", "/run/factory/tlsbad-public.sock")
        .replace("/run/factory/local.sock", "/run/factory/tlsbad-local.sock"),
        encoding="utf-8",
    )
    return TestFixture(
        network=f"sf-egress-check-{suffix}",
        mock_name=f"sf-egress-mock-{suffix}",
        proxy_name=f"sf-egress-proxy-{suffix}",
        tlsbad_name=f"sf-egress-tlsbad-{suffix}",
        volume=f"sf-egress-sockets-{suffix}",
        config_dir=config_dir,
        tlsbad_dir=tlsbad_dir,
        certs=create_test_certs(root),
        entrypoint=entrypoint.resolve(),
        source_dir=source_dir,
    )


def start_proxy_config(fixture: TestFixture, name: str, config_dir: Path) -> None:
    mounts = [
        "--mount", f"type=volume,src={fixture.volume},dst=/run/factory",
        "--mount", f"type=bind,src={config_dir},dst=/etc/nginx/templates,readonly",
        "--mount",
        f"type=bind,src={fixture.entrypoint},dst=/etc/nginx/entrypoint.sh,readonly",
        "--mount",
        f"type=bind,src={fixture.certs / 'ca.crt'},dst=/etc/nginx/test-ca.crt,readonly",
    ]
    start_proxy(name, fixture.network, mounts)


def start_fixture(fixture: TestFixture) -> None:
    run(["docker", "network", "create", "--internal", fixture.network])
    run(["docker", "volume", "create", fixture.volume])
    prepare_volume(fixture.volume)
    start_mock(
        fixture.mock_name,
        fixture.network,
        (fixture.source_dir / "mock_upstream.py", fixture.certs),
    )
    start_proxy_config(fixture, fixture.proxy_name, fixture.config_dir)
    start_proxy_config(fixture, fixture.tlsbad_name, fixture.tlsbad_dir)


def execute_fixture(fixture: TestFixture) -> None:
    try:
        start_fixture(fixture)
        run_client(
            fixture.volume,
            Path(__file__).resolve(),
            (fixture.proxy_name, fixture.mock_name),
        )
        run_agent_check(fixture.volume)
    finally:
        cleanup(
            (fixture.mock_name, fixture.proxy_name, fixture.tlsbad_name),
            fixture.network,
            fixture.volume,
        )


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--client":
        run_checks(wait_for_sockets())
        return

    if shutil.which("docker") is None:
        raise RuntimeError("Docker CLI is required")
    for image in (IMAGE, PYTHON_IMAGE, "alpine:latest"):
        run(["docker", "image", "inspect", image])
    source_dir = Path(__file__).parent
    if len(sys.argv) != 1:
        raise RuntimeError("The NGINX self-check accepts no arguments")
    entrypoint_path = source_dir / "entrypoint.sh"

    check_invalid_key(entrypoint_path.resolve())

    with tempfile.TemporaryDirectory(prefix="software-factory-egress-") as temporary:
        fixture = create_fixture(Path(temporary), source_dir, entrypoint_path)
        execute_fixture(fixture)


if __name__ == "__main__":
    main()
