import { access, constants } from 'node:fs/promises';
import {
  RUNTIME_CLIENTS, type RuntimeClient, type StepOutcome, type SupervisorError, type SupervisorFrame, type SupervisorRequest, type SupervisorResult,
} from '@flux/runtime-protocol';
import { bindingBytes, clearClientFiles, createBinding, credentialFileState, dataEntries, isEmpty, openBinding, removeBinding, tmpIsEmpty } from './data.js';
import { runFixed } from './process.js';
import { cliEnvironment, LOGOUT_TEMPLATES, STATUS_TEMPLATES } from './templates.js';

// One handler per request of the closed set. A handler answers with zero or more `step` frames and
// exactly one `result` or `error`. Login (the sign-in console) arrives in T4 and run in T5: both are
// already checked here against the closed set, the operator's switch and the binding directory, and
// then refused as `not_available`.

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
}

export type Send = (frame: SupervisorFrame) => void;
export type Outcome = { result: SupervisorResult } | { error: SupervisorError };

const installed = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

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
      const signedIn = (await cliStep(config, request.client, open.dir, STATUS_TEMPLATES[request.client])) === 'ok';
      const size = await bindingBytes(open.dir, config.bindingLimitBytes);
      return { result: { kind: 'status', client: {
        client: request.client, signedIn, credentialFile: await credentialFileState(open.dir, request.client),
        bindingBytes: size.bytes, bindingOverLimit: size.overLimit,
      } } };
    }
    case 'login': {
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      return { error: 'not_available' };
    }
    case 'run': {
      if (!config.enabled.includes(request.client)) return { error: 'client_off' };
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      if ((await bindingBytes(open.dir, config.bindingLimitBytes)).overLimit) return { error: 'binding_too_large' };
      if (!(await installed(config.cliPaths[request.client]))) return { error: 'not_installed' };
      return { error: 'not_available' };
    }
    case 'stop': {
      const open = await openBinding(config.dataDir, request.bindingId);
      if (!open.ok) return { error: open.code };
      return { result: { kind: 'stop', runId: request.runId, state: 'not_running' } };
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
