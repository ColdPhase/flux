import type { PgBoss } from 'pg-boss';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import {
  createKeyRotation, dropStaleUnlocks, keyPinStatus, keyringFromEnv, processDraftSummary, ProcessKeys, recordEvent, redactedError, replayWaitedEvent, sealFor, swapFiles,
  swapSafety, testSwapRoot, type EncryptionPorts, type EncryptionUnitOfWork, type KeyRotationOptions,
} from '@flux/core';
import {
  accessReader, configureRemovalPin, configureSeals, createDatabase, draftResultRepository, eventRepository, keyRotationRows, rotationCheckpoint, rotationMaintenance, sql,
  workspaceEncryptionRows, type DbExecutor, type Database,
} from '@flux/db';
import { eventPorts } from '../events.js';
import { generatorUnitOfWork } from '../notifications/adapters.js';
import { diskRotationObjects } from './file-objects.js';

/**
 * The worker's side of encrypted workspaces (F-030, #655). It holds its own `ProcessKeys` (S2a opens DEKs here for
 * notification generation and the resume job) and runs the same 5 s keyring heartbeat as every API process: swap
 * again, then the boot id; a new boot deletes the stale unlock rows and records `workspace.locked.v1 { reason: 'restart' }`.
 * The resume job is sent with every unlock and by a 30 s sweep for waits of a workspace that is unlocked here.
 *
 * Key rotation (S2c) runs here too: a sweep every few seconds, and the resume job's last step (`rotation.kick`), start
 * each pending rotation of an unlocked workspace and continue each running pass from its stored cursor, so a removal,
 * an account deletion cascading to a holder, an unlock after a removal while locked and a worker restart all lead to
 * the same code path. One run per workspace at a time in this process; the page transactions serialize on the
 * progress row across processes.
 */
function unitOfWork(db: Database): EncryptionUnitOfWork {
  return {
    run: (work) => db.transaction((tx) => work({
      rows: workspaceEncryptionRows(tx as unknown as DbExecutor),
      rotation: keyRotationRows(tx as unknown as DbExecutor),
      access: { manager: async () => { throw new Error('The worker makes no access decision for encryption'); } },
      event: (principal, workspaceId, kind, data) => recordEvent(eventPorts(tx), principal, workspaceId, kind, workspaceId, data),
      resume: async () => undefined,
    } as EncryptionPorts)),
  };
}

const testDeployment = (env: NodeJS.ProcessEnv) => !!env.FLUX_FIXTURE_TOKEN && env.FLUX_TEST_FAILURE_INJECTION === 'true';
const testNumber = (env: NodeJS.ProcessEnv, name: string) => {
  const value = Number(env[name]);
  return testDeployment(env) && Number.isInteger(value) && value >= 1 ? value : null;
};

/**
 * The rotation's pace: pages of 500 rows (20 files), 20 ms apart, a sweep every 5 s. A test deployment may make pages
 * smaller and the sweep faster, and hold the pass after a number of pages so a test can kill the worker mid-rotation.
 */
