"""Signing release images (#840): the check publish-release.yml and operators make, the sign job of final-release.yml and the guide.

The keyless signature itself can only be made by the real workflow; scripts/release/check_signing.sh signs with a throwaway key in
Docker. This file checks what can be checked without a release: the keyless command line, the identity pattern, the digest-only rule,
the order and permissions of the jobs, the SHA pins, and that INSTALL.md shows the same command the script runs."""

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/release/verify_signatures.sh"
FINAL = (ROOT / ".github/workflows/final-release.yml").read_text(encoding="utf-8")
PUBLISH = (ROOT / ".github/workflows/publish-release.yml").read_text(encoding="utf-8")
GUIDE = (ROOT / "docs/operations/release-guide.md").read_text(encoding="utf-8")
DIGEST = "sha256:" + "a" * 64
ISSUER = "https://token.actions.githubusercontent.com"


def run_script(*images, exit_code=0, env=None):
    """Runs verify_signatures.sh with a fake `cosign` that records its arguments; returns (status, calls, stderr)."""
    with tempfile.TemporaryDirectory() as directory:
        fake = Path(directory, "cosign")
        log = Path(directory, "calls")
        fake.write_text(f'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "{log}"\nexit {exit_code}\n', encoding="utf-8")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        done = subprocess.run(["sh", str(SCRIPT), *images], capture_output=True, text=True,
                              env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}", **(env or {})})
        return done.returncode, (log.read_text(encoding="utf-8").splitlines() if log.exists() else []), done.stderr


def job(text, name):
    """The text of one top-level job of a workflow."""
    match = re.search(rf"^  {name}:\n(.*?)(?=^  [a-z_]+:\n|\Z)", text, re.S | re.M)
    assert match, name
    return match.group(1)


class VerifySignatures(unittest.TestCase):
    def test_the_keyless_command_line_names_the_release_workflow_and_githubs_issuer(self):
        status, calls, _ = run_script(f"ghcr.io/coldphase/flux@{DIGEST}", f"ghcr.io/coldphase/flux-agent-runtime@{DIGEST}")
        self.assertEqual(status, 0)
        self.assertEqual(len(calls), 2, "one verification per image")
        for call, image in zip(calls, ("flux", "flux-agent-runtime")):
            self.assertTrue(call.startswith("verify --certificate-identity-regexp "), call)
            self.assertIn(f"--certificate-oidc-issuer {ISSUER} ghcr.io/coldphase/{image}@{DIGEST}", call)
            self.assertNotIn("--key", call)

    def identity(self):
        _, calls, _ = run_script(f"ghcr.io/coldphase/flux@{DIGEST}")
        return re.search(r"--certificate-identity-regexp (\S+) ", calls[0]).group(1)

    def test_the_identity_pattern_matches_only_the_release_workflow_on_main(self):
        pattern = re.compile(self.identity())
        good = "https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main"
        self.assertTrue(pattern.search(good))
        for bad in (
            "https://github.com/evil/flux/.github/workflows/final-release.yml@refs/heads/main",             # another owner
            "https://github.com/ColdPhase/flux-fork/.github/workflows/final-release.yml@refs/heads/main",   # another repository
            "https://github.com/ColdPhase/flux/.github/workflows/application-checks.yml@refs/heads/main",   # another workflow
            "https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/feature",     # another ref
            "https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main-evil",   # a longer ref
            "https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/tags/v1.0.0",       # a tag
            "xhttps://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main",       # a prefix
            "https://githubXcom/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main",        # an unescaped dot
        ):
            self.assertFalse(pattern.search(bad), bad)

    def test_the_repository_can_be_named_for_a_fork_and_its_dots_stay_literal(self):
        _, calls, _ = run_script(f"ghcr.io/x/flux@{DIGEST}", env={"FLUX_RELEASE_REPOSITORY": "my.org/flux"})
        pattern = re.compile(re.search(r"--certificate-identity-regexp (\S+) ", calls[0]).group(1))
        self.assertTrue(pattern.search("https://github.com/my.org/flux/.github/workflows/final-release.yml@refs/heads/main"))
        self.assertFalse(pattern.search("https://github.com/myXorg/flux/.github/workflows/final-release.yml@refs/heads/main"))

    def test_only_digests_are_checked_and_a_bad_call_asks_nothing_of_cosign(self):
        for bad in ("ghcr.io/coldphase/flux:v1.0.0", "ghcr.io/coldphase/flux", f"ghcr.io/coldphase/flux@sha256:{'a' * 63}",
                    f"ghcr.io/coldphase/flux@sha256:{'g' * 64}x"):
            status, calls, error = run_script(bad)
            self.assertEqual((status, calls), (2, []), bad)
            self.assertIn("is not an image@sha256", error)
        self.assertEqual(run_script()[0], 2)
        # One tag among good digests stops the whole call before any verification.
        self.assertEqual(run_script(f"ghcr.io/coldphase/flux@{DIGEST}", "ghcr.io/coldphase/flux:latest")[:2], (2, []))

    def test_a_failed_verification_is_exit_1_and_says_which_image(self):
        status, calls, error = run_script(f"ghcr.io/coldphase/flux@{DIGEST}", f"ghcr.io/coldphase/flux-agent-runtime@{DIGEST}", exit_code=1)
        self.assertEqual(status, 1)
        self.assertEqual(len(calls), 1, "the first failure stops the call")
        self.assertIn("NOT VERIFIED: ghcr.io/coldphase/flux@", error)

    def test_a_test_key_replaces_the_identity_and_nothing_else(self):
        status, calls, _ = run_script(f"x@{DIGEST}", env={"FLUX_COSIGN_KEY": "/keys/test.pub", "FLUX_COSIGN_VERIFY_ARGS": "--insecure-ignore-tlog=true"})
        self.assertEqual((status, calls), (0, [f"verify --key /keys/test.pub --insecure-ignore-tlog=true x@{DIGEST}"]))


