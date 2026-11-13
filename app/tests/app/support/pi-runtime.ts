import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RUN_TOKEN_LIMITS } from '@flux/contracts';
import { createModelGateway, createPersonalRunProcessor, type AgentRuntimeConfig, type PersonalConnectionLookup, type PersonalRunHooks, type RunLiveText } from '@flux/core';
import { MODEL_GATEWAY_LIMITS } from '@flux/runtime-protocol';
import { createManagerServer } from '../../../apps/runtime/src/manager/server.js';
import { personalRunWorkerUnitOfWork } from '../../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../../apps/worker/src/personal-runs/runtime-engine.js';
import { db, pool } from './db.js';
import { startFakeGateway, type FakeGateway } from './fake-gateway.js';
import { apiUrl as stackApiUrl } from './http.js';
import { FakeCompute } from './personal-runs.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './runtime-slot.js';

// TEST SUPPORT ONLY (#1441, RT-1): every agent on an API key runs in pi in the agent runtime, so the tests of API-key runs start one. An
// in-process runtime-manager and slot (a real supervisor; the sandbox is the harness's pass-through stand-in, Landlock itself is proved in
// the runtime container by scripts/check_runtime_sandbox.sh) run the REAL pinned pi (the test image's /opt/flux-runtime/pi) through the
// built launcher. pi's model requests go to a scripted stand-in for Flux's model gateway (support/fake-gateway.ts): each request takes the
// next step of `gateway.script([...])` (a tool call, an answer, or a refusal). pi reaches Flux's tools through the MCP route of the API it
// is given (the shared stack's, unless a test file runs its own). No provider is ever reached.

export interface PiRuntime {
  gateway: FakeGateway;
  config: AgentRuntimeConfig;
  slot: TestSlot;
  /** What pi printed in the last run (its stderr, its MCP log and its JSON events), to explain a run that did not end as expected. */
  lastPi(): { stderr: string; mcpLog: string; events: string[] } | null;
  /** The owner's place in this runtime: other files leave runtimes of their own in the database, so each owner is bound to this one. */
  place(ownerUserId: string): Promise<void>;
  /**
   * The worker's processor with this runtime: plan runs and API-key runs both go to it. `compute` only stands for the operator's switch
   * (`FLUX_PERSONAL_RUNS`, on unless `enabled: false`); nothing is ever dispatched through it.
   */
  processor(connections: PersonalConnectionLookup, options?: { enabled?: boolean; hooks?: PersonalRunHooks; live?: RunLiveText; stopPollMs?: number;
    caps?: { idleSeconds?: number; wallClockSeconds?: number; maxTurns?: number; maxAnswerBytes?: number } }): ReturnType<typeof createPersonalRunProcessor>;
  close(): Promise<void>;
}

export async function startPiRuntime(options: { apiUrl?: string; ownTools?: boolean } = {}): Promise<PiRuntime> {
  const secret = slotSecret();
  const gateway = await startFakeGateway();
  const slots = new Map<string, { host: string; port: number; secret: string }>();
  const manager = createManagerServer({ secret, slots, log: () => undefined });
  await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
  const managerUrl = `http://127.0.0.1:${(manager.address() as AddressInfo).port}`;
  const api = options.apiUrl ?? stackApiUrl;
  let last: { stderr: string; mcpLog: string; events: string[] } | null = null;
  const slot = await startTestSlot({ slot: `runtime-p${randomUUID().slice(0, 8)}`, enabled: [], mcpUrl: `${api}/mcp`, ownTools: options.ownTools ?? true,
    pi: { modelOrigin: gateway.url, diagnostics: (what) => { last = what; } } });
  slots.set(slot.config.slot, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
  const config: AgentRuntimeConfig = { clients: [], keys: true, commercialTermsAgreedOn: null, idleDays: null, manager: { url: managerUrl, secret } };
  await pool.query(`INSERT INTO agent_runtime_slots(slot, state, capacity) VALUES ($1, 'ready', 16) ON CONFLICT (slot) DO UPDATE SET state = 'ready', capacity = 16`, [slot.config.slot]);
  const uow = personalRunWorkerUnitOfWork(db);
  return {
    gateway,
    config,
    slot,
    lastPi: () => last,
    async place(ownerUserId) {
      const bound = await pool.query(`SELECT 1 FROM agent_runtime_bindings WHERE owner_user_id = $1 AND slot = $2 AND state <> 'released'`, [ownerUserId, slot.config.slot]);
      if (!bound.rowCount) await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'binding')`, [randomUUID(), ownerUserId, slot.config.slot]);
    },
    processor(connections, { enabled = true, hooks, live, stopPollMs = 50, caps = {} } = {}) {
      const compute = new FakeCompute();
      compute.enabled = enabled;
      return createPersonalRunProcessor({ uow, connections, compute, runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, api), stopPollMs,
        gateway: createModelGateway({ uow, connections, limits: MODEL_GATEWAY_LIMITS, tokenLifetimeMs: RUN_TOKEN_LIMITS.lifetimeSeconds * 1000 }),
        runtimeCaps: { idleSeconds: 20, wallClockSeconds: 60, maxTurns: 10, ...caps }, ...(hooks ? { hooks } : {}), ...(live ? { live } : {}) });
    },
    async close() {
      // The runtime this file made is gone with it: later files count the runtimes' room (#860).
      await pool.query(`UPDATE agent_runtime_slots SET state = 'out_of_pool', out_of_pool_reason = 'missing' WHERE slot = $1`, [slot.config.slot]).catch(() => undefined);
      await new Promise<void>((done) => manager.close(() => done()));
      await slot.close();
      await gateway.close();
    },
  };
}
