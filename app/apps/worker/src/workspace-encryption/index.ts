import type { PgBoss } from 'pg-boss';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import { dropStaleUnlocks, keyringFromEnv, ProcessKeys, recordEvent, replayWaitedEvent, sealFor, swapFiles, swapSafety, testSwapRoot, type Database, type EncryptionPorts, type EncryptionUnitOfWork } from '@flux/core';
import { configureSeals, workspaceEncryptionRows, type DbExecutor } from '@flux/db';
import { eventPorts } from '../events.js';
import { generatorUnitOfWork } from '../notifications/adapters.js';

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

export async function startWorkspaceEncryption(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv, emailAvailable = false) {
  const files = swapFiles(testSwapRoot(env));
  const keys = new ProcessKeys(keyringFromEnv(env), () => swapSafety(env, files));
  // The worker's repositories seal and open through these keys too (S2a).
  configureSeals((executor, workspaceId, options) => sealFor(workspaceEncryptionRows(executor), keys, workspaceId, options));
  const heartbeat = keys.startHeartbeat(async (change) => {
    if (change.current) await dropStaleUnlocks(unitOfWork(db), change.current, change.observedAt);
  }, 5_000, (error) => console.error(JSON.stringify({ warning: 'Keyring heartbeat failed', code: (error as { code?: unknown }).code ?? null })));
  await heartbeat.first;
  // After an unlock: replay the work that waited while the workspace was locked, in creation order; each wait is deleted
  // once handled. A workspace locked again stops the replay (pg-boss retries; notifications never duplicate).
  const generator = generatorUnitOfWork(db, boss);
  await boss.work<WorkspaceEncryptionResumeJob>(WORKSPACE_ENCRYPTION_RESUME_JOB, async (jobs) => {
    for (const job of jobs) {
      const waits = workspaceEncryptionRows(db as unknown as DbExecutor);
      let replayed = 0;
      for (const wait of await waits.waits(job.data.workspaceId)) {
        if (wait.queue === 'notifications.generate' && typeof wait.payload.eventId === 'string') {
          await replayWaitedEvent(generator, wait.payload.eventId, { emailAvailable });
        }
        await waits.deleteWait(wait.id);
        replayed++;
      }
      console.log(JSON.stringify({ job: WORKSPACE_ENCRYPTION_RESUME_JOB, id: job.id, workspaceId: job.data.workspaceId, replayed }));
    }
  });
  return { keys, stop: () => heartbeat.stop() };
}
