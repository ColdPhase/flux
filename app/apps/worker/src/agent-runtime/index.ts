import { reconcileAgentRuntime, recoverLostRuntimeRuns, type AgentRuntimeConfig } from '@flux/core';
import { agentRuntimeStore, SessionLockLostError, withRuntimeReconcileLock, type Database } from '@flux/db';
import { createRuntimeManagerClient, runtimeManagerPort } from '@flux/runtime-protocol';
import { personalRunWorkerUnitOfWork } from '../personal-runs/adapters.js';

// The worker's side of the `runtime` transport (F-022 T3): it reconciles the database's bindings with
// each slot through runtime-manager at start (which is what makes a restore safe) and then every few
// seconds, performing releases and returning wiped slots to the pool. Off when FLUX_AGENT_RUNTIME is empty.

export function startAgentRuntimeReconciler({ config, db, pool, env }: { config: AgentRuntimeConfig; db: Database; pool: Parameters<typeof withRuntimeReconcileLock>[0]; env: NodeJS.ProcessEnv }) {
  if (!config.manager) return { stop: async () => undefined };
  const intervalMs = Number(env.FLUX_AGENT_RUNTIME_RECONCILE_MS ?? 10_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 600_000) throw new Error('FLUX_AGENT_RUNTIME_RECONCILE_MS must be 500 to 600000');
  const manager = runtimeManagerPort(createRuntimeManagerClient(config.manager));
  const store = agentRuntimeStore(db);
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ component: 'agent-runtime', ...event }));
  let running: Promise<void> | null = null;
  let lastError = '';
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const report = await withRuntimeReconcileLock(pool, (signal) => reconcileAgentRuntime({ config, store, manager, log, signal,
          endLostRuns: (active) => recoverLostRuntimeRuns(personalRunWorkerUnitOfWork(db), active) }));
        if (!report) return;
        if (report.error) { if (report.error !== lastError) log({ event: 'manager_unavailable', code: report.error }); lastError = report.error; return; }
        lastError = '';
        if (report.released.length || report.orphans || report.signInAgain.length || report.outOfPool.length || report.idle) log({ event: 'reconciled', ...report });
      } catch (error) {
        log({ event: 'reconcile_failed', message: (error as Error).message.slice(0, 200) });
        // The lock was lost and the next holder may be reconciling. This one stops at its next checkpoint; neither the next tick nor
        // `stop()` goes on before it has (#961).
        if (error instanceof SessionLockLostError) await error.abandoned;
      } finally {
        running = null;
      }
    })();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: async () => { clearInterval(timer); await running; } };
}
