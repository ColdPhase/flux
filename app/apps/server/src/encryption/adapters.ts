import { fromDrizzle, type PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEnglish from '@zxcvbn-ts/language-en';
import { WORKSPACE_ENCRYPTION_RESUME_JOB, type WorkspaceEncryptionResumeJob } from '@flux/contracts';
import {
  authorize, createEncryptionUseCases, DerivationSemaphore, ForbiddenError, getWorkspace, keyringFromEnv, NotFoundError, ProcessKeys,
  recordEvent, swapFiles, swapSafety, testSwapRoot, type Database, type EncryptionPorts, type EncryptionUnitOfWork, type PasswordEstimator,
} from '@flux/core';
import { accessReader, loadActor, workspaceEncryptionRows, type DbExecutor } from '@flux/db';
import { eventPorts } from '../events.js';

// Adapters of the encrypted-workspace use cases (F-030, #655): the access policy (`workspace.manage_encryption`), the
// `@flux/db` key rows, the event log and the queue, each bound to the unit of work's transaction.

function encryptionPorts(tx: Database, boss: Pick<PgBoss, 'send'>): EncryptionPorts {
  const executor = tx as unknown as DbExecutor;
  return {
    rows: workspaceEncryptionRows(executor),
    access: {
      async manager(principal, workspaceId, options = {}) {
        const decision = await authorize(principal, 'workspace.manage_encryption', { type: 'workspace', id: workspaceId }, accessReader(executor), { lock: options.lock ?? false });
        if (!decision.visible) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
        if (!decision.allowed) throw new ForbiddenError('Only workspace owners and admins can unlock or manage encryption', 'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED');
        // The membership row is already held FOR SHARE under `lock`; this reads the role it allowed.
        return { role: (await loadActor(principal, workspaceId, executor)).role as 'owner' | 'admin' };
      },
    },
    async event(principal, workspaceId, kind, data) {
      return recordEvent(eventPorts(tx), principal, workspaceId, kind, workspaceId, data);
    },
    async resume(workspaceId) {
      const job: WorkspaceEncryptionResumeJob = { workspaceId };
      await boss.send(WORKSPACE_ENCRYPTION_RESUME_JOB, job, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql), retryLimit: 5, retryDelay: 5 });
    },
  };
}

export function encryptionUnitOfWork(db: Database, boss: Pick<PgBoss, 'send'>): EncryptionUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(encryptionPorts(tx as unknown as Database, boss))) };
}

/** `@zxcvbn-ts/core` with its common and English dictionaries (F-030 Password strength). */
export function zxcvbnEstimator(): PasswordEstimator {
  const factory = new ZxcvbnFactory({
    dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEnglish.dictionary },
    graphs: zxcvbnCommon.adjacencyGraphs,
    translations: zxcvbnEnglish.translations,
  });
  return { guessesLog10: (password) => factory.check(password).guessesLog10 };
}

/**
 * The process's keys from its environment: the keyring (`FLUX_KEYRING_TOKEN`, `FLUX_KEYRING_URL`, `FLUX_KEYRING=off`)
 * and the swap check. `FLUX_TEST_SWAP_ROOT` (fake cgroup and `/proc/swaps` files) is honoured only by a test deployment.
 */
export function processKeysFromEnv(env: NodeJS.ProcessEnv): ProcessKeys {
  const files = swapFiles(testSwapRoot(env));
  return new ProcessKeys(keyringFromEnv(env), () => swapSafety(env, files));
}

export interface EncryptionComposition {
  keys: ProcessKeys;
  useCases: ReturnType<typeof createEncryptionUseCases>;
}

/** One per API process: the keys, the shared semaphore and the use cases. */
export function composeEncryption(db: Database, boss: Pick<PgBoss, 'send'>, keys: ProcessKeys): EncryptionComposition {
  const useCases = createEncryptionUseCases({
    unit: encryptionUnitOfWork(db, boss), keys, semaphore: new DerivationSemaphore(2, 8), estimator: zxcvbnEstimator(),
    read: (principal, workspaceId) => getWorkspace(principal, workspaceId, db, { bootId: keys.openableBoot }),
  });
  return { keys, useCases };
}
