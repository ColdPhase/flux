import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertExactMigrationLedger, assertKnownMigrationVersions, assertTaskCreationUndoMigrationCompatibility,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { fixtureDatabase, legacyDirectory, legacySql, migrationCli, originalUndoFiles, refusedUnchanged, retainedHistory, retainedUndoHistory } from './support/undo-legacy-database.js';
import { restoredConstraintShape } from './support/restored-catalog-shape.js';

test('restore evidence permits only associative CHECK grouping while retaining operators, precedence and literals', () => {
  const normalized = restoredConstraintShape;
  assert.deepEqual(normalized('CHECK (((a AND b) AND c))'), normalized('CHECK ((a AND b AND c))'));
  assert.deepEqual(normalized('CHECK (((a OR b) OR c))'), normalized('CHECK ((a OR b OR c))'));
  assert.notDeepEqual(normalized('CHECK (((a AND b) OR c))'), normalized('CHECK ((a AND (b OR c)))'));
  assert.notDeepEqual(normalized("CHECK (a = 'native_agent')"), normalized("CHECK (a = 'native_agent ')"));
  assert.notDeepEqual(normalized('CHECK (a >= 1)'), normalized('CHECK (a > 1)'));
  assert.notDeepEqual(normalized("CHECK (a = 'AND')"), normalized("CHECK (a = 'OR')"));
  assert.equal(normalized('FOREIGN KEY (a, b) REFERENCES target(a, b)'), 'FOREIGN KEY (a, b) REFERENCES target(a, b)');
});

test('retained original legacy SQL and manifest have explicit original commit provenance', async () => {
  const provenance = JSON.parse(await readFile(`${legacyDirectory}/provenance.json`, 'utf8')) as { sources: { name: string; sha256: string }[] };
  for (const source of provenance.sources) assert.equal(createHash('sha256').update(await legacySql(source.name)).digest('hex'), source.sha256);
  const original = await originalUndoFiles();
  assert.equal(original.at(-1)?.version, 57);
  assert.ok(original.some((file) => file.version === 48));
});

test('actual original 45c Undo48/57 database refuses before any writes on migration and restart', { timeout: 120_000 }, async () => {
  const fixture = await fixtureDatabase(await originalUndoFiles());
  try {
    await retainedUndoHistory(fixture.db);
    await refusedUnchanged(fixture, /unsupported reserved ledger versions 57/);
  } finally { await fixture.close(); }
});

test('actual canonical sign-in, runtime-auth and focus SQL refuse individually and mixed at this sparse namespace', { timeout: 120_000 }, async () => {
  const files = ['0057_agent_runtime_sign_in.sql', '0058_agent_runtime_auth_operations.sql', '0059_notification_pause.sql'];
  for (const selected of files.map((file) => [file]).concat([files])) {
    const fixture = await fixtureDatabase();
    try {
      const { user } = await retainedHistory(fixture.db);
      for (const file of selected) {
        await fixture.db.query(await legacySql(file));
        await fixture.db.query('INSERT INTO flux_schema_version(version) VALUES($1)', [Number(file.slice(0, 4))]);
      }
      if (selected.includes('0059_notification_pause.sql')) await fixture.db.query("INSERT INTO notification_preferences(user_id,paused_until) VALUES($1,'2026-10-12T12:34:56Z')", [user]);
      if (selected.includes('0058_agent_runtime_auth_operations.sql')) await fixture.db.query("UPDATE agent_runtime_auth_admission SET blocked=true,purge_id='10000000-0000-4000-8000-000000000001'");
      await refusedUnchanged(fixture, /unsupported legacy/);
      // Negative control: adding nominal files makes numeric identity pass, but does not prove SQL ownership.
      const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
      const composed = [...manifest, ...selected.map((name) => ({ name, version: Number(name.slice(0, 4)) }))];
      const ledger = await readAppliedMigrationVersions(fixture.db);
      assert.doesNotThrow(() => assertKnownMigrationVersions(composed, ledger));
      await assert.rejects(assertTaskCreationUndoMigrationCompatibility(fixture.db, ledger), /unsupported legacy/);
    } finally { await fixture.close(); }
  }
});

