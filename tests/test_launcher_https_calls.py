"""Built-in HTTPS and calls by the launcher (#1471, founder decisions 3 and 4).

The real `./flux` runs in a temporary checkout against a stand-in `docker` that records each call (and the values the launcher exports
for Compose), so the checks need no Docker: an https origin layers docker/compose.https.yaml with the origin's port, a proxy address of
the owner's own layers nothing, and FLUX_CALLS=on layers docker/compose.live.yaml on every command, writes the LiveKit key and secret once
and takes the media name and address from the origin. Where the real Docker Compose is installed, the launcher's own arguments are
rendered with it: Caddy proxies the origin to the API, and the API trusts exactly Caddy's address. Standard library only.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_ENV = "POSTGRES_PASSWORD=pw\nFLUX_FIXTURE_TOKEN=fixture\nFLUX_AUTH_SECRET=secret\nFLUX_PROJECT=flux-https-calls-test\n"
PINNED = re.compile(r"caddy:[0-9.]+@sha256:[0-9a-f]{64}\Z")
DOCKER = shutil.which("docker")


def has_compose() -> bool:
    if not DOCKER:
        return False
    try:
        return subprocess.run([DOCKER, "compose", "version"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class LauncherHttpsCallsTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="flux-https-calls-")
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.checkout = self.base / "checkout"
        (self.checkout / "docker").mkdir(parents=True)
        shutil.copy2(ROOT / "flux", self.checkout / "flux")
        (self.checkout / "docker" / "caddy").mkdir()
        shutil.copy2(ROOT / "docker" / "caddy" / "Caddyfile", self.checkout / "docker" / "caddy" / "Caddyfile")
        for name in ("compose.source.yaml", "compose.https.yaml", "compose.live.yaml", "compose.source.runtime.yaml", "compose.embeddings.yaml",
                     "background-key-unavailable", "oidc-client-secret-unavailable"):
            shutil.copy2(ROOT / "docker" / name, self.checkout / "docker" / name)
        self.env_file = self.checkout / "docker" / ".env"
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.log = self.base / "docker-calls"
        self.stub("docker", 'printf "%s\\n" "$*" >> "$FLUX_TEST_LOG"\n'
                  'printf "EXPORTED https_port=%s https_host=%s domain=%s\\n" "${FLUX_HTTPS_PORT-}" "${FLUX_HTTPS_HOST-}" "${FLUX_LIVEKIT_DOMAIN-}" >> "$FLUX_TEST_LOG"\nexit 0\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        self.env.update(PATH=f"{self.bin}:{os.environ['PATH']}", FLUX_TEST_LOG=str(self.log))

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        path.chmod(0o755)

    def write_env(self, extra: str) -> None:
        self.env_file.write_text(BASE_ENV + extra, encoding="utf-8")
        self.env_file.chmod(0o600)

    def logs(self) -> subprocess.CompletedProcess[str]:
        """`./flux logs`: one Compose command, with every overlay the settings ask for."""
        if self.log.exists():
            self.log.unlink()
        return subprocess.run([str(self.checkout / "flux"), "logs"], cwd=self.base, env=self.env, capture_output=True, text=True, timeout=20)

    def up(self) -> subprocess.CompletedProcess[str]:
        """`./flux up` against the stand-in docker: the first command that makes the call settings (with the DNS check)."""
        return subprocess.run([str(self.checkout / "flux"), "up"], cwd=self.base, env=self.env, capture_output=True, text=True, timeout=60,
                              stdin=subprocess.DEVNULL)

    def compose_call(self) -> tuple[list[str], str]:
        lines = self.log.read_text(encoding="utf-8").splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith("--log-level error compose "))
        return lines[index].split(" "), lines[index + 1]

    def env_values(self) -> dict[str, str]:
        return dict(line.split("=", 1) for line in self.env_file.read_text(encoding="utf-8").splitlines() if "=" in line)

    # --- 3. Built-in HTTPS

    def test_an_https_origin_layers_the_bundled_proxy_with_the_origins_port(self) -> None:
        for origin, host, port in (("https://flux.example.org", "flux.example.org", "443"), ("https://flux.example.org:8443", "flux.example.org", "8443"),
                                   ("https://[2001:db8::1]:9443", "2001:db8::1", "9443")):
            with self.subTest(origin=origin):
                self.write_env(f"FLUX_PUBLIC_ORIGIN={origin}\nFLUX_TRUSTED_PROXIES=\n")
                result = self.logs()
                self.assertEqual(result.returncode, 0, result.stderr)
                args, exported = self.compose_call()
                self.assertIn(str(self.checkout / "docker" / "compose.https.yaml"), args)
                self.assertIn(f"https_port={port} ", exported)
                self.assertIn(f"https_host={host} ", exported)

    def test_a_proxy_of_the_owners_own_or_a_loopback_http_origin_bundles_nothing(self) -> None:
        for extra in ("FLUX_PUBLIC_ORIGIN=https://flux.example.org\nFLUX_TRUSTED_PROXIES=172.27.0.1/32\n",
                      "FLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\nFLUX_TRUSTED_PROXIES=\n"):
            with self.subTest(extra=extra):
                self.write_env(extra)
                result = self.logs()
                self.assertEqual(result.returncode, 0, result.stderr)
                args, _ = self.compose_call()
                self.assertFalse([a for a in args if a.endswith("compose.https.yaml")], args)
                self.assertFalse([a for a in args if a.endswith("compose.live.yaml")], args)

    @unittest.skipUnless(has_compose(), "Docker Compose is not installed")
    def test_compose_renders_caddy_for_the_origin_and_the_api_trusting_exactly_its_address(self) -> None:
        self.write_env("FLUX_PUBLIC_ORIGIN=https://flux.example.org:8443\nFLUX_TRUSTED_PROXIES=\n")
        self.assertEqual(self.logs().returncode, 0)
        args, _ = self.compose_call()
        rendered = subprocess.run([str(DOCKER), *args[:args.index("logs")], "config", "--format", "json"], capture_output=True, text=True,
                                  timeout=60, env={**self.env, "FLUX_HTTPS_PORT": "8443", "FLUX_HTTPS_HOST": "flux.example.org"})
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        config = json.loads(rendered.stdout)
        proxy, api = config["services"]["proxy"], config["services"]["api"]
        self.assertRegex(proxy["image"], PINNED)
        self.assertIsNone(proxy.get("command"), "the image's own command runs docker/caddy/Caddyfile")
        self.assertEqual((proxy["environment"]["FLUX_PUBLIC_ORIGIN"], proxy["environment"]["FLUX_HTTPS_HOST"]), ("https://flux.example.org:8443", "flux.example.org"))
        caddyfile = (ROOT / "docker" / "caddy" / "Caddyfile").read_text(encoding="utf-8")
        self.assertIn("{$FLUX_PUBLIC_ORIGIN} {\n\treverse_proxy api:8080\n}", caddyfile)
        self.assertIn("default_sni {$FLUX_HTTPS_HOST}", caddyfile)
        self.assertIn("admin off", caddyfile)
        self.assertEqual(sorted((p["published"], p["target"], p["protocol"]) for p in proxy["ports"]),
                         [("80", 80, "tcp"), ("8443", 8443, "tcp"), ("8443", 8443, "udp")])
        self.assertEqual(list(proxy["networks"]), ["edge"])
        self.assertEqual({v["target"]: v["type"] for v in proxy["volumes"]},
                         {"/etc/caddy/Caddyfile": "bind", "/data": "volume", "/config": "volume"}, "certificates persist in volumes")
        self.assertEqual((proxy["cap_drop"], proxy["cap_add"]), (["ALL"], ["NET_BIND_SERVICE"]))
        self.assertEqual(proxy["healthcheck"]["test"], ["CMD", "nc", "-z", "127.0.0.1", "8443"])
        self.assertIn("edge", api["networks"])
        self.assertEqual(api["ports"][0]["host_ip"], "127.0.0.1", "the API port stays on loopback")
        self.assertEqual(api["depends_on"]["proxy"], {"condition": "service_healthy", "restart": True, "required": True})
        # The API's start: the address of `proxy` on `edge`, as /32, then the image's own command. Run it with stand-ins.
        script = api["command"][2].replace("$$", "$")
        fake = self.base / "fake"
        fake.mkdir()
        (fake / "getent").write_text('#!/bin/sh\n[ "$1 $2" = "ahostsv4 proxy" ] && printf "172.30.5.3      STREAM proxy\\n172.30.5.3      DGRAM\\n"\n')
        (fake / "node").write_text('#!/bin/sh\nprintf "%s|%s\\n" "$FLUX_TRUSTED_PROXIES" "$*"\n')
        for name in ("getent", "node"):
            (fake / name).chmod(0o755)
        started = subprocess.run(["sh", "-ec", script], capture_output=True, text=True, timeout=10,
                                 env={"PATH": f"{fake}:{os.environ['PATH']}", "FLUX_TRUSTED_PROXIES": ""})
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertEqual(started.stdout.strip(), "172.30.5.3/32|apps/server/dist/index.js")
        dockerfile = (ROOT / "docker" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn('CMD ["node", "apps/server/dist/index.js"]', dockerfile, "the wrapper runs the image's own API command")

    # --- 4. Calls with one switch

    def test_calls_on_layers_the_media_server_and_writes_its_settings_once(self) -> None:
        self.write_env("FLUX_PUBLIC_ORIGIN=https://203.0.113.20\nFLUX_CALLS=on\n")
        self.up()
        result = self.logs()
        self.assertEqual(result.returncode, 0, result.stderr)
        args, exported = self.compose_call()
        self.assertIn(str(self.checkout / "docker" / "compose.live.yaml"), args)
        self.assertIn("domain=203.0.113.20", exported)
        first = self.env_values()
        self.assertRegex(first["FLUX_LIVEKIT_API_KEY"], r"^flux[0-9a-f]{16}$")
        self.assertRegex(first["FLUX_LIVEKIT_API_SECRET"], r"^[0-9a-f]{64}$")
        self.assertEqual(first["FLUX_LIVEKIT_PUBLIC_IP"], "203.0.113.20")
        self.assertEqual(oct(self.env_file.stat().st_mode & 0o777), "0o600", "the file stays private")
        self.assertEqual(self.logs().returncode, 0)
        self.assertEqual(self.env_values(), first, "a second command changes nothing")

    def test_the_media_address_is_what_the_origins_name_resolves_to(self) -> None:
        self.stub("getent", '[ "$1 $2" = "ahostsv4 flux.example.org" ] && printf "198.51.100.7    STREAM flux.example.org\\n"\n')
        self.write_env("FLUX_PUBLIC_ORIGIN=https://flux.example.org\nFLUX_CALLS=on\n")
        self.up()
        result = self.logs()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_values()["FLUX_LIVEKIT_PUBLIC_IP"], "198.51.100.7")
        self.assertIn("domain=flux.example.org", self.compose_call()[1])

    def test_a_name_without_an_address_or_resolving_to_loopback_stops_with_the_fix(self) -> None:
        for answer, message in (("", "has no IPv4 address"), ("127.0.1.1    STREAM flux.example.org", "/etc/hosts")):
            with self.subTest(answer=answer):
                self.stub("getent", f'printf "%s" "{answer}"\n')
                self.write_env("FLUX_PUBLIC_ORIGIN=https://flux.example.org\nFLUX_CALLS=on\n")
                result = self.up()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn("FLUX_LIVEKIT_PUBLIC_IP", self.env_file.read_text(encoding="utf-8"))
                # Only the commands that start Flux stop at the DNS check: logs, down and clean go on without a record (#1471 review).
                for command in ("logs", "down"):
                    other = subprocess.run([str(self.checkout / "flux"), command], cwd=self.base, env=self.env, capture_output=True,
                                           text=True, timeout=20)
                    self.assertEqual(other.returncode, 0, f"{command}: {other.stderr}")
                    self.assertNotIn("FLUX_LIVEKIT_PUBLIC_IP", self.env_file.read_text(encoding="utf-8"))

    def test_a_loopback_origin_uses_the_loopback_address(self) -> None:
        self.write_env("FLUX_PUBLIC_ORIGIN=http://localhost:8081\nFLUX_CALLS=on\n")
        self.up()
        self.assertEqual(self.env_values()["FLUX_LIVEKIT_PUBLIC_IP"], "127.0.0.1")

    def test_calls_off_layers_no_media_server_and_clean_still_knows_every_overlay(self) -> None:
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn('calls_on() { [ "$(env_value FLUX_CALLS)" = on ]; }', launcher)
        self.assertIn('if calls_on; then calls_env; set -- -f "$COMPOSE_LIVE" "$@"; fi', launcher)
        start = launcher[launcher.index("start_main() {"):]
        start = start[:start.index("\n}\n")]
        self.assertIn('https_on || remove_when_off proxy', start)
        self.assertIn('calls_on || remove_when_off livekit', start)
        clean = launcher[launcher.index("compose_main_all() ("):]
        clean = clean[:clean.index("\n)\n")]
        self.assertIn('https_on || set -- -f "$COMPOSE_HTTPS"', clean)
        self.assertIn('set -- -f "$COMPOSE_LIVE"', clean)
        env_example = (ROOT / "docker" / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(env_example, r"(?m)^FLUX_CALLS=off$")


if __name__ == "__main__":
    unittest.main()
