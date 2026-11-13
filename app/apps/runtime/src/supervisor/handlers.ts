import { access, constants } from 'node:fs/promises';
import {
  RUNTIME_CLIENTS, type ClientStatus, type RuntimeClient, type StepOutcome, type SupervisorError, type SupervisorFrame, type SupervisorRequest, type SupervisorResult,
} from '@flux/runtime-protocol';
import { bindingBytes, clearClientFiles, clearLeftovers, clearScratch, clientHasFiles, createBinding, credentialFileState, dataEntries, freePerson, hasUnconfirmed, openBinding, ownerOf, recordUnconfirmed, removeBinding } from './data.js';
import { endProcesses, runFixed, type Person } from './process.js';
import type { ConsoleClock, SpawnPty } from './pty.js';
import { statusFacts } from './status.js';
import { cliEnvironment, LOGOUT_TEMPLATES, STATUS_TEMPLATES } from './templates.js';
import { reportedRuns, runCli, stopRun } from './run.js';
import { readPlanModels } from './models.js';
import type { SandboxSetup } from './sandbox.js';

// One handler per request of the closed set. A handler answers with zero or more `step` frames and
// exactly one `result` or `error`. Login runs only in the sign-in console (console.ts, T4): as a plain
// request it is refused. Run (T5, run.ts) is checked against the closed set, the operator's switch and the
// binding directory before the CLI starts; a run answers with `run` frames and its result. One supervisor serves
// everyone (#860): each person has their own binding directory and user id, and their own lane.

export interface SupervisorConfig {
  slot: string;
  secret: string;
  bootId: string;
  dataDir: string;
  tmpDir: string;
  /** Each person's CLIs run under their own user id (#860). Always on in the runtime; the in-process test harness runs unprivileged. */
  separate: boolean;
  /** How many agents can run here at once: reported to the worker, which holds the others back (capacity.ts). */
  capacity: number;
  /** The operator's `FLUX_AGENT_RUNTIME`, as this slot reads it. */
  enabled: RuntimeClient[];
  cliPaths: Record<RuntimeClient, string>;
  /** Flux's reviewed copy of the pinned Codex's model catalog (default: the image's, `CODEX_MODEL_CATALOG`); a run's own catalog is cut from it (#1332). Tests point it at a fixture. */
  codexCatalogPath?: string;
  egressHost: string;
  /** The Flux MCP route as the CLI reaches it (default `http://<egress>:8080/mcp`, runtime-egress's forwarder); tests point it elsewhere. */
  mcpUrl?: string;
  /** F-022 "Limits": the supervisor refuses a run while the binding directory exceeds this. */
  bindingLimitBytes: number;
  cliTimeoutMs: number;
  /** Flux's sandbox for the CLIs' own tools (#1437, sandbox.ts), as found at start; absent or null: the tools stay off. */
  sandbox?: SandboxSetup | null;
  /** The sign-in console's PTY and timers; tests inject them (defaults: node-pty, real timers, 15 min). */
  spawnPty?: SpawnPty;
  clock?: ConsoleClock;
  consoleLifetimeMs?: number;
}

export type Send = (frame: SupervisorFrame) => void;
export type Outcome = { result: SupervisorResult } | { error: SupervisorError };

const installed = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
export const installedClient = (config: SupervisorConfig, client: RuntimeClient) => installed(config.cliPaths[client]);

export async function installedClients(config: SupervisorConfig): Promise<Record<RuntimeClient, boolean>> {
  return { claude_code: await installed(config.cliPaths.claude_code), codex: await installed(config.cliPaths.codex) };
}

export async function slotReport(config: SupervisorConfig): Promise<SupervisorResult> {
  const entries = await dataEntries(config.dataDir);
  return {
    kind: 'status',
    slot: {
      slot: config.slot, bootId: config.bootId,
      data: { bindings: entries.bindings, other: entries.other },
      installed: await installedClients(config),
      enabled: [...config.enabled],
      capacity: config.capacity,
      running: reportedRuns(config),
    },
  };
}