export function rotationOptions(env: NodeJS.ProcessEnv): KeyRotationOptions & { sweepMs: number } {
  const hold = testNumber(env, 'FLUX_TEST_ROTATION_HOLD_AFTER_PAGES');
  return {
    pageSize: testNumber(env, 'FLUX_TEST_ROTATION_PAGE_SIZE') ?? 500,
    filePageSize: 20,
    pauseMs: 20,
    sweepMs: testNumber(env, 'FLUX_TEST_ROTATION_SWEEP_MS') ?? 5_000,
    afterPage: hold === null ? undefined : async (pages) => {
      if (pages < hold) return;
      console.log(JSON.stringify({ test: 'rotation held', pages }));
      await new Promise(() => undefined); // TEST ONLY: never resolves; the test kills this worker
    },
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

  const options = rotationOptions(env);
  const pinStatus = keyPinStatus(env);
  if (pinStatus.warning) console.error(JSON.stringify({ warning: pinStatus.warning }));
  configureRemovalPin(pinStatus.pin ? (record) => pinStatus.pin!.removal(record) : null);
  // The rotation's own two connections: a page, the finish's catalog scan, VACUUM and CHECKPOINT may take longer than
  // the 2 s statement limit of the request pool, and they never take a request connection.
  const rotationDatabase = createDatabase(env.DATABASE_URL!, undefined, { queryTimeoutMs: 10 * 60_000, max: 2 });
  const rotationDb = rotationDatabase.db as unknown as Database;
  const executor = rotationDb as unknown as DbExecutor;
  // The pass's compare-and-set runs with `session_replication_role = replica` (no content changes, so no content
  // triggers). That needs a superuser or a granted SET on the parameter; say so at start rather than on every page.
  await rotationDb.transaction(async (tx) => { await (tx as unknown as DbExecutor).execute(sql`SET LOCAL session_replication_role = replica`); })
    .catch((error) => console.error(JSON.stringify({ warning: 'Key rotation needs SET session_replication_role (superuser or GRANT SET ON PARAMETER); rotations will stall',
      code: (error as { code?: unknown }).code ?? null })));
  // A CHECKPOINT that failed after a finish is retried by the next sweep.
  let checkpointDue = false;
  const checkpoint = () => rotationCheckpoint(executor).then(() => { checkpointDue = false; }, (error) => {
    checkpointDue = true;
    console.error(JSON.stringify({ warning: 'CHECKPOINT after a key rotation failed; retried by the next sweep', code: (error as { code?: unknown }).code ?? null }));
  });
  const rotation = createKeyRotation({
    unit: unitOfWork(rotationDb), keys, options, pin: pinStatus.pin,
    files: await diskRotationObjects(env.FLUX_FILES_DIR ?? '/data/files').catch(() => null),
    maintenance: {
      vacuum: (tables) => rotationMaintenance(executor, tables),
      checkpoint,
    },
  });
  const running = new Map<string, Promise<void>>();
  // A stalled rotation repeats its finish check under the exclusive gate; back off (1 s doubling to 5 min) so a stall
  // does not hold writers every sweep (S2c review P3). An unlock's kick tries at once.
  const backoff = new Map<string, { until: number; delay: number }>();
  const run = (workspaceId: string, force = false) => {
    const existing = running.get(workspaceId);
    if (existing) return existing;
    const wait = backoff.get(workspaceId);
    if (!force && wait && Date.now() < wait.until) return Promise.resolve();
    const job = (async () => {
      try {
        const outcome = await rotation.run(workspaceId);
        if (outcome !== 'idle') console.log(JSON.stringify({ job: 'workspace-encryption.rotate', workspaceId, outcome }));
        if (outcome === 'stalled') {
          const delay = Math.min(300_000, (backoff.get(workspaceId)?.delay ?? 500) * 2);
          backoff.set(workspaceId, { until: Date.now() + delay, delay });
        } else backoff.delete(workspaceId);
      } catch (error) {
        // The SQL text (first line of a failed query, never its parameters) and the SQLSTATE: enough to diagnose, no content.
        const cause = (error as { cause?: { code?: unknown } }).cause;
        console.error(JSON.stringify({ warning: 'Key rotation step failed', workspaceId, code: (error as { code?: unknown }).code ?? cause?.code ?? null,
          name: (error as Error).name, at: String((error as Error).message ?? '').split('\n')[0]!.slice(0, 200) }));
      } finally { running.delete(workspaceId); }
    })();
    running.set(workspaceId, job);
    return job;
  };
  let stopped = false;
  const rotationSweep = async () => {
    if (stopped) return;
    if (checkpointDue) await checkpoint();
    try { for (const workspaceId of await rotation.active()) void run(workspaceId); }
    catch (error) { console.error(JSON.stringify({ warning: 'Key rotation sweep failed', code: (error as { code?: unknown }).code ?? null })); }
  };
  const rotationTimer = setInterval(() => { void rotationSweep(); }, options.sweepMs);
  rotationTimer.unref();
  void rotationSweep(); // a restarted worker continues every running pass from its cursor

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
      void run(job.data.workspaceId, true); // last step: start a pending rotation or resume a paused one (S2c)
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
  return {
    keys,
    /** Starts a pending rotation or continues a running pass for one workspace (no-op while one runs here). */
    rotation: { kick: (workspaceId: string) => { void run(workspaceId, true); } },
    stop: () => { stopped = true; clearInterval(rotationTimer); clearInterval(sweep); heartbeat.stop(); void rotationDatabase.pool.end(); },
  };
}
