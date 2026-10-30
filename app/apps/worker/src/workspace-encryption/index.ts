import type { PgBoss } from 'pg-boss';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import { dropStaleUnlocks, keyringFromEnv, processDraftSummary, ProcessKeys, recordEvent, redactedError, replayWaitedEvent, sealFor, swapFiles, swapSafety, testSwapRoot, type EncryptionPorts, type EncryptionUnitOfWork } from '@flux/core';
import { accessReader, configureSeals, draftResultRepository, eventRepository, sql, workspaceEncryptionRows, type DbExecutor, type Database } from '@flux/db';
import { eventPorts } from '../events.js';
import { generatorUnitOfWork } from '../notifications/adapters.js';

/**
 * The worker's side of encrypted workspaces (F-030, #655). It holds its own `ProcessKeys` (S2a opens DEKs here for
 * notification generation and the resume job) and runs the same 5 s keyring heartbeat as every API process: swap
 * again, then the boot id; a new boot deletes the stale unlock rows and records `workspace.locked.v1 { reason: 'restart' }`.
 * The resume job is sent with every unlock and by a 30 s sweep for waits of a workspace that is unlocked here.
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

/**
 * A step of the one `workspace-encryption.resume.v1` handler, run after the waits were replayed (#655 integrated
 * review P2-3): S2c adds the start or resumption of a key rotation here instead of registering a second handler.
 */
export type ResumeStep = (workspaceId: string) => Promise<void>;

export async function startWorkspaceEncryption(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv, emailAvailable = false, steps: readonly ResumeStep[] = []) {
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
      let failed = 0;
      for (const wait of await waits.waits(job.data.workspaceId)) {
        try {
          if (wait.queue === 'notifications.generate' && typeof wait.payload.eventId === 'string') {
            await replayWaitedEvent(generator, wait.payload.eventId, { emailAvailable });
          }
          if (wait.queue === 'draft.summarize.v1' && typeof wait.payload.resultId === 'string') {
            // Locked again meanwhile: the summary records a new wait itself, and this one goes.
            await processDraftSummary(wait.payload.resultId, db, { results: draftResultRepository, events: eventRepository, access: accessReader });
          }
        } catch (error) {
          // Locked again: stop, and pg-boss retries. Any other failure keeps that wait for the sweep and replays the rest (#717 review P3-4).
          if ((error as { code?: unknown }).code === 'WORKSPACE_LOCKED') throw error;
          failed++;
          // Bounded: after five failed replays the wait is dropped, logged without its text (#721 review P3).
          const attempts = await waits.failWait(wait.id);
          if (attempts >= 5) await waits.deleteWait(wait.id);
          console.error(JSON.stringify({ job: WORKSPACE_ENCRYPTION_RESUME_JOB, id: job.id, waitId: wait.id, attempts, dropped: attempts >= 5,
            error: redactedError(error, [wait.id]).message }));
          continue;
        }
        await waits.deleteWait(wait.id);
        replayed++;
      }
      for (const step of steps) await step(job.data.workspaceId);
      console.log(JSON.stringify({ job: WORKSPACE_ENCRYPTION_RESUME_JOB, id: job.id, workspaceId: job.data.workspaceId, replayed, failed }));
    }
  });
  // A wait committed after the unlock's resume job ran (the generator's batch was still open) would sit until the next
  // unlock; every 30 s, a wait of a workspace this process can open sends the resume job again (#717 review P3-3).
  const sweep = setInterval(() => {
    void (async () => {
      const rows = (await db.execute(sql`SELECT DISTINCT workspace_id AS id FROM sealed_job_waits WHERE created_at < now() - interval '5 seconds'`)).rows as { id: string }[];
      for (const { id } of rows) {
        try { await sealFor(workspaceEncryptionRows(db as unknown as DbExecutor), keys, id, { write: false }); }
        catch { continue; } // still locked here
        await boss.send(WORKSPACE_ENCRYPTION_RESUME_JOB, { workspaceId: id }, { singletonKey: `sweep:${id}`, singletonSeconds: 60 });
      }
    })().catch((error) => console.error(JSON.stringify({ warning: 'Sealed wait sweep failed', error: redactedError(error).message })));
  }, 30_000);
  sweep.unref();
  return { keys, stop: () => { clearInterval(sweep); heartbeat.stop(); } };
}
