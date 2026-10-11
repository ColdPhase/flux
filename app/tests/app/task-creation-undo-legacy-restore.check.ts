// Driven by an isolated Docker runner: prepare, real PostgreSQL pg_dump/restore, then verify.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '@flux/db';
import { dbUrl, fixtureDatabase, originalUndoFiles, refusedUnchanged, retainedUndoHistory, snapshot } from './support/undo-legacy-database.js';

const directory = process.env.FLUX_LEGACY_EVIDENCE_DIR;
if (!directory) throw new Error('FLUX_LEGACY_EVIDENCE_DIR is required');
const name = 'flux_undo_legacy_restore';
if (process.argv[2] === 'prepare') {
  const fixture = await fixtureDatabase(await originalUndoFiles(), name);
  await retainedUndoHistory(fixture.db);
  await refusedUnchanged(fixture, /unsupported reserved ledger versions 57/);
  await writeFile(`${directory}/original-snapshot.json`, JSON.stringify(await snapshot(fixture.db)));
  await fixture.retain();
  console.log('Original45c legacy database prepared; two real CLI refusals preserved all rows/catalog/ledger.');
} else if (process.argv[2] === 'verify') {
  const db = createDatabase(dbUrl(name)).pool;
  try {
    assert.deepEqual(await snapshot(db), JSON.parse(await readFile(`${directory}/original-snapshot.json`, 'utf8')));
    await refusedUnchanged({ db, name } as Awaited<ReturnType<typeof fixtureDatabase>>, /unsupported reserved ledger versions 57/);
    console.log('Real pg_dump restore equals original snapshot; two restored CLI refusals preserve all rows/catalog/ledger.');
  } finally { await db.end(); }
} else throw new Error('Expected prepare or verify');
