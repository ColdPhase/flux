import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before as beforeAll, test } from 'node:test';
import { assertExactMigrationLedger, assertKnownMigrationVersions, assertTaskCreationUndoMigrationCompatibility,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { fixtureDatabase, legacyDirectory, prepareCurrentSchemaFixtures, legacySql, migrationCli, originalUndoFiles, refusedUnchanged, retainedHistory, retainedUndoHistory } from './support/undo-legacy-database.js';
import { restoredConstraintShape } from './support/restored-catalog-shape.js';

beforeAll(prepareCurrentSchemaFixtures);

// Migration files below a version: the sign-in and runtime-auth fixtures start from this exact prefix.
async function manifestBefore(version: number) {
  const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
  return Promise.all(manifest.filter((file) => file.version < version)
    .map(async (file) => ({ ...file, sql: await readFile(`packages/db/migrations/${file.name}`, 'utf8') })));
}

async function retainedUndoSnapshot(db: Awaited<ReturnType<typeof fixtureDatabase>>['db']) {
  const work = await db.query("SELECT to_jsonb(t)::text AS row FROM project_work_items t WHERE creation_reverted_at IS NOT NULL OR first_persisted_use_at IS NOT NULL ORDER BY id");
  const notices = await db.query("SELECT to_jsonb(t)::text AS row FROM project_task_notices t WHERE kind IN ('task.created','task.creation_reverted') ORDER BY id");
  const receipts = await db.query('SELECT to_jsonb(t)::text AS row FROM task_creation_undo_receipts t ORDER BY work_id');
  return { work: work.rows, notices: notices.rows, receipts: receipts.rows };
}

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

test('actual canonical sign-in and runtime-auth SQL refuse individually and mixed at this namespace', { timeout: 120_000 }, async () => {
  const files = ['0057_agent_runtime_sign_in.sql', '0058_agent_runtime_auth_operations.sql'];
  for (const selected of files.map((file) => [file]).concat([files])) {
    const fixture = await fixtureDatabase(await manifestBefore(96));
    try {
      await retainedHistory(fixture.db);
      for (const file of selected) {
        await fixture.db.query(await legacySql(file));
        await fixture.db.query('INSERT INTO flux_schema_version(version) VALUES($1)', [Number(file.slice(0, 4))]);
      }
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

// manifestBefore(95) is a ledger 94 database and manifestBefore(96) a ledger 95 one.
for (const first of [95, 96]) test(`a ledger ${first - 1} database with runtime binding and connection rows upgrades through sign-in 0096 and runtime-auth 0097`, { timeout: 120_000 }, async () => {
  const fixture = await fixtureDatabase(await manifestBefore(first));
  const signInColumns = ['account_fingerprint', 'previous_account_label', 'account_changed_at', 'signed_out_at', 'sign_out_failed'];
  // Rows as the pre-0096 schema wrote them: the new sign-in columns are left out of the comparison.
  const connectionRows = async () => (await fixture.db.query('SELECT to_jsonb(t)::text AS row FROM agent_runtime_connections t ORDER BY id'))
    .rows.map(({ row }: { row: string }) => { const value = JSON.parse(row) as Record<string, unknown>; for (const name of signInColumns) delete value[name]; return value; });
  try {
    const { user } = await retainedHistory(fixture.db);
    const binding = randomUUID();
    await fixture.db.query("INSERT INTO agent_runtime_slots(slot, state) VALUES ('runtime-790', 'ready')");
    await fixture.db.query("INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, 'runtime-790', 'active')", [binding, user]);
    await fixture.db.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, account_label)
      VALUES ($1, $2, $3, 'claude_code', 'signed_out', 'a***@example.org')`, [randomUUID(), user, binding]);
    const before = await connectionRows();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await migrationCli(fixture.name);
      assert.equal(result.code, 0, result.output);
      assertExactMigrationLedger(await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION), await readAppliedMigrationVersions(fixture.db));
    }
    assert.ok((await readAppliedMigrationVersions(fixture.db)).includes(97));
    assert.deepEqual(await connectionRows(), before, 'runtime connection rows keep every pre-0096 value');
    assert.equal((await fixture.db.query('SELECT count(*)::int AS count FROM agent_runtime_bindings')).rows[0].count, 1);
  } finally { await fixture.close(); }
});

test('Focus 0059 is admitted only with its exact recorded nullable timestamptz catalog shape', { timeout: 120_000 }, async () => {
  for (const change of [
    'ALTER TABLE notification_preferences DROP COLUMN paused_until',
    'ALTER TABLE notification_preferences ALTER COLUMN paused_until TYPE integer USING NULL',
    'ALTER TABLE notification_preferences ALTER COLUMN paused_until SET NOT NULL',
  ]) {
    const fixture = await fixtureDatabase();
    try {
      await fixture.db.query(change);
      await refusedUnchanged(fixture, /mismatched accepted Focus 0059 column/);
    } finally { await fixture.close(); }
  }
  const unversioned = await fixtureDatabase();
  try {
    await unversioned.db.query('DELETE FROM flux_schema_version WHERE version=59');
    await refusedUnchanged(unversioned, /unversioned Focus 0059 column/);
  } finally { await unversioned.close(); }
});

test('current main Focus 0059 plus Undo history permits migration startup and repeat without rewriting retained rows', { timeout: 120_000 }, async () => {
  const fixture = await fixtureDatabase();
  try {
    await retainedUndoHistory(fixture.db);
    const before = await retainedUndoSnapshot(fixture.db);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await migrationCli(fixture.name);
      assert.equal(result.code, 0, result.output);
      assertExactMigrationLedger(await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION), await readAppliedMigrationVersions(fixture.db));
      assert.deepEqual(await retainedUndoSnapshot(fixture.db), before, 'accepted current ledger and task history remain unchanged on startup');
    }
  } finally { await fixture.close(); }
});

test('unversioned and partial canonical/focus/Undo footprints refuse despite a numerically known ledger', { timeout: 120_000 }, async () => {
  const changes = [
    'ALTER TABLE agent_runtime_connections ALTER COLUMN account_changed_at TYPE text',
    'ALTER TABLE notification_preferences DROP COLUMN paused_until; DELETE FROM flux_schema_version WHERE version=59; ALTER TABLE notification_preferences ADD COLUMN paused_until integer',
    'DELETE FROM flux_schema_version WHERE version=97',
    'DELETE FROM flux_schema_version WHERE version=96',
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
    'CREATE SCHEMA runtime_auth_impostor; CREATE FUNCTION runtime_auth_impostor.invalidate_runtime_auth_operations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; DROP TRIGGER agent_runtime_auth_lifecycle ON agent_runtime_bindings; CREATE TRIGGER agent_runtime_auth_lifecycle AFTER UPDATE OF state ON agent_runtime_bindings FOR EACH ROW EXECUTE FUNCTION runtime_auth_impostor.invalidate_runtime_auth_operations()',
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
