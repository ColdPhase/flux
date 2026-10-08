import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { guardFixturePool } from './support/fixture-database.js';

const directory = 'packages/db/migrations';
const legacyDirectory = 'tests/app/support/legacy-migration-fixtures';
type Pool = ReturnType<typeof createDatabase>['pool'];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Invoke the real built entry point; these controls cannot pass through a mocked gate.
async function entrypoint(url: string, entry = 'tooling/dist/migrate.js') {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, DATABASE_URL: url,
      FLUX_AUTH_SECRET: 'semantic-fixture-secret-'.repeat(3), FLUX_PUBLIC_ORIGIN: 'http://127.0.0.1:18979',
      FLUX_AGENT_RUNTIME: '', FLUX_BACKGROUND_COMPARISONS: 'off', FLUX_TEST_PERSONAL_RUNS: '',
      FLUX_FILES_DIR: '/tmp/flux-semantic-fixture-files', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 90_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function fixture(version: number, action: (db: Pool, url: string) => Promise<void>) {
  const name = `flux_semantic_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  let db: Pool | undefined;
  let guard: ReturnType<typeof guardFixturePool> | undefined;
  try {
    await admin.query({ text: `CREATE DATABASE ${quote(name)}`, query_timeout: 60_000 });
    db = createDatabase(url.toString()).pool; guard = guardFixturePool(db);
    const files = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    for (const file of files.filter((file) => file.version <= version)) {
      await db.query({ text: await readFile(join(directory, file.name), 'utf8'), query_timeout: 60_000 });
      await db.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    if (version >= 56) {
      const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID();
      await db.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Historic owner',$2)", [owner, `${owner}@example.test`]);
      await db.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Historic space',$2)", [workspace, owner]);
      await db.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES ($1,$2,'Historic project',$3)", [project, workspace, owner]);
      await db.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Keep the native task','human',$4)",
        [randomUUID(), workspace, project, owner]);
      const binding = randomUUID();
      await db.query("INSERT INTO agent_runtime_slots(slot,state) VALUES ('runtime-1','held')");
      await db.query("INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state) VALUES ($1,$2,'runtime-1','active')", [binding, owner]);
      await db.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,account_label) VALUES ($1,$2,$3,'claude_code','signed_out','h***@example.test')",
        [randomUUID(), owner, binding]);
    }
    await action(db, url.toString());
  } finally {
    guard?.cleanup(); await db?.end();
    await admin.query({ text: `DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`, query_timeout: 60_000 });
    await admin.end();
  }
  guard?.assertNoEarlyErrors();
}

// Catalog, all seeded rows, sequences and pg-boss objects, without reading a shared database.
async function snapshot(db: Pool) {
  const catalog = (await db.query(`SELECT n.nspname, c.relname, c.relkind,
    ARRAY(SELECT a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text || ':' ||
      coalesce(pg_get_expr(d.adbin,d.adrelid),'') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
    ARRAY(SELECT k.conname || ':' || pg_get_constraintdef(k.oid,false) || ':' || k.convalidated::text
      FROM pg_constraint k WHERE k.conrelid=c.oid ORDER BY k.conname) AS constraints,
    ARRAY(SELECT pg_get_triggerdef(t.oid,false) || ':' || t.tgenabled FROM pg_trigger t
      WHERE t.tgrelid=c.oid AND NOT t.tgisinternal ORDER BY t.tgname) AS triggers
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','pgboss') AND c.relkind IN ('r','p','S','v','m') ORDER BY n.nspname,c.relname`)).rows;
  const data: Record<string, string[]> = {};
  for (const row of catalog) {
    if (!['r', 'p', 'S'].includes(row.relkind)) continue;
    const rows = (await db.query(`SELECT to_jsonb(t) AS row FROM ${quote(row.nspname)}.${quote(row.relname)} t`)).rows;
    data[`${row.nspname}.${row.relname}`] = rows.map((row) => JSON.stringify(row.row)).sort();
  }
  const functions = (await db.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,args`)).rows;
  return { catalog, data, functions };
}

async function refuseWithoutWrites(db: Pool, url: string, entry?: string) {
  const before = await snapshot(db);
  const result = await entrypoint(url, entry);
  assert.notEqual(result.code, 0, 'an unsupported footprint must refuse');
  assert.match(result.output, /Flux migration (?:footprint refused|ledger has versions without files)/, result.output);
  assert.deepEqual(await snapshot(db), before, 'refusal keeps catalog, ledger, native data, sequences and queues unchanged');
}

async function legacy(db: Pool, name: string) {
  await db.query({ text: await readFile(join(legacyDirectory, name), 'utf8'), query_timeout: 60_000 });
}

for (const version of [0, 54, 56, 57, 58]) {
  test(`semantic gate admits canonical ${version || 'fresh'} and reaches the exact target without rewriting native rows`, async () => {
    await fixture(version, async (db, url) => {
      const keep = version >= 56 ? (await snapshot(db)).data : {};
      if (version === 57) await db.query("UPDATE agent_runtime_connections SET account_fingerprint=$1, account_changed_at=now(), previous_account_label='p***@example.test'", ['a'.repeat(64)]);
      const connection = version >= 56 ? (await db.query('SELECT * FROM agent_runtime_connections')).rows[0] : null;
      const result = await entrypoint(url); assert.equal(result.code, 0, result.output);
      assert.deepEqual(await readAppliedMigrationVersions(db), (await readMigrationManifest(directory, FLUX_SCHEMA_VERSION)).map((file) => file.version));
      if (connection) {
        const after = (await db.query('SELECT * FROM agent_runtime_connections')).rows[0];
        for (const [key, value] of Object.entries(connection)) assert.deepEqual(after[key], value, `keeps connection ${key}`);
        const data = (await snapshot(db)).data;
        for (const table of ['public.auth_users', 'public.project_work_items', 'public.workspaces', 'public.projects', 'public.agent_runtime_bindings']) {
          assert.deepEqual(data[table], keep[table], `keeps ${table}`);
        }
      }
      const restart = await entrypoint(url); assert.equal(restart.code, 0, restart.output);
    });
  });
}

test('focus-57 with a populated canonical 56 catalog refuses before DDL/queues', async () => fixture(56, async (db, url) => {
  await legacy(db, '0057_notification_pause.sql');
  await db.query('INSERT INTO flux_schema_version(version) VALUES (57)');
  await refuseWithoutWrites(db, url);
}));

for (const recordedFacts of [true, false]) {
  test(`Undo-57 with facts-48 ${recordedFacts ? 'recorded' : 'untracked'} refuses without altering native facts`, async () => fixture(56, async (db, url) => {
    await legacy(db, '0048_unused_ai_task_creation_undo.sql'); await legacy(db, '0057_task_creation_undo_grant.sql');
    if (recordedFacts) await db.query('INSERT INTO flux_schema_version(version) VALUES (48)');
    await db.query('INSERT INTO flux_schema_version(version) VALUES (57)');
    await db.query("UPDATE project_work_items SET creation_origin='human',creation_baseline_version=1,creation_baseline='{}'");
    await refuseWithoutWrites(db, url);
  }));
}

const badCatalogs: [string, number, string][] = [
  ['untracked sign-in column', 56, 'ALTER TABLE agent_runtime_connections ADD COLUMN account_fingerprint text'],
  ['partial sign-in 57', 57, 'ALTER TABLE agent_runtime_connections DROP COLUMN signed_out_at CASCADE'],
  ['wrong sign-in type', 57, 'ALTER TABLE agent_runtime_connections ALTER COLUMN account_changed_at TYPE timestamp'],
  ['wrong sign-in nullability', 57, 'ALTER TABLE agent_runtime_connections ALTER COLUMN sign_out_failed SET DEFAULT false; UPDATE agent_runtime_connections SET signed_out_at=now(),sign_out_failed=false; ALTER TABLE agent_runtime_connections ALTER COLUMN sign_out_failed SET NOT NULL'],
  ['weakened sign-in privacy check', 57, 'ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_fingerprint_check; ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_fingerprint_check CHECK (true)'],
  ['unvalidated sign-in check', 57, "ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_notice_check; ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_notice_check CHECK (account_changed_at IS NOT NULL OR previous_account_label IS NULL) NOT VALID"],
  ['wrong baseline 56 type', 56, 'ALTER TABLE agent_runtime_connections ALTER COLUMN signed_in_at TYPE timestamp'],
  ['weakened baseline privacy check', 56, 'ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_account_label_check; ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_account_label_check CHECK (true)'],
  ['mixed focus and sign-in 57', 57, 'ALTER TABLE notification_preferences ADD COLUMN paused_until timestamptz'],
  ['untracked partial auth 58', 57, 'CREATE TABLE agent_runtime_console_nonces(nonce_digest text)'],
  ['missing auth 58 table', 58, 'DROP TABLE agent_runtime_console_nonces'],
  ['wrong auth 58 type', 58, 'ALTER TABLE agent_runtime_auth_operations ALTER COLUMN revision TYPE bigint'],
  ['weakened auth 58 check', 58, 'ALTER TABLE agent_runtime_auth_operations DROP CONSTRAINT agent_runtime_auth_operations_revision_check; ALTER TABLE agent_runtime_auth_operations ADD CONSTRAINT agent_runtime_auth_operations_revision_check CHECK (true)'],
  ['missing auth 58 lifecycle fence', 58, 'DROP TRIGGER agent_runtime_auth_lifecycle ON agent_runtime_bindings'],
  ['altered auth 58 lifecycle function', 58, 'CREATE OR REPLACE FUNCTION invalidate_runtime_auth_operations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'],
];
for (const [label, version, sql] of badCatalogs) {
  test(`${label} refuses before any migrator write`, async () => fixture(version, async (db, url) => {
    await db.query(sql); await refuseWithoutWrites(db, url);
  }));
}

test('fresh ledger with untracked runtime objects refuses before bootstrap creates a ledger', async () => fixture(0, async (db, url) => {
  await db.query('CREATE TABLE agent_runtime_connections(account_fingerprint text)');
  await refuseWithoutWrites(db, url);
  assert.equal((await db.query("SELECT to_regclass('flux_schema_version') AS ledger")).rows[0].ledger, null);
}));

for (const entry of ['apps/server/dist/index.js', 'apps/worker/dist/index.js']) {
  test(`${entry} refuses a complete numeric ledger with partial 58 before queue startup`, async () => fixture(58, async (db, url) => {
    await db.query('DROP TABLE agent_runtime_console_nonces');
    await refuseWithoutWrites(db, url, entry);
  }));
}
