"""F-030 (#655, S1): every Compose file that runs `api` has the keyring, or turns it off explicitly, and the
launcher gives every install a keyring token (docs/product/encrypted-workspaces.md#the-keyring-appskeyring)."""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ROOT / "docker"
# Overlays that only adjust an `api` defined by a base file; the base must carry the keyring.
OVERLAY_BASES = {
    "compose.dev.yaml": "compose.source.yaml",
    "compose.test.yaml": "compose.source.yaml",
    "compose.live.yaml": "compose.source.yaml",
    "compose.live.test.yaml": "compose.source.yaml",
    "compose.live-editing.test.yaml": "compose.source.yaml",
    "compose.oidc.test.yaml": "compose.source.yaml",
    "compose.perf.yaml": "compose.source.yaml",
    "compose.runtime.yaml": "compose.yaml",
    "compose.source.runtime.yaml": "compose.source.yaml",
    "compose.encryption.test.yaml": "compose.source.yaml",
}


def services(text: str) -> dict[str, str]:
    """Top-level services and their blocks (two-space service headers under `services:`)."""
    blocks: dict[str, list[str]] = {}
    inside = False
    current = None
    for line in text.splitlines():
        if re.match(r"^\S", line):
            inside = line.startswith("services:")
            current = None
            continue
        if not inside:
            continue
        header = re.match(r"^  ([A-Za-z0-9_-]+):\s*(?:&\S+)?\s*$", line)
        if header:
            current = header.group(1)
            blocks[current] = []
        elif current:
            blocks[current].append(line)
    return {name: "\n".join(lines) for name, lines in blocks.items()}


