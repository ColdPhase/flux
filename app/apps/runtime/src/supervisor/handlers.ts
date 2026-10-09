import { access, constants } from 'node:fs/promises';
import {
  RUNTIME_CLIENTS, type ClientStatus, type RuntimeClient, type StepOutcome, type SupervisorError, type SupervisorFrame, type SupervisorRequest, type SupervisorResult,
} from '@flux/runtime-protocol';
import { bindingBytes, clearClientFiles, createBinding, credentialFileState, dataEntries, isEmpty, openBinding, removeBinding, tmpIsEmpty } from './data.js';
import { runFixed } from './process.js';
import { runClaudeCode, stopRun } from './run.js';
import type { ConsoleClock, SpawnPty } from './pty.js';
import { statusFacts } from './status.js';
import { cliEnvironment, LOGOUT_TEMPLATES, STATUS_TEMPLATES } from './templates.js';

// One handler per request of the closed set. A handler answers with zero or more `step` frames and
// exactly one `result` or `error`. Login runs only in the sign-in console (console.ts, T4): as a plain
// request it is refused. Run arrives in T5: it is already checked here against the closed set, the
// operator's switch and the binding directory, and then refused as `not_available`.

export interface SupervisorConfig {
  slot: string;
  secret: string;
  bootId: string;
  dataDir: string;
  tmpDir: string;
  /** The operator's `FLUX_AGENT_RUNTIME`, as this slot reads it. */
  enabled: RuntimeClient[];
  cliPaths: Record<RuntimeClient, string>;
  egressHost: string;
  /** F-022 "Limits": the supervisor refuses a run while the binding directory exceeds this. */
  bindingLimitBytes: number;
  cliTimeoutMs: number;
  /** The Flux MCP URL a run's CLI connects to (F-022 "Run"); unset refuses every run. */
  fluxMcpUrl?: string;
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

export async function slotReport(config: SupervisorConfig, busy: boolean): Promise<SupervisorResult> {
  const entries = await dataEntries(config.dataDir);
  return {
    kind: 'status',
    slot: {
      slot: config.slot, bootId: config.bootId,
      data: { empty: isEmpty(entries), bindings: entries.bindings, other: entries.other },
      tmpEmpty: await tmpIsEmpty(config.tmpDir),
      installed: await installedClients(config),
      enabled: [...config.enabled],
      busy,
    },
  };
}

async function cliStep(config: SupervisorConfig, client: RuntimeClient, dir: string, args: readonly string[]): Promise<StepOutcome> {
  if (!(await installed(config.cliPaths[client]))) return 'not_installed';
  const run = await runFixed(config.cliPaths[client], args, { env: cliEnvironment(client, dir, config.egressHost), cwd: dir, timeoutMs: config.cliTimeoutMs });
  if (run.timedOut) return 'timeout';
  return run.code === 0 ? 'ok' : 'failed';
}

/**
 * The CLI's own status in its binding directory: signed in only when its status command says so, with
 * the display facts the slot reduces its output to (status.ts). The output is never logged.
 */
export async function clientStatus(config: SupervisorConfig, client: RuntimeClient, dir: string): Promise<ClientStatus> {
  let reported: { signedIn: boolean; facts: ClientStatus['facts'] } = { signedIn: false, facts: null };
  if (await installed(config.cliPaths[client])) {
    const run = await runFixed(config.cliPaths[client], STATUS_TEMPLATES[client], { env: cliEnvironment(client, dir, config.egressHost), cwd: dir, timeoutMs: config.cliTimeoutMs });
    reported = statusFacts(client, run.timedOut ? null : run.code, run.stdout);
  }
  const size = await bindingBytes(dir, config.bindingLimitBytes);
  return { client, signedIn: reported.signedIn, facts: reported.facts, credentialFile: await credentialFileState(dir, client), bindingBytes: size.bytes, bindingOverLimit: size.overLimit };
}

/** Runs one request already parsed against the closed set. `busy` is the lane's state for slot reports. */
export async function handle(config: SupervisorConfig, request: SupervisorRequest, send: Send): Promise<Outcome> {
  switch (request.kind) {
    case 'bind': {
      const entries = await dataEntries(config.dataDir);
      // A retried bind of the same binding is accepted; any other entry, however small, refuses it.
      if (entries.other === 0 && entries.bindings.length === 1 && entries.bindings[0] === request.bindingId) {
        const open = await openBinding(config.dataDir, request.bindingId);
        return open.ok ? { result: { kind: 'bind', bindingId: request.bindingId } } : { error: 'data_not_empty' };
      }
      if (!isEmpty(entries)) return { error: 'data_not_empty' };
      await createBinding(config.dataDir, request.bindingId);
      return { result: { kind: 'bind', bindingId: request.bindingId } };
    }
    case 'status': {
      if (!request.client || !request.bindingId) return { result: await slotReport(config, false) };
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      return { result: { kind: 'status', client: await clientStatus(config, request.client, open.dir) } };
    }
    case 'login':
      // Only in the sign-in console, where the command runs in a PTY the owner's session is attached to.
      return { error: 'invalid_request' };
    case 'run': {
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      if ((await bindingBytes(open.dir, config.bindingLimitBytes)).overLimit) return { error: 'binding_too_large' };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      // T5 runs Claude Code only; Codex runs stay refused until its own adapter is verified.
      if (request.client !== 'claude_code' || !config.fluxMcpUrl) return { error: 'not_available' };
      return await runClaudeCode(request, {
        cliPath: config.cliPaths.claude_code, fluxMcpUrl: config.fluxMcpUrl, egressHost: config.egressHost,
        tmpDir: config.tmpDir, bindingDir: open.dir, send,
      });
    }
    case 'stop': {
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      return { result: { kind: 'stop', runId: request.runId, state: stopRun(request.runId) } };
    }
    case 'logout': {
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      const outcome = await cliStep(config, request.client, open.dir, LOGOUT_TEMPLATES[request.client]);
      // A failed logout still deletes the files; the owner is told to end the session at the vendor.
      await clearClientFiles(open.dir, request.client);
      send({ t: 'step', step: 'logout', outcome, client: request.client });
      return { result: { kind: 'logout', client: request.client, logout: outcome } };
    }
    case 'release': {
      const logout: Record<RuntimeClient, StepOutcome> = { claude_code: 'skipped', codex: 'skipped' };
      const open = await openBinding(config.dataDir, request.bindingId);
      if (open.ok) {
        for (const client of RUNTIME_CLIENTS) {
          logout[client] = await cliStep(config, client, open.dir, LOGOUT_TEMPLATES[client]);
          send({ t: 'step', step: 'logout', outcome: logout[client], client });
        }
      }
      const deleted = await removeBinding(config.dataDir, request.bindingId);
      send({ t: 'step', step: 'delete', outcome: deleted ? 'ok' : 'failed' });
      const dataEmpty = isEmpty(await dataEntries(config.dataDir));
      send({ t: 'step', step: 'verify', outcome: dataEmpty ? 'ok' : 'failed' });
      return { result: { kind: 'release', bindingId: request.bindingId, logout, dataEmpty, exiting: dataEmpty } };
    }
  }
}
