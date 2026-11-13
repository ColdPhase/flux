import { join } from 'node:path';
import type { RuntimeClient } from '@flux/runtime-protocol';
import type { SupervisorConfig } from './handlers.js';
import { runFixed, type Person } from './process.js';
import { CLIENT_DIRS, CREDENTIAL_FILES } from './templates.js';

// The CLI's own vendor login must never leave a run through Flux (coordinator decision on #1437, RT-5, RT-7). Codex applies an `apply_patch`
// itself, with the rights of its own home and outside Flux's sandbox shell, so a run steered by hostile content could move its `auth.json`
// into its scratch before the supervisor stops the run (it stops at the first change outside the scratch, and kills at once). So the
// supervisor, the one part of Flux that may touch the login, keeps its values in memory while the run lasts and answers one question about a
// text that is about to leave: a file `flux_attach_file` reads from the scratch, or what a Flux change tool writes. Nothing else of the file
// is kept, logged or sent: only "found" or "not found" leaves the slot.

/** Runs of letters, digits and the characters of base64, base64url and JWTs, long enough to be a secret (and not a word or a date). */
const SECRET_RUN = /[A-Za-z0-9._~+/=-]{20,}/g;

/** Every value in a credential file worth refusing: each long run, and each long piece of a dotted one (a JWT's payload or signature alone). */
export function credentialValues(fileText: string): string[] {
  const values = new Set<string>();
  for (const [run] of fileText.matchAll(SECRET_RUN)) {
    values.add(run);
    for (const piece of run.split('.')) if (piece.length >= 20) values.add(piece);
  }
  return [...values];
}

const credentialPath = (dir: string, client: RuntimeClient) => join(dir, CLIENT_DIRS[client], CREDENTIAL_FILES[client]);

/** The CLI's credential file as text, read as the person (it can reach only what is theirs, whatever a link there says); null when there is none. */
async function readCredentialFile(dir: string, client: RuntimeClient, person: Person): Promise<string | null> {
  const read = await runFixed('/bin/sh', ['-c', '[ -f "$1" ] && exec cat -- "$1"', 'sh', credentialPath(dir, client)], { env: { PATH: '/usr/bin:/bin' }, cwd: '/',
    timeoutMs: 5_000, maxOutputBytes: 256 * 1024, person });
  return read.code === 0 ? read.stdout : null;
}

/** The values of the CLI's credential file. Empty when there is none. */
export async function readCredentialValues(dir: string, client: RuntimeClient, person: Person): Promise<string[]> {
  const text = await readCredentialFile(dir, client, person);
  return text === null ? [] : credentialValues(text);
}

interface Watched { bindingId: string; client: RuntimeClient; dir: string; person: Person; atStart: string[]; fileAtStart: string | null }
const watched = new WeakMap<SupervisorConfig, Map<string, Watched>>();
const watchedOf = (config: SupervisorConfig) => {
  let runs = watched.get(config);
  if (!runs) { runs = new Map(); watched.set(config, runs); }
  return runs;
};

/** At a run's start, before its CLI does anything: what its login holds now (a change of the run that moves it away cannot hide it). */
export async function watchCredentials(config: SupervisorConfig, runId: string, bindingId: string, client: RuntimeClient, dir: string, person: Person) {
  const fileAtStart = await readCredentialFile(dir, client, person);
  watchedOf(config).set(runId, { bindingId, client, dir, person, atStart: fileAtStart === null ? [] : credentialValues(fileAtStart), fileAtStart });
}

/**
 * Puts back the login a run started with when the run changed it, as the person (#1437 review): for a run stopped because its own tools
 * wrote outside the scratch. A login that was not there at the start is removed.
 */
export async function restoreCredentials(config: SupervisorConfig, runId: string): Promise<void> {
  const run = watchedOf(config).get(runId);
  if (!run || await readCredentialFile(run.dir, run.client, run.person) === run.fileAtStart) return;
  const path = credentialPath(run.dir, run.client);
  await runFixed('/bin/sh', ['-c', run.fileAtStart === null ? 'rm -f -- "$1"' : 'umask 077; rm -f -- "$1" && cat > "$1"', 'sh', path],
    { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: run.person, ...(run.fileAtStart === null ? {} : { stdin: run.fileAtStart }) });
}
export function forgetCredentials(config: SupervisorConfig, runId: string) { watchedOf(config).delete(runId); }

/** The values of a run in progress: those at its start and those its login holds now (a token the CLI refreshed meanwhile). */
export async function runCredentialValues(config: SupervisorConfig, runId: string, bindingId: string): Promise<string[] | null> {
  const run = watchedOf(config).get(runId);
  if (!run || run.bindingId !== bindingId) return null;
  return [...new Set([...run.atStart, ...(await readCredentialValues(run.dir, run.client, run.person))])];
}

/** Whether `text` holds one of the run's values; null when that run is not in progress here. */
export async function holdsCredential(config: SupervisorConfig, runId: string, bindingId: string, text: string): Promise<boolean | null> {
  const values = await runCredentialValues(config, runId, bindingId);
  if (!values) return null;
  return values.some((value) => text.includes(value));
}

/**
 * Looks for the values in a stream of bytes as it passes, keeping only the last bytes of what passed (a value cut in two by chunks is still
 * found). `push` says whether one has been found so far.
 */
export function credentialFinder(values: readonly string[]): { push(chunk: Buffer): boolean } {
  const needles = values.map((value) => Buffer.from(value, 'utf8'));
  const keep = Math.max(0, ...needles.map((needle) => needle.length)) - 1;
  let tail = Buffer.alloc(0);
  let found = false;
  return {
    push(chunk) {
      if (found || !needles.length) return found;
      const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      found = needles.some((needle) => window.includes(needle));
      tail = keep > 0 ? Buffer.from(window.subarray(Math.max(0, window.length - keep))) : Buffer.alloc(0);
      return found;
    },
  };
}