class Workflows(unittest.TestCase):
    def test_every_action_in_both_release_workflows_is_pinned_by_sha(self):
        for name, text in (("final-release", FINAL), ("publish-release", PUBLISH)):
            uses = re.findall(r"^\s+- uses: (\S+)", text, re.M)
            self.assertTrue(uses, name)
            for ref in uses:
                self.assertRegex(ref, r"@[0-9a-f]{40}$", f"{name}: {ref}")

    def test_the_sign_job_runs_after_the_gates_and_the_draft_waits_for_it(self):
        sign = job(FINAL, "sign")
        self.assertRegex(sign, r"needs: \[candidate, image, package, scan\]")
        self.assertIn("id-token: write", sign)
        self.assertIn("packages: write", sign)
        self.assertNotIn("contents: write", sign)
        self.assertIn("sigstore/cosign-installer@", sign)
        # Both digests, by digest, then the same check publish-release.yml and operators make.
        self.assertIn('cosign sign --yes "ghcr.io/coldphase/flux@$IMAGE_DIGEST" "ghcr.io/coldphase/flux-agent-runtime@$RUNTIME_DIGEST"', sign)
        self.assertIn("scripts/release/verify_signatures.sh", sign)
        self.assertNotRegex(sign, r"cosign sign[^\n]*:\$")  # never a tag
        self.assertRegex(job(FINAL, "draft"), r"needs: \[candidate, image, package, scan, sign\]")
        # The image job still has no cosign: only the job that follows the gates signs.
        self.assertNotIn("cosign", job(FINAL, "image"))

    def test_the_final_release_is_still_only_dispatched_and_no_new_trigger_or_check_was_added(self):
        self.assertRegex(FINAL, r"(?s)^name: Final release candidate\n\non:\n  workflow_dispatch:")
        self.assertNotRegex(FINAL, r"\n  (push|pull_request|schedule):")

    def test_publish_release_checks_both_signatures_before_anything_is_promoted(self):
        verify = job(PUBLISH, "verify")
        self.assertIn("sigstore/cosign-installer@", verify)
        call = 'scripts/release/verify_signatures.sh" \\\n            "ghcr.io/coldphase/flux@$IMAGE_DIGEST" "ghcr.io/coldphase/flux-agent-runtime@$runtime_digest"'
        self.assertIn(call, verify)
        self.assertNotIn("verify_signatures", job(PUBLISH, "publish"), "the check is in the job that only reads")
        self.assertLess(PUBLISH.index("verify_signatures.sh"), PUBLISH.index("promote_image_tag.sh"))


class Guide(unittest.TestCase):
    def test_install_md_shows_the_command_the_script_runs(self):
        identity = re.search(r"--certificate-identity-regexp (\S+) ", run_script(f"x@{DIGEST}")[1][0]).group(1)
        # Shell-quoted in the guide, with the same pattern and issuer.
        self.assertIn(f"--certificate-identity-regexp '{identity}'", GUIDE.replace("\\\n    ", ""))
        self.assertIn(f"--certificate-oidc-issuer {ISSUER}", GUIDE)
        self.assertIn('gh attestation verify "oci://$image" --repo ColdPhase/flux', GUIDE)
        self.assertIn("cosign verify", GUIDE)
        self.assertIn("release.json", GUIDE)


if __name__ == "__main__":
    unittest.main()
