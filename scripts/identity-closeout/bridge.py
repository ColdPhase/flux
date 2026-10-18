#!/usr/bin/env python3
"""Docker-only current operator bridge for #483/#490; no customer/vendor credentials.

Run only under the shared heavy-slot lease. Historical main90/late70/71 evidence
keeps its original pin. This reproduces current-base -> candidate continuity and
current genuine CLI custody/restore/provider recovery with an external disposable IdP.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = "b17ae9e357441e9a383eb275d1034e69ec50c98a"
# Exact upstream OCI index, independently retrieved from Quay; kept separate from historical26.7.5.
KEYCLOAK = "quay.io/keycloak/keycloak:26.8.0@sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def env_file(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key] = value.strip().strip('"').strip("'")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--port", type=int, default=19866)
    args = parser.parse_args()
    candidate = subprocess.check_output(["git", "rev-parse", args.candidate], cwd=ROOT, text=True).strip()
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == candidate
    assert not subprocess.check_output(["git", "diff", "HEAD", "--", "app", "docker", "flux", "scripts/identity-closeout"], cwd=ROOT)
    out = args.evidence.resolve(); out.mkdir(parents=True, mode=0o700, exist_ok=False)
    paths = subprocess.check_output(["git", "ls-files", "-z", "app", "docker", "flux", "scripts/backup-fixture.mjs", "scripts/identity-closeout"], cwd=ROOT).decode().split("\0")
    (out / "source.json").write_text(json.dumps({"candidate": candidate, "base": BASE,
        "command": ["python3", "scripts/identity-closeout/bridge.py", "--candidate", candidate, "--evidence", str(out), "--port", str(args.port)],
        "files": {path: digest(ROOT / path) for path in paths if path and (ROOT / path).is_file()}}, indent=2) + "\n")
    private = out / "private"; private.mkdir(mode=0o700)
    state = private / "state"; state.mkdir(mode=0o700)
    checkout = private / "checkout"
    suffix = f"{int(time.time())}-{os.getpid()}"
    project = f"fluxidentity-{suffix}"
    provider_project = f"fluxidp-{suffix}"
    network = f"{provider_project}-net"
    e2e_image = f"flux-e2e:{project}"
    phases: list[dict] = []
    hidden = {secrets.token_hex(32) for _ in range(3)}
    client_secret, user_password, admin_password = sorted(hidden)
    host_env = {key: value for key, value in os.environ.items() if not key.startswith(("FLUX_", "POSTGRES_", "COMPOSE_"))}
    host_env.update({"FLUX_PROJECT": project, "FLUX_IMAGE_TAG": project, "FLUX_PORT": str(args.port), "FLUX_PUBLIC_ORIGIN": f"http://127.0.0.1:{args.port}",
        "FLUX_MAILPIT_PORT": str(args.port + 1), "FLUX_AUTH_RATE_LIMIT": "false", "FLUX_SSO_MODE": "prepare",
        "FLUX_OIDC_ISSUER": "http://keycloak:8080/realms/flux", "FLUX_OIDC_CLIENT_ID": "flux", "FLUX_OIDC_LABEL": "Keycloak",
        "FLUX_OIDC_STANDING_INTERVAL_SECONDS": "900", "FLUX_OIDC_TEST_PASSWORD": user_password,
        "KC_BOOTSTRAP_ADMIN_PASSWORD": admin_password, "FLUX_BACKUP_DIR": str(private / "backups")})
    provider_id = "oidc-" + hashlib.sha256(host_env["FLUX_OIDC_ISSUER"].encode()).hexdigest()[:12]
    host_env["FLUX_OIDC_PROVIDER_ID"] = provider_id
    secret_path = private / "client-secret"; secret_path.write_text(client_secret); secret_path.chmod(0o444)
    host_env["FLUX_OIDC_CLIENT_SECRET_HOST_FILE"] = str(secret_path)
    realm = (ROOT / "docker/oidc/flux-realm.template.json").read_text()
    for before, after in {"__CLIENT_SECRET__": client_secret, "__USER_PASSWORD__": user_password,
        "__PUBLIC_ORIGIN__": host_env["FLUX_PUBLIC_ORIGIN"], "__PROVIDER_ID__": provider_id}.items():
        realm = realm.replace(before, after)
    realm_path = private / "realm.json"; realm_path.write_text(realm); realm_path.chmod(0o444)
    provider_compose = private / "provider.json"
    provider_compose.write_text(json.dumps({"services": {"keycloak": {"image": KEYCLOAK,
        "command": ["start-dev", "--import-realm"], "environment": {"KC_HOSTNAME": "http://keycloak:8080", "KC_HEALTH_ENABLED": "true",
        "KC_BOOTSTRAP_ADMIN_USERNAME": "admin", "KC_BOOTSTRAP_ADMIN_PASSWORD": "${KC_BOOTSTRAP_ADMIN_PASSWORD}"},
        "volumes": [f"{realm_path}:/opt/keycloak/data/import/flux-realm.json:ro,z", "idp-data:/opt/keycloak/data"],
        "healthcheck": {"test": ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q UP <&3"], "interval": "3s", "timeout": "3s", "retries": 60}}},
        "networks": {"default": {"name": network}}, "volumes": {"idp-data": {}}}, indent=2))
    journal = out / "phases.json"

    def scrub(text: str) -> str:
        for value in sorted(hidden, key=len, reverse=True):
            if value:
                text = text.replace(value, "[private]")
        return re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[private-jwt]", text)

    def run(label: str, argv: list[str], *, env: dict | None = None, stdin: str | None = None,
            private_output: bool = False, check: bool = True) -> subprocess.CompletedProcess:
        started = time.time()
        result = subprocess.run(argv, cwd=ROOT, env=env or host_env, input=stdin, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log = out / f"{len(phases):02d}-{label}.txt"
        if private_output:
            log.write_text(f"Private command output retained only in memory; sha256={hashlib.sha256(result.stdout.encode()).hexdigest()}\n")
        else:
            log.write_text(scrub(result.stdout))
        phases.append({"phase": label, "command": argv, "exit": result.returncode, "seconds": round(time.time() - started, 3), "log": log.name, "sha256": digest(log)})
        journal.write_text(json.dumps(phases, indent=2) + "\n")
        print(f"{label}: exit {result.returncode}, {phases[-1]['seconds']}s", flush=True)
        if check and result.returncode:
            raise RuntimeError(f"{label} failed; see sanitized {log.name}")
        return result

    def provider_cmd(*tail: str) -> list[str]:
        return ["docker", "compose", "-p", provider_project, "-f", str(provider_compose), *tail]

    def compose(*tail: str) -> list[str]:
        return ["docker", "compose", "--env-file", str(checkout / "docker/.env"), "-p", project,
            "-f", str(checkout / "docker/compose.source.yaml"), "-f", str(checkout / "docker/compose.override.yaml"), *tail]

    def override(baseline: bool) -> None:
        api_env = {"FLUX_OIDC_ALLOW_HTTP_ISSUER": "true"}
        if baseline:
            api_env["FLUX_SSO_MODE"] = "${FLUX_SSO_MODE}"
        (checkout / "docker/compose.override.yaml").write_text(json.dumps({"services": {"api": {"environment": api_env}},
            "networks": {"default": {"external": True, "name": network}}}, indent=2))

    def helper(phase: str, source: str) -> None:
        values = env_file(checkout / "docker/.env")
        helper_env = {**host_env, **values, "FLUX_PUBLIC_ORIGIN": host_env["FLUX_PUBLIC_ORIGIN"],
            "FLUX_OIDC_PROVIDER_ID": provider_id, "FLUX_OIDC_TEST_PASSWORD": user_password,
            "DATABASE_URL": f"postgres://{values.get('POSTGRES_USER', 'flux')}:{values['POSTGRES_PASSWORD']}@db:5432/{values.get('POSTGRES_DB', 'flux')}",
            "FLUX_IDENTITY_BRIDGE_PHASE": phase, "FLUX_PROOF_SOURCE": source}
        hidden.update(value for key, value in values.items() if re.search(r"PASSWORD|SECRET|PRIVATE_KEY|TOKEN", key) and value)
        command = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "--network", network, "-v", f"{state}:/state:z", "-v",
            f"{ROOT / 'scripts/identity-closeout/bridge.mjs'}:/proof/bridge.mjs:ro,z"]
        for key in ["FLUX_PUBLIC_ORIGIN", "FLUX_OIDC_PROVIDER_ID", "FLUX_OIDC_TEST_PASSWORD", "DATABASE_URL", "FLUX_AUTH_SECRET",
            "FLUX_IDENTITY_BRIDGE_PHASE", "FLUX_PROOF_SOURCE", "FLUX_DEMO_OWNER_PASSWORD"]:
            command.extend(["-e", key])
        run(phase, [*command, e2e_image, "node", "/proof/bridge.mjs"], env=helper_env)
        result = json.loads((state / f"result-{phase}.json").read_text())
        (out / f"{phase}.json").write_text(json.dumps(result, indent=2) + "\n")

    def runtime(label: str) -> None:
        objects = []
        for owned in [project, provider_project]:
            ids = subprocess.check_output(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={owned}"], text=True).split()
            if ids:
                objects.extend(json.loads(subprocess.check_output(["docker", "inspect", *ids], text=True)))
        allowed = {"FLUX_PUBLIC_ORIGIN", "FLUX_SSO_MODE", "FLUX_OIDC_STANDING", "FLUX_OIDC_ISSUER", "FLUX_OIDC_CONFIRMATION_MAX_AGE"}
        rows = [{"cid": item["Id"], "name": item["Name"], "imageId": item["Image"], "image": item["Config"]["Image"],
            "startedAt": item["State"]["StartedAt"], "service": item["Config"]["Labels"].get("com.docker.compose.service"),
            "env": {key: value for part in item["Config"].get("Env", []) for key, _, value in [part.partition("=")] if key in allowed}}
            for item in objects]
        images = json.loads(subprocess.check_output(["docker", "image", "inspect", *sorted({item["Image"] for item in objects})], text=True))
        image_rows = [{"id": item["Id"], "commitLabel": (item["Config"].get("Labels") or {}).get("com.flux.commit"),
            "repoDigests": item.get("RepoDigests", [])} for item in images]
        (out / f"runtime-{label}.json").write_text(json.dumps({"containers": rows, "images": image_rows}, indent=2) + "\n")

    terminal = 1
    try:
        run("worktree", ["git", "worktree", "add", "--detach", str(checkout), BASE])
        override(True)
        run("provider", provider_cmd("up", "-d", "--wait"))
        run("baseline-up", [str(checkout / "flux"), "up"])
        run("baseline-demo", [str(checkout / "flux"), "demo"], private_output=True)
        values = env_file(checkout / "docker/.env")
        client = f"bridge-native-{suffix}"
        sql = f"""INSERT INTO oauth_client (id,client_id,name,redirect_uris,token_endpoint_auth_method,grant_types,response_types,scopes,require_pkce,created_at,updated_at)
            VALUES (gen_random_uuid()::text,'{client}','Native backup fixture',ARRAY['http://127.0.0.1:19737/callback'],'none',ARRAY['authorization_code','refresh_token'],ARRAY['code'],ARRAY['flux.context.read','flux.action.execute','offline_access'],true,now(),now());
            INSERT INTO oauth_client_resource (id,client_id,resource_id,created_at) VALUES(gen_random_uuid()::text,'{client}','{host_env['FLUX_PUBLIC_ORIGIN']}/mcp',now());"""
        run("native-client", compose("exec", "-T", "db", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "flux", "-d", "flux"), stdin=sql)
        fixture_env = {**host_env, **values, "FLUX_FIXTURE_MODE": "seed", "FLUX_FIXTURE_OAUTH_CLIENT": client}
        fixture_cmd = compose("exec", "-T", "-e", "FLUX_FIXTURE_MODE", "-e", "FLUX_FIXTURE_OAUTH_CLIENT", "-e", "FLUX_PUBLIC_ORIGIN",
            "-e", "FLUX_DEMO_OWNER_PASSWORD", "-e", "FLUX_DEMO_PARTNER_PASSWORD", "api", "node", "--input-type=module", "-")
        seeded = run("native-data", fixture_cmd, env=fixture_env, stdin=(ROOT / "scripts/backup-fixture.mjs").read_text(), private_output=True)
        native = json.loads(next(line.removeprefix("FLUX_FIXTURE ") for line in seeded.stdout.splitlines() if line.startswith("FLUX_FIXTURE ")))
        (state / "native-fixture.json").write_text(json.dumps(native)); (state / "native-fixture.json").chmod(0o600)
        # The helper is a separately pinned test artifact; its image runs candidate toolchain, not the baseline API.
        run("browser-image", ["docker", "build", "--file", str(ROOT / "docker/Dockerfile"), "--target", "e2e", "--tag", e2e_image, str(ROOT / "app")])
        helper("link", BASE)
        host_env["FLUX_SSO_MODE"] = "sso"
        run("baseline-cutover", compose("up", "-d", "--wait", "api"))
        helper("seed", BASE)
        runtime("baseline")
        run("candidate-checkout", ["git", "-C", str(checkout), "checkout", "--detach", candidate])
        override(False)
        run("ordinary-upgrade", [str(checkout / "flux"), "upgrade", "-y"])
        helper("upgraded", candidate)
        runtime("upgraded")
        run("project-export", [str(checkout / "flux"), "export", "Community garden sensors", "--output", str(private / "export.tar.gz")])
        run("nonempty-backup", [str(checkout / "flux"), "backup"])
        archives = sorted((private / "backups").glob("*.tar"), key=lambda path: path.stat().st_mtime)
        archive = archives[-1]
        unpacked = private / "unpacked"; unpacked.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(unpacked, filter="data")
        dump = (unpacked / "database.dump").read_bytes()
        # pg_restore takes binary stdin; use a direct subprocess so no binary payload is journalled.
        listing = subprocess.run(compose("exec", "-T", "db", "pg_restore", "--list"), env=host_env, input=dump, capture_output=True, check=True).stdout.decode()
        (out / "backup-toc.txt").write_text(listing)
        assert re.search(r" TABLE public auth_idp_standing ", listing), "standing definition missing from backup"
        assert not re.search(r"TABLE DATA public auth_idp_standing ", listing), "standing token rows present in backup"
        sql_dump = subprocess.run(compose("exec", "-T", "db", "pg_restore", "--file=-"), env=host_env, input=dump, capture_output=True, check=True).stdout
        excluded = json.loads((state / "secrets.json").read_text())
        export_bytes = (private / "export.tar.gz").read_bytes()
        with tarfile.open(private / "export.tar.gz") as bundle:
            exported = b"".join(bundle.extractfile(item).read() for item in bundle.getmembers() if item.isfile())
        app_logs = subprocess.check_output(compose("logs", "--no-color", "api", "worker"), env=host_env)
        assert all(token.encode() not in payload for token in excluded for payload in [sql_dump, exported, app_logs]), "private IdP value appeared in dump/export/logs"
        custody = {"nonemptyBeforeBackup": True, "tableDefinitionRetained": True, "tableRowsOmitted": True,
            "actualPrivateValuesScanned": len(excluded), "dumpExportLogsExcludeValues": True,
            "archiveSha256": digest(archive), "exportSha256": hashlib.sha256(export_bytes).hexdigest()}
        (out / "custody.json").write_text(json.dumps(custody, indent=2) + "\n")
        run("actual-restore", [str(checkout / "flux"), "restore", str(archive), "-y"])
        runtime("restored")
        helper("restored", candidate)
        helper("recovered", candidate)
        terminal = 0
    except Exception as error:
        (out / "failure.txt").write_text(scrub(f"{type(error).__name__}: {error}\n"))
        print(scrub(str(error)), flush=True)
    finally:
        if (checkout / "docker/.env").exists():
            run("app-cleanup", [str(checkout / "flux"), "clean", "-y"], check=False)
        run("provider-cleanup", provider_cmd("down", "-v", "--remove-orphans"), check=False)
        run("browser-image-cleanup", ["docker", "image", "rm", e2e_image], check=False)
        if checkout.exists():
            run("worktree-cleanup", ["git", "worktree", "remove", "--force", str(checkout)], check=False)
        remaining = {}
        for owned in [project, provider_project]:
            remaining[owned] = {kind: subprocess.check_output(argv, text=True).splitlines() for kind, argv in {
                "containers": ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={owned}"],
                "volumes": ["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={owned}"],
                "networks": ["docker", "network", "ls", "-q", "--filter", f"label=com.docker.compose.project={owned}"],
                "images": ["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "--filter", f"reference=*:{owned}"],
            }.items()}
        if any(items for groups in remaining.values() for items in groups.values()):
            terminal = 1
        (out / "result.json").write_text(json.dumps({"base": BASE, "candidate": candidate, "terminal": terminal,
            "helperSha256": digest(ROOT / "scripts/identity-closeout/bridge.mjs"), "driverSha256": digest(Path(__file__)),
            "historicalLimit": "Does not rerun the original main90/late70/71 experiment; composes its pinned receipts with current continuity.",
            "remaining": remaining}, indent=2) + "\n")
        shutil.rmtree(private, ignore_errors=False)
    return terminal


if __name__ == "__main__":
    raise SystemExit(main())
