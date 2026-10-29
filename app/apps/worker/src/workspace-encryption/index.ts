import type { PgBoss } from 'pg-boss';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import { dropStaleUnlocks, keyringFromEnv, ProcessKeys, recordEvent, sealFor, swapFiles, swapSafety, testSwapRoot, type Database, type EncryptionPorts, type EncryptionUnitOfWork } from '@flux/core';
import { configureSeals, workspaceEncryptionRows, type DbExecutor } from '@flux/db';
import { eventPorts } from '../events.js';

/**
 * The worker's side of encrypted workspaces (F-030, #655). It holds its own `ProcessKeys` (S2a opens DEKs here for
 * notification generation and the resume job) and runs the same 5 s keyring heartbeat as every API process: swap
 * again, then the boot id; a new boot deletes the stale unlock rows and records `workspace.locked.v1 { reason: 'restart' }`.
 * The resume job is sent with every unlock; until S2a nothing waits (`sealed_job_waits` stays empty), so it only
 * acknowledges.
 */
function unitOfWork(db: Database): EncryptionUnitOfWork {
  return {
    run: (work) => db.transaction((tx) => work({
      rows: workspaceEncryptionRows(tx as unknown as DbExecutor),
      access: { manager: async () => { throw new Error('The worker makes no access decision for encryption'); } },
      event: (principal, workspaceId, kind, data) => recordEvent(eventPorts(tx), principal, workspaceId, kind, workspaceId, data),
      resume: async () => undefined,
    } as EncryptionPorts)),
  };
}

export async function startWorkspaceEncryption(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv) {
  const files = swapFiles(testSwapRoot(env));
  const keys = new ProcessKeys(keyringFromEnv(env), () => swapSafety(env, files));
  // The worker's repositories seal and open through these keys too (S2a).
  configureSeals((executor, workspaceId, options) => sealFor(workspaceEncryptionRows(executor), keys, workspaceId, options));
  const heartbeat = keys.startHeartbeat(async (change) => {
    if (change.current) await dropStaleUnlocks(unitOfWork(db), change.current, change.observedAt);
  }, 5_000, (error) => console.error(JSON.stringify({ warning: 'Keyring heartbeat failed', code: (error as { code?: unknown }).code ?? null })));
  await heartbeat.first;
  await boss.work<WorkspaceEncryptionResumeJob>(WORKSPACE_ENCRYPTION_RESUME_JOB, async (jobs) => {
    for (const job of jobs) console.log(JSON.stringify({ job: WORKSPACE_ENCRYPTION_RESUME_JOB, id: job.id, workspaceId: job.data.workspaceId, replayed: 0 }));
  });
  return { keys, stop: () => heartbeat.stop() };
}