async function cliStep(config: SupervisorConfig, client: RuntimeClient, dir: string, person: Person, args: readonly string[]): Promise<StepOutcome> {
  if (!(await installed(config.cliPaths[client]))) {
    // Nothing of this client in the binding and no earlier failed sign-out: no session can exist, so there
    // is nothing to sign out. Files left, or any unreadable file, mean a session may remain: a failure.
    return (await clientHasFiles(dir, client)) ? 'failed' : 'not_installed';
  }
  const run = await runFixed(config.cliPaths[client], args, { env: cliEnvironment(client, dir, config.egressHost), cwd: dir, timeoutMs: config.cliTimeoutMs, person });
  if (run.timedOut) return 'timeout';
  return run.code === 0 ? 'ok' : 'failed';
}

/**
 * The CLI's own status in its binding directory: signed in only when its status command says so, with
 * the display facts the slot reduces its output to (status.ts). The output is never logged.
 */
export async function clientStatus(config: SupervisorConfig, client: RuntimeClient, dir: string, person: Person): Promise<ClientStatus> {
  let reported: { signedIn: boolean; facts: ClientStatus['facts'] } = { signedIn: false, facts: null };
  if (await installed(config.cliPaths[client])) {
    const run = await runFixed(config.cliPaths[client], STATUS_TEMPLATES[client], { env: cliEnvironment(client, dir, config.egressHost), cwd: dir, timeoutMs: config.cliTimeoutMs,
      readStderr: client === 'codex', person });
    // Codex prints its status on stderr (codex-rs `cli/src/login.rs`), Claude Code on stdout.
    reported = statusFacts(client, run.timedOut ? null : run.code, client === 'codex' ? run.stderr : run.stdout);
  }
  const size = await bindingBytes(dir, config.bindingLimitBytes);
  return { client, signedIn: reported.signedIn, facts: reported.facts, credentialFile: await credentialFileState(dir, client), bindingBytes: size.bytes, bindingOverLimit: size.overLimit };
}

/**
 * One client's sign-out. An earlier failed sign-out stays failed: its files were deleted before any later
 * attempt, so a later "ok" or "not installed" cannot confirm what the vendor still holds. A failure is
 * recorded in the binding directory before the caller deletes the client's files.
 */
async function signOut(config: SupervisorConfig, client: RuntimeClient, dir: string, person: Person): Promise<StepOutcome> {
  const earlierFailure = await hasUnconfirmed(dir, client);
  const outcome = await cliStep(config, client, dir, person, LOGOUT_TEMPLATES[client]);
  // Nothing of theirs may be running from here on; a process that survived means the sign-out is not confirmed.
  const quiet = await endProcesses(person);
  const confirmed = quiet && (outcome === 'ok' || outcome === 'not_installed');
  if (earlierFailure && confirmed) return 'failed';
  if (!confirmed) await recordUnconfirmed(dir, client);
  return quiet ? outcome : 'failed';
}

/**
 * The sign-outs of a release that could not finish (something of the person's stays), by binding. The worker asks again every ten
 * seconds, and the vendor's session is already ended: a second logout would find no login and could read as a failed one, turning a good
 * sign-out into "not confirmed" (#915). The retry reports the sign-outs of the first attempt and finishes only the deleting. Kept in
 * memory: after a restart the retry signs out again, which is the only honest thing left to do.
 */
const unfinishedReleases = new Map<string, Record<RuntimeClient, StepOutcome>>();