test('unversioned and partial canonical/focus/Undo footprints refuse despite a numerically known ledger', { timeout: 120_000 }, async () => {
  const changes = [
    "ALTER TABLE agent_runtime_connections ADD COLUMN account_changed_at text",
    'ALTER TABLE notification_preferences ADD COLUMN paused_until integer',
    'CREATE TABLE agent_runtime_console_nonces(retained text)',
    'DELETE FROM flux_schema_version WHERE version=48',
    'DELETE FROM flux_schema_version WHERE version=60',
    'ALTER TABLE project_work_items DROP COLUMN creation_proposal_id CASCADE',
    'ALTER TABLE project_work_items ALTER COLUMN creation_reverted_by_id TYPE varchar(100)',
    'ALTER TABLE project_work_items DROP CONSTRAINT task_creation_reversion_shape; ALTER TABLE project_work_items ADD CONSTRAINT task_creation_reversion_shape CHECK(true)',
    'ALTER TABLE project_work_items DROP CONSTRAINT task_creation_proposal_scope; ALTER TABLE project_work_items ADD CONSTRAINT task_creation_proposal_scope FOREIGN KEY(creation_proposal_id) REFERENCES proactive_comparison_proposals(id)',
    "ALTER TABLE project_work_items DROP CONSTRAINT project_work_items_creation_origin_check; ALTER TABLE project_work_items ADD CONSTRAINT project_work_items_creation_origin_check CHECK(creation_origin IN ('native_agent ','ai_proposal','human'))",
    'ALTER TABLE project_work_items DISABLE TRIGGER task_creation_history_guard',
    'CREATE SCHEMA legacy_guard_impostor; CREATE FUNCTION legacy_guard_impostor.flux_guard_task_creation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; DROP TRIGGER task_creation_history_guard ON project_work_items; CREATE TRIGGER task_creation_history_guard BEFORE UPDATE ON project_work_items FOR EACH ROW EXECUTE FUNCTION legacy_guard_impostor.flux_guard_task_creation_history()',
    "CREATE OR REPLACE FUNCTION flux_guard_task_creation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    'ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check; ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check CHECK(true)',
  ];
  for (const change of changes) {
    const fixture = await fixtureDatabase();
    try {
      await retainedHistory(fixture.db); await fixture.db.query(change);
      const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
      const ledger = await readAppliedMigrationVersions(fixture.db);
      assert.doesNotThrow(() => assertKnownMigrationVersions(manifest, ledger));
      await refusedUnchanged(fixture, /unsupported or ambiguous.*catalog/);
    } finally { await fixture.close(); }
  }
});

test('even an empty partial Undo receipt relation refuses before migration SQL', { timeout: 120_000 }, async () => {
  const fixture = await fixtureDatabase((await originalUndoFiles()).filter((file) => file.version !== 48 && file.version !== 57));
  try {
    await retainedHistory(fixture.db);
    await fixture.db.query('CREATE TABLE task_creation_undo_receipts()');
    await refusedUnchanged(fixture, /partial Undo lifecycle without ledger 48/);
  } finally { await fixture.close(); }
});

test('normal sparse pre48/pre60 upgrades, fresh creation and current restart admit harmless additional schema', { timeout: 120_000 }, async () => {
  const original = await originalUndoFiles();
  const currentPrior = await Promise.all((await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION))
    .filter((file) => file.version !== 48 && file.version !== 60)
    .map(async (file) => ({ ...file, sql: await readFile(`packages/db/migrations/${file.name}`, 'utf8') })));
  for (const files of [[], original.filter((file) => file.version !== 48 && file.version !== 57), original.filter((file) => file.version !== 57), currentPrior]) {
    const fixture = await fixtureDatabase(files);
    try {
      if (files.length) await retainedHistory(fixture.db);
      const pre48 = files.length && !files.some((file) => file.version === 48);
      if (pre48) await fixture.db.query("ALTER TABLE project_work_items ADD COLUMN constructor text; UPDATE project_work_items SET constructor='retained pre-Undo addon'");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await migrationCli(fixture.name); assert.equal(result.code, 0, result.output);
        assertExactMigrationLedger(await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION), await readAppliedMigrationVersions(fixture.db));
      }
      await fixture.db.query('ALTER TABLE project_work_items ADD COLUMN harmless_future_column text; CREATE TABLE harmless_future_table(id integer)');
      const restart = await migrationCli(fixture.name); assert.equal(restart.code, 0, restart.output);
      if (pre48) assert.equal((await fixture.db.query('SELECT constructor FROM project_work_items')).rows[0].constructor, 'retained pre-Undo addon');
    } finally { await fixture.close(); }
  }
});
