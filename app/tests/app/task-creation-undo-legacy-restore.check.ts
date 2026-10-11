// Driven by an isolated Docker runner: prepare, real PostgreSQL pg_dump/restore, then verify.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '@flux/db';
import { dbUrl, fixtureDatabase, migrationCli, originalUndoFiles, refusedUnchanged, retainedUndoHistory, snapshot } from './support/undo-legacy-database.js';
import { restoredConstraintShape } from './support/restored-catalog-shape.js';

const directory = process.env.FLUX_LEGACY_EVIDENCE_DIR;
if (!directory) throw new Error('FLUX_LEGACY_EVIDENCE_DIR is required');
const current = process.argv[3] === 'current';
const name = current ? 'flux_undo_current_restore' : 'flux_undo_legacy_restore';
const restoredShape = (source: Awaited<ReturnType<typeof snapshot>>) => {
  const result = structuredClone(source);
  for (const constraint of result.catalog.constraints) constraint.definition = restoredConstraintShape(constraint.definition);
  return result;
};
if (process.argv[2] === 'prepare') {
  const fixture = await fixtureDatabase(current ? undefined : await originalUndoFiles(), name);
  await retainedUndoHistory(fixture.db);
  if (current) { const result = await migrationCli(name); assert.equal(result.code, 0, result.output); }
  else await refusedUnchanged(fixture, /unsupported reserved ledger versions 57/);
  await writeFile(`${directory}/${name}-snapshot.json`, JSON.stringify(await snapshot(fixture.db)));
  await fixture.retain();
  console.log(`${name} prepared with retained task/use/reversion/notice/receipt/grant rows.`);
} else if (process.argv[2] === 'verify') {
  const db = createDatabase(dbUrl(name)).pool;
  try {
    assert.deepEqual(restoredShape(await snapshot(db)), restoredShape(JSON.parse(await readFile(`${directory}/${name}-snapshot.json`, 'utf8'))));
    if (current) {
      const before = await snapshot(db);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await migrationCli(name); assert.equal(result.code, 0, result.output);
        assert.deepEqual(await snapshot(db), before, 'current restored CLI restart preserves every retained public row and catalog');
      }
    } else await refusedUnchanged({ db, name } as Awaited<ReturnType<typeof fixtureDatabase>>, /unsupported reserved ledger versions 57/);
    console.log(`Real pg_dump restore ${name} equals data/ledger and semantic catalog; two restored CLI ${current ? 'restarts' : 'refusals'} pass.`);
  } finally { await db.end(); }
} else throw new Error('Expected prepare or verify');