class ComposeKeyringTest(unittest.TestCase):
    def test_every_compose_file_with_api_has_the_keyring_or_turns_it_off(self) -> None:
        files = sorted(DOCKER.glob("compose*.yaml"))
        self.assertTrue(files)
        checked = 0
        for path in files:
            found = services(path.read_text(encoding="utf-8"))
            if "api" not in found:
                continue
            checked += 1
            api = found["api"]
            off = re.search(r"FLUX_KEYRING:\s*\"?off\"?", api)
            if off:
                continue
            if path.name in OVERLAY_BASES:
                base = OVERLAY_BASES[path.name]
                self.assertFalse(re.search(r"^    (build|extends):", api, re.M), f"{path.name}: listed as an overlay but defines api")
                self.assertIn("keyring", services((DOCKER / base).read_text(encoding="utf-8")), f"{path.name}: base {base} has no keyring")
                # Compose merges an overlay's service networks with the base's; only !reset or !override would drop keyring.
                self.assertNotRegex(api, r"networks:\s*!(reset|override)", f"{path.name}: an overlay must not replace api's networks")
                continue
            self.assertIn("keyring", found, f"{path.name}: api without the keyring service or FLUX_KEYRING: off")
            self.assertRegex(api, r"networks: \[[^\]]*\bkeyring\b", f"{path.name}: api is not on the keyring network")
        self.assertGreaterEqual(checked, 8)

    def test_keyring_is_hardened_and_alone_on_an_internal_network(self) -> None:
        for name in ("compose.source.yaml", "compose.yaml"):
            text = (DOCKER / name).read_text(encoding="utf-8")
            keyring = services(text)["keyring"]
            for setting in ("read_only: true", "cap_drop: [ALL]", "core: 0", "networks: [keyring]", "apps/keyring/dist/main.js"):
                self.assertIn(setting, keyring, f"{name}: keyring lacks {setting}")
            self.assertRegex(keyring, r"mem_limit: \$\{FLUX_KEYRING_MEMORY:-128m\}\n    memswap_limit: \$\{FLUX_KEYRING_MEMORY:-128m\}")
            self.assertNotIn("volumes:", keyring, f"{name}: the keyring has no volume")
            self.assertNotIn("ports:", keyring)
            self.assertRegex(text, r"(?m)^  keyring:\n    internal: true", f"{name}: the keyring network is internal")
            members = [service for service, block in services(text).items() if re.search(r"networks:[^\n]*\bkeyring\b", block)]
            self.assertEqual(sorted(members), ["api", "keyring", "worker"], f"{name}: only api, worker and keyring join it")
            for service, variable, default in (("api", "FLUX_API_MEMORY", "2g"), ("worker", "FLUX_WORKER_MEMORY", "1g")):
                block = services(text)[service]
                self.assertIn(f"mem_limit: ${{{variable}:-{default}}}\n    memswap_limit: ${{{variable}:-{default}}}", block, f"{name}: {service}")
                self.assertIn("core: 0", block)
                self.assertIn("FLUX_KEYRING_TOKEN: ${FLUX_KEYRING_TOKEN:-}", block)
                # F-030 S2c: the key pin's secret reaches the processes that verify holders, never the keyring.
                self.assertIn("FLUX_KEY_PIN_SECRET: ${FLUX_KEY_PIN_SECRET:-}", block)
                # OpenSSL's Argon2 allocates its memory from the secure heap when one is set (observed 2026-10-23), so
                # the processes that derive KEKs run without it; only the keyring does.
                self.assertNotIn("--secure-heap", block)
            self.assertIn("NODE_OPTIONS: --secure-heap=65536", services(text)["keyring"])
            self.assertNotIn("FLUX_KEY_PIN_SECRET", services(text)["keyring"])

    def test_flux_generates_the_keyring_token_and_pin_secret(self) -> None:
        # Every docker/.env comes from ./flux up (no pre-F-030 installations exist, #779), so up writes both.
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn('set_env_line "$draft" FLUX_KEYRING_TOKEN "$(random_b64url)"', launcher)
        self.assertIn('set_env_line "$draft" FLUX_KEY_PIN_SECRET "$(random_b64url)"', launcher)
        self.assertRegex(launcher, r"(?m)^random_b64url\(\) \{ head -c 32 /dev/urandom ")
        self.assertIn("FLUX_KEY_PIN_SECRET=", (ROOT / "docker" / ".env.example").read_text(encoding="utf-8"))

    def test_restore_takes_the_pin_secret_from_the_backup(self) -> None:
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        restore = launcher[launcher.index("cmd_restore() {"):]
        self.assertIn('restore_key_pin_secret "$RESTORE_DIR/flux.env"', restore[: restore.index("\n}\n")])
        functions = "\n".join(
            re.search(rf"(?ms)^{name}\(\) \{{.*?^\}}\n" if name in ("set_env_line", "restore_key_pin_secret") else rf"(?m)^{name}\(\) .*$", launcher).group(0)
            for name in ("warn", "archived_env_value", "set_env_line", "restore_key_pin_secret")
        )
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / ".env"
            archived = Path(directory) / "flux.env"
            env.write_text("FLUX_AUTH_SECRET=keep\nFLUX_KEY_PIN_SECRET=fresh-install-secret\n", encoding="utf-8")
            archived.write_text("FLUX_KEY_PIN_SECRET=the-backups-secret\n", encoding="utf-8")
            script = f'FLUX_ROOT={directory}\nENV_FILE={env}\n{functions}\nrestore_key_pin_secret {archived}\n'
            result = subprocess.run(["sh", "-c", script], check=True, capture_output=True, text=True)
            self.assertIn("FLUX_KEY_PIN_SECRET=the-backups-secret", env.read_text(encoding="utf-8"))
            self.assertIn("FLUX_AUTH_SECRET=keep", env.read_text(encoding="utf-8"))
            self.assertIn("FLUX_KEY_PIN_SECRET differs from the backup", result.stderr)
            archived.write_text("FLUX_AUTH_SECRET=x\n", encoding="utf-8")
            subprocess.run(["sh", "-c", script], check=True)
            self.assertIn("FLUX_KEY_PIN_SECRET=the-backups-secret", env.read_text(encoding="utf-8"), "a backup without one keeps the current secret")

if __name__ == "__main__":
    unittest.main()
