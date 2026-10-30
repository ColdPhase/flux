import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { EVENT_DATA_KEYS, EVENT_DATA_TOKENS, IDEMPOTENCY_ACCOUNT_OPERATIONS } from '@flux/contracts';
import { SEALED_COLUMNS, TABLE_CLASSES, VISIBLE_COLUMNS, workspaceEncryptionRows, type DbExecutor } from '@flux/db';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, pool } from './support/db.js';
import { createSealed, passphrase } from './support/encryption.js';
import { sealedSqlFindings } from './support/sealed-sql-scan.js';
import { person, workspace, type Person } from './support/people.js';

// AC-5 of F-030, S2a-1 part (#655; docs/product/encrypted-workspaces.md#inventory): the registry against the LIVE catalog
// after all migrations (default-deny), each sealed table's plaintext backstop with exactly the registry's columns, the
// refusal of plaintext in every sealed column of A while B passes, the SQL copies of sealed columns (only the allowed
// ones, each with its reason), `preserve_draft_version` writing nothing for A, and the late heartbeat's SQL (S1 review).
// S2a-2 adds the notification, event and account-idempotency backstops and the SQL source scan.

const FIELD_TYPES = new Set(['text', 'jsonb', 'json', 'ARRAY', 'character varying', 'bytea']);
let ada: Person;
let A: string; let B: string;

before(async () => {
  ada = await person('Ada');
  A = (await createSealed(ada, 'Garden club', passphrase())).workspace.id;
  B = (await workspace(ada, 'Book club')).id;
});

async function liveColumns() {
  const rows = (await pool.query<{ table_name: string; column_name: string; data_type: string }>(`SELECT table_name, column_name, data_type
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY table_name, ordinal_position`)).rows;
  const byTable = new Map<string, { column: string; type: string }[]>();
  for (const row of rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), { column: row.column_name, type: row.data_type }]);
  return byTable;
}

