import type { PgBoss } from 'pg-boss';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import {
  createKeyRotation, dropStaleUnlocks, keyPinFromEnv, keyringFromEnv, ProcessKeys, recordEvent, sealFor, swapFiles, swapSafety, testSwapRoot, type Database,
  type EncryptionPorts, type EncryptionUnitOfWork, type KeyRotationOptions,
} from '@flux/core';
import { sql } from 'drizzle-orm';
import { configureSeals, createDatabase, keyRotationRows, rotationCheckpoint, rotationMaintenance, workspaceEncryptionRows, type DbExecutor } from '@flux/db';
import { eventPorts } from '../events.js';
import { diskRotationObjects } from './file-objects.js';

/**
 * The worker's side of encrypted workspaces (F-030, #655). It holds its own `ProcessKeys` and runs the same 5 s keyring
 * heartbeat as every API process: swap again, then the boot id; a new boot deletes the stale unlock rows and records
 * `workspace.locked.v1 { reason: 'restart' }`.
 *
 * Key rotation (S2c) runs here: a sweep every few seconds (and `rotation.kick`, called by the resume job's handler) starts each
 * pending rotation of an unlocked workspace and continues each running pass from its stored cursor, so a removal, an
 * account deletion cascading to a holder, an unlock after a removal while locked and a worker restart all lead to the
 * same code path. One run per workspace at a time in this process; the page transactions serialize on the progress row
 * across processes.
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

export async function startWorkspaceEncryption(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv) {
  const files = swapFiles(testSwapRoot(env));
  const keys = new ProcessKeys(keyringFromEnv(env), () => swapSafety(env, files));
  // The worker's repositories seal and open through these keys too (S2a).
  configureSeals((executor, workspaceId, options) => sealFor(workspaceEncryptionRows(executor), keys, workspaceId, options));
  const unit = unitOfWork(db);
  const heartbeat = keys.startHeartbeat(async (change) => {
    if (change.current) await dropStaleUnlocks(unit, change.current, change.observedAt);
  }, 5_000, (error) => console.error(JSON.stringify({ warning: 'Keyring heartbeat failed', code: (error as { code?: unknown }).code ?? null })));
  await heartbeat.first;

  const options = rotationOptions(env);
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
    unit: unitOfWork(rotationDb), keys, options, pin: keyPinFromEnv(env),
    files: await diskRotationObjects(env.FLUX_FILES_DIR ?? '/data/files').catch(() => null),
    maintenance: {
      vacuum: (tables) => rotationMaintenance(executor, tables),
      checkpoint,
    },
  });
  const running = new Map<string, Promise<void>>();
  const run = (workspaceId: string) => {
    const existing = running.get(workspaceId);
    if (existing) return existing;
    const job = (async () => {
      try {
        const outcome = await rotation.run(workspaceId);
        if (outcome !== 'idle') console.log(JSON.stringify({ job: 'workspace-encryption.rotate', workspaceId, outcome }));
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
  const sweep = async () => {
    if (stopped) return;
    if (checkpointDue) await checkpoint();
    try { for (const workspaceId of await rotation.active()) void run(workspaceId); }
    catch (error) { console.error(JSON.stringify({ warning: 'Key rotation sweep failed', code: (error as { code?: unknown }).code ?? null })); }
  };
  const timer = setInterval(() => { void sweep(); }, options.sweepMs);
  timer.unref();
  void sweep(); // a restarted worker continues every running pass from its cursor

  // The resume job sent with every unlock: S1's handler (which #717 turns into the one that replays `sealed_job_waits`)
  // also kicks the rotation, so an unlock resumes a paused rotation or starts a pending one at once.
  await boss.work<WorkspaceEncryptionResumeJob>(WORKSPACE_ENCRYPTION_RESUME_JOB, async (jobs) => {
    for (const job of jobs) {
      console.log(JSON.stringify({ job: WORKSPACE_ENCRYPTION_RESUME_JOB, id: job.id, workspaceId: job.data.workspaceId, replayed: 0 }));
      void run(job.data.workspaceId);
    }
  });
  return {
    keys,
    /** Starts a pending rotation or continues a running pass for one workspace (no-op while one runs here). */
    rotation: { kick: (workspaceId: string) => { void run(workspaceId); } },
    stop: () => { stopped = true; clearInterval(timer); heartbeat.stop(); void rotationDatabase.pool.end(); },
  };
}
