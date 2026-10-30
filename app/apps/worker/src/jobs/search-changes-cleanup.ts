import type { PgBoss } from 'pg-boss';
import { SEARCH_CHANGES_CLEANUP_JOB } from '@flux/contracts';
import type { Database } from '@flux/core';
import { pruneSearchChanges } from '@flux/db';

/**
 * Deletes the search change log of encrypted workspaces older than 24 hours, every hour (F-030 S2b). An in-memory search
 * index that has been idle for longer rebuilds itself instead of catching up from it.
 */
export async function registerSearchChangesCleanup(boss: PgBoss, db: Database) {
  await boss.work(SEARCH_CHANGES_CLEANUP_JOB, async () => {
    const deleted = await pruneSearchChanges(db);
    console.log(JSON.stringify({ job: SEARCH_CHANGES_CLEANUP_JOB, deleted }));
  });
  await boss.schedule(SEARCH_CHANGES_CLEANUP_JOB, '37 * * * *');
}