describe('F-030 registry against the live catalog', () => {
  test('every table has a class; every class names a live table', async () => {
    const live = await liveColumns();
    assert.deepEqual([...live.keys()].filter((name) => !TABLE_CLASSES[name]), [], 'unclassified tables');
    assert.deepEqual(Object.keys(TABLE_CLASSES).filter((name) => !live.has(name)), [], 'classified tables that do not exist');
  });

  test('every text, jsonb or array column of a content table is sealed or visible with a reason (default-deny)', async () => {
    const live = await liveColumns();
    const missing: string[] = []; const stale: string[] = [];
    for (const [table, columns] of live) {
      if (TABLE_CLASSES[table] !== 'content') continue;
      const sealed = SEALED_COLUMNS[table]?.columns ?? {};
      const visible = VISIBLE_COLUMNS[table] ?? {};
      for (const { column, type } of columns) {
        if (column in sealed && column in visible) missing.push(`${table}.${column} is both sealed and visible`);
        if (FIELD_TYPES.has(type) && !(column in sealed) && !(column in visible) && !/^(id|.*_id|.*_ids)$/.test(column)) missing.push(`${table}.${column} (${type})`);
      }
      const names = new Set(columns.map((c) => c.column));
      for (const column of [...Object.keys(sealed), ...Object.keys(visible)]) if (!names.has(column)) stale.push(`${table}.${column}`);
      for (const [column, reason] of Object.entries(visible)) assert.ok(reason.length >= 3, `${table}.${column}: a reason`);
    }
    assert.deepEqual(missing, [], 'unclassified content columns');
    assert.deepEqual(stale, [], 'registered columns that do not exist');
    for (const table of Object.keys(SEALED_COLUMNS)) assert.equal(TABLE_CLASSES[table], 'content', `${table} is a content table`);
  });

  test('each sealed table has its plaintext backstop with exactly the registry\'s workspace path and columns', async () => {
    const rows = (await pool.query<{ table: string; args: string }>(`SELECT c.relname AS table, encode(t.tgargs, 'escape') AS args FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'z_sealed_backstop' AND NOT t.tgisinternal`)).rows;
    const live = new Map(rows.map((row) => [row.table, row.args.split('\\000').filter(Boolean)]));
    for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
      const path = entry.workspace === 'workspace_id' ? 'workspace_id' : `via:${entry.workspace.column}:${entry.workspace.table}:${entry.workspace.key}`;
      assert.deepEqual(live.get(table), [path, ...Object.keys(entry.columns)], table);
    }
    assert.deepEqual([...live.keys()].filter((table) => !SEALED_COLUMNS[table]), [], 'a backstop outside the registry');
  });

  test('a GitHub table with a workspace path refuses a row of A (a_sealed_workspace_refused)', async () => {
    const guarded = (await pool.query<{ table: string }>(`SELECT DISTINCT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'a_sealed_workspace_refused'`)).rows.map((row) => row.table).sort();
    const refused = Object.entries(TABLE_CLASSES).filter(([, cls]) => cls === 'refused').map(([table]) => table);
    const withPath = (await pool.query<{ table: string }>(`SELECT DISTINCT table_name AS table FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name IN ('workspace_id', 'project_id')`, [refused])).rows.map((row) => row.table).sort();
    assert.deepEqual(guarded, withPath);
    await assert.rejects(pool.query(`INSERT INTO github_rule_defaults (workspace_id) VALUES ($1)`, [A]), { hint: 'WORKSPACE_ENCRYPTED_UNSUPPORTED' });
  });

  test('plaintext in every sealed column of A is refused, naming the column and never the value; an envelope passes; B passes', async () => {
    const envelope = `fx1.1.${'A'.repeat(40)}`;
    const types = await liveColumns();
    for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
      for (const column of Object.keys(entry.columns)) {
        // A copy of the table's shape with the real trigger function and arguments, so each column is tried alone.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const type = types.get(table)!.find((c) => c.column === column)!.type;
          const sqlType = type === 'ARRAY' ? 'text[]' : type;
          const via = entry.workspace === 'workspace_id' ? null : entry.workspace;
          let path = 'workspace_id';
          if (via) {
            await client.query(`CREATE TEMP TABLE parent_row (id uuid PRIMARY KEY, workspace_id uuid)`);
            path = `via:${via.column}:parent_row:id`;
          }
          const owner = via ? via.column : 'workspace_id';
          await client.query(`CREATE TEMP TABLE probe (${owner} uuid, ${column} ${sqlType})`);
          const args = [path, column].map((arg) => `'${arg}'`).join(', ');
          await client.query(`CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON probe FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop(${args})`);
          const plain = sqlType === 'jsonb' ? JSON.stringify({ secret: 'plain words' }) : 'plain words';
          const sealed = sqlType === 'jsonb' ? JSON.stringify({ $sealed: envelope }) : envelope;
          for (const ws of [A, B]) {
            const ref = via ? randomUUID() : ws;
            if (via) await client.query(`INSERT INTO parent_row VALUES ($1, $2)`, [ref, ws]);
            await client.query('SAVEPOINT s');
            const refused = await client.query(`INSERT INTO probe VALUES ($1, $2)`, [ref, plain]).then(() => null, (error: { hint?: string; message: string }) => error);
            if (!refused) {
              assert.equal(ws, B, `${table}.${column}: plaintext was stored for A`);
            } else {
              const e = refused;
              assert.equal(ws, A, `${table}.${column}: B refused (${e.message})`);
              assert.equal(e.hint, 'WORKSPACE_PLAINTEXT_REFUSED', `${table}.${column}: ${e.message}`);
              assert.match(e.message, new RegExp(`probe\\.${column}$`));
              assert.equal(e.message.includes('plain words'), false);
              await client.query('ROLLBACK TO SAVEPOINT s');
            }
            await client.query(`INSERT INTO probe VALUES ($1, $2), ($1, NULL)`, [ref, sealed]);
            if (sqlType === 'text') await client.query(`INSERT INTO probe VALUES ($1, '')`, [ref]);
          }
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
    }
  });

  test('flux_is_sealed accepts only an envelope or {"$sealed": envelope}', async () => {
    const cases: [string, boolean][] = [[`'fx1.1.${'A'.repeat(38)}'::text`, true], [`'fx1.0.${'A'.repeat(38)}'::text`, false], [`'fx1.1.${'A'.repeat(37)}'::text`, false],
      [`'fx1.1.${'A'.repeat(38)}!'::text`, false], [`'plain'::text`, false], [`'{"$sealed":"fx1.2.${'B'.repeat(40)}"}'::jsonb`, true],
      [`'{"$sealed":"fx1.2.${'B'.repeat(40)}","x":1}'::jsonb`, false], [`'{"$sealed":"plain"}'::jsonb`, false], [`'["fx1.1.${'A'.repeat(40)}"]'::jsonb`, false], [`'"fx1.1.${'A'.repeat(40)}"'::jsonb`, true],
      [`'{"secret":"plain words"}'::jsonb`, false], [`'{}'::jsonb`, false], [`'[]'::jsonb`, false], [`'"plain"'::jsonb`, false], [`'7'::jsonb`, false]];
    for (const [literal, expected] of cases) assert.strictEqual((await pool.query(`SELECT flux_is_sealed(${literal}) AS ok`)).rows[0].ok, expected, `${literal}: never NULL`);
  });

  test('SQL reads a sealed column only in the allowed trigger functions, and copies none for a sealed workspace', async () => {
    const allowed: Record<string, string> = {
      preserve_draft_version: 'returns before the copy for a sealed workspace (0120); the drafts repository writes the sealed version',
      flux_capture_artifact_mutation: 'compares only (IS DISTINCT FROM); its triggers skip a sealed workspace (WHEN, 0120)',
      flux_guard_task_creation_history: 'compares only (IS DISTINCT FROM): no value leaves the row',
      assistant_task_reaction_tap: 'AI: compares only, and no reaction exists for a sealed workspace (F-029 forced off)',
      search_index_decision: 'search_put stores a placeholder without title or body for a sealed workspace (0120)',
      search_index_dm_message: 'as search_index_decision', search_index_draft: 'as search_index_decision', search_index_material_version: 'as search_index_decision',
      search_index_message: 'as search_index_decision', search_index_project: 'as search_index_decision', search_index_result: 'as search_index_decision',
      search_index_sketch: 'as search_index_decision', search_index_thought: 'as search_index_decision', search_index_work: 'as search_index_decision',
    };
    const found = new Set<string>();
    for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
      for (const column of Object.keys(entry.columns)) {
        const rows = (await pool.query<{ name: string }>(`SELECT DISTINCT p.proname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE c.relname = $1 AND NOT t.tgisinternal AND p.proname <> 'flux_sealed_backstop' AND p.prosrc ~* ('(NEW|OLD)\\.' || $2 || '\\M')`, [table, column])).rows;
        for (const row of rows) found.add(row.name);
      }
    }
    assert.deepEqual([...found].filter((name) => !allowed[name]).sort(), [], 'a trigger function that reads a sealed column must be moved to the application or allowed here');
    // preserve_draft_version: nothing for A; a row for B.
    for (const [ws, expected] of [[A, 0], [B, 1]] as const) {
      const id = randomUUID();
      await pool.query(`INSERT INTO drafts (id, workspace_id, owner_user_id, title, body, created_by) VALUES ($1, $2, $3, $4, $4, $3)`,
        [id, ws, ada.id, ws === A ? `fx1.1.${'C'.repeat(40)}` : 'Plain title']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM draft_versions WHERE draft_id = $1`, [id])).rows[0].n, expected);
    }
  });
});

describe('F-030 pinned search_path (S2a-2a review P2-1)', () => {
  test('every function that decides on a seal runs with an explicit search_path: pg_catalog first, no "$user", pg_temp last', async () => {
    const rows = (await pool.query<{ fn: string; config: string[] | null }>(`SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND (p.prosrc ~ '(workspace_sealed|flux_is_sealed)'
        OR p.proname IN ('workspace_sealed', 'flux_is_sealed', 'search_change_log', 'idempotency_scope_required'))
      ORDER BY 1`)).rows;
    assert.ok(rows.length >= 9, `sealing functions found: ${rows.length}`);
    for (const name of ['search_put', 'workspace_ai_policy_encrypted', 'flux_sealed_backstop', 'sealed_workspace_no_ai', 'preserve_draft_version',
      'search_change_log', 'idempotency_scope_required'])
      assert.ok(rows.some((row) => row.fn.startsWith(`${name}(`)), `${name} is among them`);
    const unpinned = rows.filter((row) => {
      const path = (row.config ?? []).find((entry) => entry.startsWith('search_path='));
      return path !== 'search_path=pg_catalog, public, pg_temp';
    }).map((row) => `${row.fn}: ${JSON.stringify(row.config)}`);
    assert.deepEqual(unpinned, []);
  });

  test('a shadowing workspace_sealed in a schema named after the role, or first in the session\'s path, changes nothing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const role = (await client.query<{ name: string }>('SELECT current_user AS name')).rows[0]!.name;
      for (const schema of [role, 'evil']) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await client.query(`CREATE FUNCTION "${schema}".workspace_sealed(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
      }
      await client.query(`SET LOCAL search_path = evil, "$user", public`);
      await client.query(`SELECT search_put('probe:y', 'work', $1, 'aud', NULL, 'o', NULL, 1, 'open', 'plain-title', 'plain-body', 'human', 'x', now())`, [A]);
      assert.deepEqual((await client.query(`SELECT sealed, title FROM search_documents WHERE doc_key = 'probe:y'`)).rows[0], { sealed: true, title: '' });
      await client.query('SAVEPOINT t');
      await assert.rejects(client.query(`UPDATE workspace_ai_policies SET state = 'allowed' WHERE workspace_id = $1`, [A]), { hint: 'WORKSPACE_ENCRYPTED_AI_OFF' });
      await client.query('ROLLBACK TO SAVEPOINT t');
      await assert.rejects(client.query(`INSERT INTO projects (id, workspace_id, name, created_by) VALUES (gen_random_uuid(), $1, 'plain', $2)`, [A, ada.id]),
        { hint: 'WORKSPACE_PLAINTEXT_REFUSED' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

describe('F-030 idempotency scopes (S2a-2)', () => {
  test('the database list of account operations is the contract\'s; an unscoped row of any other operation is refused', async () => {
    const live = (await pool.query<{ operation: string }>('SELECT operation FROM idempotency_account_operations ORDER BY operation')).rows.map((row) => row.operation);
    assert.deepEqual(live, Object.keys(IDEMPOTENCY_ACCOUNT_OPERATIONS).sort());
    for (const reason of Object.values(IDEMPOTENCY_ACCOUNT_OPERATIONS)) assert.ok(reason.length > 10);
    const insert = (operation: string, workspaceId: string | null) => pool.query(`INSERT INTO idempotency_keys (id, principal, workspace_id, operation, key, request_hash,
      response_status, response_body, expires_at) VALUES ($1, 'human:x', $2, $3, $4, 'h', 200, 'null', now() + interval '1 hour')`, [randomUUID(), workspaceId, operation, randomUUID()]);
    await assert.rejects(insert('PATCH /api/v1/docs/:docId', null), { hint: 'IDEMPOTENCY_SCOPE_REQUIRED' });
    await insert('POST /api/v1/workspaces', null);
    await insert('PATCH /api/v1/docs/:docId', B);
    await assert.rejects(insert('PATCH /api/v1/docs/:docId', A), { hint: 'WORKSPACE_PLAINTEXT_REFUSED' }, 'a row of A needs a sealed body');
  });

  test('every command declares a scope: no route passes scope null; account scopes stay in the list\'s modules', async () => {
    const files: string[] = [];
    const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (path.endsWith('.ts')) files.push(path); } };
    await walk('apps/server/src');
    const unscoped: string[] = []; const account: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/operation:[^\n]*scope: null/.test(text)) unscoped.push(file);
      if (/scope: 'account'/.test(text)) account.push(file);
    }
    assert.deepEqual(unscoped, []);
    assert.deepEqual(account.sort(), ['apps/server/src/access/workspaces.ts', 'apps/server/src/agent-connection/agent-questions.ts', 'apps/server/src/personal-runs/routes.ts']);
  });
});

describe('F-030 late heartbeat SQL (S1 review P3)', () => {
  test('a stale boot\'s rows go, rows written after the observation stay, and a workspace missing a live version\'s row is dropped whole', async () => {
    const rows = workspaceEncryptionRows(db as unknown as DbExecutor);
    const [current, old] = [randomUUID(), randomUUID()];
    const [stale, fresh, partial, late] = await Promise.all(['Stale', 'Fresh', 'Partial', 'Late'].map(async (label) =>
      (await createSealed(await person(label), `${label} club`, passphrase())).workspace.id));
    const observedAt = new Date(Date.now() - 60_000);
    const before = new Date(observedAt.getTime() - 60_000).toISOString();
    const after = new Date(observedAt.getTime() + 30_000).toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM workspace_unlocks WHERE workspace_id = ANY($1)`, [[stale, fresh, partial, late]]);
      // Version 2 is live but has no unlock row (a Lock raced a rotation's start): the workspace counts as locked.
      await client.query(`UPDATE workspace_keys SET live_versions = '{1,2}', current_version = 2 WHERE workspace_id = $1`, [partial]);
      const add = (ws: string, version: number, boot: string, at: string) =>
        client.query(`INSERT INTO workspace_unlocks (workspace_id, key_version, boot_id, sealed_dek, unlocked_at) VALUES ($1, $2, $3, 'x', $4)`, [ws, version, boot, at]);
      await add(stale, 1, old, before);
      await add(fresh, 1, current, before);
      await add(late, 1, old, after); // written by a newer boot than the caller saw: never touched
      await add(partial, 1, current, before);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const dropped = await rows.dropStaleUnlocks(current, observedAt);
    const droppedIds = dropped.map((row) => row.workspaceId).filter((id) => [stale, fresh, partial, late].includes(id)).sort();
    assert.deepEqual(droppedIds, [stale, partial].sort());
    const left = (await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM workspace_unlocks WHERE workspace_id = ANY($1) ORDER BY workspace_id`,
      [[stale, fresh, partial, late]])).rows.map((row) => row.workspace_id);
    assert.deepEqual(left.sort(), [fresh, late].sort());
  });
});

describe('F-030 events backstop (S2a-2c-3, migration 0125)', () => {
  test('event_data_tokens holds exactly EVENT_DATA_TOKENS of packages/contracts', async () => {
    const rows = (await pool.query<{ token: string }>('SELECT token FROM event_data_tokens ORDER BY token COLLATE "C"')).rows.map((row) => row.token);
    assert.deepEqual(rows, [...EVENT_DATA_TOKENS].sort());
    const keys = (await pool.query<{ key: string }>('SELECT key FROM event_data_keys ORDER BY key COLLATE "C"')).rows.map((row) => row.key);
    assert.deepEqual(keys, [...EVENT_DATA_KEYS].sort(), 'event_data_keys holds exactly EVENT_DATA_KEYS');
  });

  test('an event of A carries only ids, timestamps, envelopes, accounts, principals and registered tokens; B is unchanged', async () => {
    const insert = (ws: string, data: unknown) => pool.query(`INSERT INTO events (id, kind, object_id, actor_id, data, workspace_id)
      VALUES (gen_random_uuid(), 'test.event.v1', gen_random_uuid(), $1, $2, $3)`, [`human:${ada.id}`, JSON.stringify(data), ws]);
    await insert(A, { messageId: randomUUID(), at: new Date().toISOString(), by: ada.id, actor: `human:${ada.id}`, op: 'thought_added',
      changes: { items: ['restart', randomUUID()], title: { $sealed: `fx1.1.${'C'.repeat(40)}` } }, total: 3, ok: true, value: null });
    for (const [label, data] of [['a free word', { op: 'secret' }], ['a nested free word', { changes: { items: ['restart', 'plan b'] } }],
      ['an unknown account', { by: 'not-a-user' }], ['an unknown agent', { actor: `agent:${randomUUID()}` }],
      ['a principal of an unknown account', { actor: 'human:nobody' }], ['an envelope-like word', { title: 'fx1.1.short' }],
      ['a free key value under $sealed', { title: { $sealed: 'plain words' } }], ['a date that is not a timestamp', { at: '2026-10-29 secret' }]] as const) {
      await assert.rejects(insert(A, data), { hint: 'EVENT_CONTENT_REFUSED' }, label);
    }
    await insert(B, { op: 'secret', title: 'Plain title' });
    // #721 review P2-1: object keys follow the same rule, at any depth; a UUID key and "$sealed" pass.
    await insert(A, { messageId: randomUUID(), [randomUUID()]: 'restart', changes: { items: [{ op: 'renamed' }] } });
    for (const [label, data] of [['a free word as a key', { 'secret words': 'accepted' }], ['a free key in a list', { items: [{ secret: 'restart' }] }],
      ['a nested free key', { changes: { 'plan b': true } }]] as const) {
      await assert.rejects(insert(A, data), { hint: 'EVENT_CONTENT_REFUSED' }, label);
    }
    // P3-3: the actor and the kind are shapes, an update is checked like an insert, and the audience names principals.
    const raw = (ws: string, actor: string, kind: string) => pool.query(`INSERT INTO events (id, kind, object_id, actor_id, data, workspace_id)
      VALUES (gen_random_uuid(), $2, gen_random_uuid(), $1, '{}', $3) RETURNING id`, [actor, kind, ws]);
    await assert.rejects(raw(A, 'secret words', 'test.event.v1'), { hint: 'EVENT_CONTENT_REFUSED' }, 'a free actor');
    await assert.rejects(raw(A, `human:${ada.id}`, 'secret words'), { hint: 'EVENT_CONTENT_REFUSED' }, 'a free kind');
    const { rows: [event] } = await raw(A, `human:${ada.id}`, 'test.event.v1');
    await assert.rejects(pool.query(`UPDATE events SET data = '{"op": "secret"}' WHERE id = $1`, [event.id]), { hint: 'EVENT_CONTENT_REFUSED' }, 'an update');
    await assert.rejects(pool.query(`INSERT INTO event_audience (recipient, seq, event_id) SELECT 'secret words', seq, id FROM events WHERE id = $1`, [event.id]),
      { hint: 'EVENT_CONTENT_REFUSED' }, 'a free audience row');
    await pool.query(`INSERT INTO event_audience (recipient, seq, event_id) SELECT $2, seq, id FROM events WHERE id = $1`, [event.id, `human:${ada.id}`]);
    await raw(B, 'secret words', 'secret words');
  });

  test('a sealed job wait carries {eventId} only (#717 review P3-5)', async () => {
    const wait = (payload: unknown) => pool.query(`INSERT INTO sealed_job_waits (id, workspace_id, queue, payload) VALUES (gen_random_uuid(), $1, 'notifications.generate', $2)`,
      [A, JSON.stringify(payload)]);
    await wait({ eventId: randomUUID() });
    await assert.rejects(pool.query(`INSERT INTO sealed_job_waits (id, workspace_id, queue, payload) VALUES (gen_random_uuid(), $1, 'secret words', $2)`,
      [A, JSON.stringify({ eventId: randomUUID() })]), { hint: 'EVENT_CONTENT_REFUSED' }, 'a free queue');
    for (const payload of [{ text: 'secret' }, { eventId: 'secret' }, { eventId: randomUUID(), note: 'secret' }, ['x']]) {
      await assert.rejects(wait(payload), { hint: 'EVENT_CONTENT_REFUSED' }, JSON.stringify(payload));
    }
    await pool.query(`DELETE FROM sealed_job_waits WHERE workspace_id = $1`, [A]);
  });
});

/**
 * AC-5 SQL source scan (S2a-2c-3): each place where SQL computes over a sealed column, with how a sealed workspace is
 * handled there. A finding not listed fails, and so does a listed one the scan no longer finds.
 */
const HANDLED_SQL: Readonly<Record<string, string>> = {
  'packages/db/src/repositories/agent-orientation.ts: SELECT m.id, left(v.title, 300)': 'agent orientation: an encrypted workspace has no agents (AI always off)',
  'packages/db/src/repositories/agent-orientation.ts: SELECT c.id, coalesce(left(m.body, 300)': 'agent orientation: an encrypted workspace has no agents (AI always off)',
  'packages/db/src/repositories/live-editing.ts: const sizes = await db.select({ sequence: u.sequence, size: sql<number>`octet_length(${u.bytes})': 'the stored size of an update (S2b: a sealed update\'s length is metadata, its bytes stay sealed)',
  'packages/db/src/repositories/live-map.ts: const [size]=await db.select({bytes:sql<number>`COALESCE(sum(octet_length(${j.change}': 'the stored size of the journal (S2b: a sealed change\'s length is metadata)',
  'packages/db/src/repositories/project-export.ts: .where(byId ? or(byId, eq(schema.projects.name, value))': 'export by name: an envelope never equals a typed name; ./flux export refuses A and the API passes the id',
  'packages/db/src/repositories/search.ts: CASE WHEN d.id IS NULL THEN NULL WHEN d.title IS NOT NULL THEN d.title': 'a null test only; the title is opened by the application',
  'packages/db/src/repositories/sketches.ts: withContent = sql`(EXISTS (SELECT 1 FROM ${t} WHERE ${t.sketchId} = ${s.id}) OR btrim(${s.title})': 'plain workspaces only: for a sealed one the bare maps are opened and filtered in the application (S2b)',
  'packages/db/src/repositories/work-read-associations.ts: WHEN \'message\' THEN (SELECT left(split_part(btrim(o.body)': 'edges(): for a sealed workspace the titles are replaced by opened ones (workRows.titles)',
  'packages/db/src/repositories/work-read-associations.ts: WHEN \'thought\' THEN (SELECT left(split_part(btrim(t.text)': 'edges(): for a sealed workspace the titles are replaced by opened ones (workRows.titles)',
  'packages/db/src/repositories/work-read-keys.ts: parts.push(sql`SELECT \'decision\'::text AS kind': 'task text filter: for a sealed workspace the opened rows are filtered in the application',
  'packages/db/src/repositories/work-read-keys.ts: parts.push(sql`SELECT \'result\'::text AS kind': 'task text filter: for a sealed workspace the opened rows are filtered in the application',
  'packages/db/src/repositories/work-read-keys.ts: parts.push(sql`SELECT \'work\'::text AS kind': 'task text filter: for a sealed workspace the opened rows are filtered in the application',
  'packages/db/src/repositories/work.ts: const [row] = await db.select({ matches: sql<boolean>`${w.creationBaseline} = jsonb_build_object(': 'creationBaselineMatches: a sealed row is compared after openRow (baselineMatches)',
  'packages/db/src/repositories/work.ts: baselineMatches: sql<boolean>`COALESCE(${w.creationBaseline} = jsonb_build_object(': 'creationUndoFacts: a sealed row is recomputed after openRow (baselineMatches)',
};

describe('F-030 AC-5 SQL source scan (S2a-2c-3)', () => {
  test('no SQL computes over a sealed column except the handled sites', async () => {
    const findings = await sealedSqlFindings();
    const handled = Object.keys(HANDLED_SQL);
    const unhandled = findings.filter((finding) => !handled.some((prefix) => finding.startsWith(prefix)));
    assert.deepEqual(unhandled, [], 'every computation over a sealed column needs a sealed-workspace path');
    const stale = handled.filter((prefix) => !findings.some((finding) => finding.startsWith(prefix)));
    assert.deepEqual(stale, [], 'a handled site the scan no longer finds is removed from the list');
    assert.ok(findings.length >= 10, `the scan finds the known sites (${findings.length})`);
  });
});