/** Runs one request already parsed against the closed set. */
/** `signal`: only a `models` read takes one; it is aborted when a run of the person's needs the lane (#1332). */
export async function handle(config: SupervisorConfig, request: SupervisorRequest, send: Send, signal?: AbortSignal): Promise<Outcome> {
  switch (request.kind) {
    case 'bind': {
      // A retried bind of the same binding is accepted.
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (open.ok) return { result: { kind: 'bind', bindingId: request.bindingId } };
      if (open.code !== 'no_binding') return { error: open.code };
      const person = config.separate ? await freePerson(config.dataDir) : null;
      if (config.separate && !person) return { error: 'internal' };
      await createBinding(config.dataDir, request.bindingId, person);
      return { result: { kind: 'bind', bindingId: request.bindingId } };
    }
    case 'status': {
      if (!request.client || !request.bindingId) return { result: await slotReport(config) };
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (!open.ok) return { error: open.code };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      return { result: { kind: 'status', client: await clientStatus(config, request.client, open.dir, open.person) } };
    }
    case 'models': {
      // The models the signed-in CLI offers (#1332). Read-only: no run is touched, and nothing it prints is kept.
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (!open.ok) return { error: open.code };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      const models = await readPlanModels(config, request.client, open.dir, open.person, signal);
      // Ended for a run that needed the lane: busy, as if it had never started; the worker keeps the last list.
      if (signal?.aborted) return { error: 'busy' };
      return models ? { result: { kind: 'models', client: request.client, models } } : { error: 'not_available' };
    }
    case 'login':
      // Only in the sign-in console, where the command runs in a PTY the owner's session is attached to.
      return { error: 'invalid_request' };
    case 'run': {
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (!open.ok) return { error: open.code };
      if ((await bindingBytes(open.dir, config.bindingLimitBytes)).overLimit) return { error: 'binding_too_large' };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      return runCli(config, request, open.dir, open.person, send);
    }
    case 'stop': {
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (!open.ok) return { error: open.code };
      const state = stopRun(config, request.runId, request.bindingId);
      return state === 'binding_mismatch' ? { error: state } : { result: { kind: 'stop', runId: request.runId, state } };
    }
    case 'logout': {
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      if (!open.ok) return { error: open.code };
      const outcome = await signOut(config, request.client, open.dir, open.person);
      // A failed logout still deletes the files; the owner is told to end the session at the vendor.
      await clearClientFiles(open.dir, request.client, open.person);
      await clearScratch(open.dir, open.person);
      await clearLeftovers(config.tmpDir, open.person);
      send({ t: 'step', step: 'logout', outcome, client: request.client });
      return { result: { kind: 'logout', client: request.client, logout: outcome } };
    }
    case 'release': {
      const logout: Record<RuntimeClient, StepOutcome> = { claude_code: 'skipped', codex: 'skipped' };
      const open = await openBinding(config.dataDir, request.bindingId, config.separate);
      const earlier = unfinishedReleases.get(request.bindingId);
      if (earlier) {
        for (const client of RUNTIME_CLIENTS) { logout[client] = earlier[client]; send({ t: 'step', step: 'logout', outcome: logout[client], client }); }
      } else if (open.ok) {
        for (const client of RUNTIME_CLIENTS) {
          logout[client] = await signOut(config, client, open.dir, open.person);
          send({ t: 'step', step: 'logout', outcome: logout[client], client });
        }
      }
      // Nothing of the person may outlive the release: no process (proved by reading them all), then no file.
      const owner = open.ok ? open.person : await ownerOf(config.dataDir, request.bindingId, config.separate);
      const quiet = await endProcesses(owner);
      // While something of theirs stays in /tmp their directory stays too, so their user id is given to nobody else and the release is asked again.
      const cleared = quiet && await clearLeftovers(config.tmpDir, owner);
      const removed = cleared && await removeBinding(config.dataDir, request.bindingId);
      send({ t: 'step', step: 'delete', outcome: removed ? 'ok' : 'failed' });
      const deleted = removed && !(await dataEntries(config.dataDir)).bindings.includes(request.bindingId);
      send({ t: 'step', step: 'verify', outcome: deleted ? 'ok' : 'failed' });
      if (deleted) unfinishedReleases.delete(request.bindingId); else unfinishedReleases.set(request.bindingId, logout);
      return { result: { kind: 'release', bindingId: request.bindingId, logout, deleted } };
    }
  }
}
