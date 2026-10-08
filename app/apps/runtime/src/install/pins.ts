import { fileURLToPath } from 'node:url';

// The CLI versions this Flux release runs (F-022 "Operator duties": each release pins the versions its
// flag contract check passed; nothing updates itself). Codex is pinned in docker/Dockerfile, where the
// runtime image downloads it with a checksum.
//
// Claude Code 2.1.285 was the `stable` channel on 2026-10-05 (https://downloads.claude.ai/claude-code-releases/stable)
// and is after 2.1.248, which `--restricted` needs. The fingerprint is the one Anthropic's setup page
// publishes under "Binary integrity and code signing" (retrieved 2026-10-05); the key file beside this
// code was fetched from https://downloads.claude.ai/keys/claude-code.asc the same day and has it.
// The flag contract check against these pins is opt-in and has not run yet (unverified).
export const CLAUDE_CODE = {
  version: '2.1.285',
  releases: 'https://downloads.claude.ai/claude-code-releases',
  signingKeyFingerprint: '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
  signingKeyFile: fileURLToPath(new URL('../../keys/claude-code-release.asc', import.meta.url)),
} as const;

export const CODEX = { version: 'rust-v0.160.1' } as const;
