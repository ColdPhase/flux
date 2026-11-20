import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pool } from './support/db.js';

// #1552 (C-68): nothing unused stays in the schema. Every table, view and sequence of the schema `public` is named by the application's code,
// every column is named in a file that names its table or is used by its table's own constraints, indexes or triggers, and every function is
// called by the code, a trigger, a default, a check, an index, a policy or another function. A redesign removes its old objects (and their
// rows) in the same pull request; what stays on purpose is listed below with its reason. The code is the source of the apps, packages and
// tooling, without tests and migrations: a name only a migration or a test uses is not in use.

/** Objects that the code does not name, kept on purpose. Each needs a reason a reviewer can check. */
const KEPT: Record<string, string> = {
  'column flux_schema_version.applied_at': 'when each migration ran, written by its default: what an operator reads in psql after an upgrade',
  'column agent_runtime_client_history.first_login_at': 'when a binding first signed in to a client, written by its default: the audit trail of the agent runtime (F-022 T4)',
};

const SOURCE_ROOTS = ['apps', 'packages', 'tooling'];
const SKIP = new Set(['node_modules', 'dist', 'migrations', 'test', 'tests', 'native', 'public']);

async function sources(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

async function codeWords(): Promise<{ files: Set<string>[]; all: Set<string> }> {
  const files: Set<string>[] = [];
  const all = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const path of await sources(root)) {
      const words = new Set((await readFile(path, 'utf8')).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      files.push(words);
      for (const word of words) all.add(word);
    }
  }
  return { files, all };
}

const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

type Query = (text: string) => Promise<{ rows: unknown[] }>;

/** The objects of the schema that the code does not use and KEPT does not list, and the stale lines of KEPT. */
async function unusedObjects(query: Query, code: { files: Set<string>[]; all: Set<string> }): Promise<{ unused: string[]; stale: string[] }> {
  const relations = (await query(`SELECT c.relname AS name, c.relkind AS kind FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND c.relname NOT LIKE 'project\\_task\\_number\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))`)).rows as { name: string; kind: string }[];
  const columns = (await query(`SELECT c.relname AS "table", a.attname AS name,
      EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conrelid = c.oid AND a.attnum = ANY (co.conkey) AND co.contype IN ('c', 'p', 'u', 'x')
        AND NOT (co.contype = 'p' AND a.attname = 'id')) OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
        AND (a.attnum = ANY (t.tgattr::int2[]) OR pg_get_triggerdef(t.oid) ~ ('\\m' || a.attname || '\\M'))) AS "byTable"
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`)).rows as { table: string; name: string; byTable: boolean }[];
  const functions = (await query(`SELECT p.proname AS name FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refobjid = p.oid AND d.classid IN ('pg_attrdef'::regclass, 'pg_constraint'::regclass,
      'pg_class'::regclass, 'pg_policy'::regclass, 'pg_rewrite'::regclass))
    AND NOT EXISTS (SELECT 1 FROM pg_proc q WHERE q.oid <> p.oid AND q.pronamespace = 'public'::regnamespace AND q.prosrc ~ ('\\m' || p.proname || '\\M'))`)).rows as { name: string }[];
  // A sequence that a function names (task numbers, events) is used where that function is.
  const functionText = ((await query(`SELECT string_agg(prosrc, ' ') AS text FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).rows[0] as { text: string }).text;

  const unused: string[] = [];
  const kept = (line: string) => line in KEPT;
  for (const relation of relations) {
    const used = code.all.has(relation.name) || code.all.has(camel(relation.name)) || (relation.kind === 'S' && new RegExp(`\\b${relation.name}\\b`).test(functionText));
    const line = `${relation.kind === 'S' ? 'sequence' : 'table'} ${relation.name}`;
    if (!used && !kept(line)) unused.push(line);
  }
  const byTable = new Map<string, Set<string>[]>();
  for (const column of columns) {
    let files = byTable.get(column.table);
    if (!files) { files = code.files.filter((words) => words.has(column.table) || words.has(camel(column.table))); byTable.set(column.table, files); }
    const line = `column ${column.table}.${column.name}`;
    const used = column.byTable || files.some((words) => words.has(column.name) || words.has(camel(column.name)));
    if (!used && !kept(line)) unused.push(line);
  }
  for (const fn of functions) {
    const line = `function ${fn.name}`;
    if (!code.all.has(fn.name) && !kept(line)) unused.push(line);
  }
  const stale = Object.keys(KEPT).filter((line) => {
    const [kind, name] = line.split(' ') as [string, string];
    return !(kind === 'column' ? columns.some((column) => `${column.table}.${column.name}` === name) : kind === 'function' ? true
      : relations.some((relation) => relation.name === name));
  });
  return { unused, stale };
}

test('every table, column, sequence and function of the schema is used by the application, or kept with its reason (#1552)', async () => {
  const code = await codeWords();
  assert.ok(code.files.length > 200, `the application's source is readable here (${code.files.length} files)`);
  const { unused, stale } = await unusedObjects((text) => pool.query(text), code);
  assert.deepEqual(unused, [], `Not used by the application. Remove them in a migration that keeps the data (docs/development/upgrade-compatibility.md), `
    + `or list them in KEPT with the reason:\n${unused.join('\n')}`);
  assert.deepEqual(stale, [], 'KEPT lists objects the schema no longer has: remove them from the list');
});

test('a new table that nothing uses is found (negative control, #1552)', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE public.left_behind_by_a_redesign (id uuid PRIMARY KEY, note text)');
    await client.query('ALTER TABLE public.project_messages ADD COLUMN left_behind_flag boolean');
    const { unused } = await unusedObjects((text) => client.query(text), await codeWords());
    assert.ok(unused.includes('table left_behind_by_a_redesign'), unused.join('\n'));
    assert.ok(unused.includes('column project_messages.left_behind_flag'), unused.join('\n'));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
