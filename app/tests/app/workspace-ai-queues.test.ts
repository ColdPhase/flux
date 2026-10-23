import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import * as contracts from '@flux/contracts';
import { AI_ADJACENT_ROUTES, AI_HTTP_ROUTES, AI_NAMED_ROUTE_MODULES, AI_WORK_QUEUES } from '@flux/contracts';
import { pool } from './support/db.js';

// F-029 workspace AI lock (#614): the inventory of AI work is complete. Every job the worker registers is classified, every
// AI work table has its epoch and backstop, and no other table or trigger has them; anything new fails here.

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

test('every worker job is classified as AI work or not', async () => {
  const registered = new Set<string>();
  for (const file of await sources('apps/worker/src')) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/boss\.(?:work|schedule)(?:<[^>]*>)?\(\s*([A-Za-z_]+)/g)) registered.add(match[1]!);
  }
  assert.ok(registered.size >= 8, `the scan finds the worker's jobs (${[...registered].join(', ')})`);
  const classified = new Set<string>([...AI_WORK_QUEUES.ai, ...Object.keys(AI_WORK_QUEUES.notAi)]);
  for (const [name, reason] of Object.entries(AI_WORK_QUEUES.notAi)) assert.ok(reason.length > 20, `${name} names its reason`);
  assert.deepEqual([...registered].filter((name) => !classified.has(name)).sort(), [], 'unclassified jobs');
  assert.deepEqual([...classified].filter((name) => !registered.has(name)).sort(), [], 'listed jobs the worker no longer registers');
});

test('exactly the AI work tables carry ai_epoch and the ai_work_admission backstop', async () => {
  const columns = (await pool.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'ai_epoch' ORDER BY 1`)).rows
    .map((row) => row.table_name as string);
  assert.deepEqual(columns, [...AI_WORK_QUEUES.tables].sort());
  const triggers = (await pool.query(`SELECT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid WHERE n.nspname = 'public' AND p.proname = 'ai_work_admission' ORDER BY 1`)).rows.map((row) => row.table_name as string);
  assert.deepEqual(triggers, [...AI_WORK_QUEUES.tables].sort());
  // Every function that writes AI work from a person's own write reads the policy first.
  for (const name of AI_WORK_QUEUES.captureFunctions) {
    const body = (await pool.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name])).rows[0]?.prosrc as string;
    assert.match(body, /workspace_ai_policies/, `${name} checks the policy`);
  }
  const writers = (await pool.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    AND p.proname <> 'ai_work_admission' AND p.prosrc ~* ANY ($1)`, [AI_WORK_QUEUES.tables.map((table) => `insert\\s+into\\s+${table}\\y`)])).rows.map((row) => row.proname as string);
  assert.deepEqual(writers.sort(), [...AI_WORK_QUEUES.captureFunctions].sort(), 'no other database function inserts AI work');
});

// The routes of the modules the contract's enforcement tables name that `aiRoutes` does not wrap (consent context, agent roster, project
// people and grants, Needs you, the Inbox, notification settings): each is classified in AI_ADJACENT_ROUTES, and a new one fails here.
test('every route of the modules named in the enforcement tables is classified', async () => {
  const constants = contracts as unknown as Record<string, unknown>;
  const resolve = (expression: string): string | null => {
    const text = expression.trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(text)) return typeof constants[text] === 'string' ? constants[text] as string : null;
    const literal = /^(['`])(.*)\1$/.exec(text);
    if (!literal) return null;
    let unresolved = false;
    const value = literal[2]!.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_all, name: string) => { const found = constants[name]; if (typeof found !== 'string') unresolved = true; return String(found); });
    return unresolved ? null : value;
  };
  const found = new Set<string>();
  for (const file of AI_NAMED_ROUTE_MODULES) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\bapp\.(get|post|put|patch|delete)(?:<[^()]*>)?\(\s*('[^']*'|`[^`]*`|[A-Z][A-Z0-9_]*)/g)) {
      const path = resolve(match[2]!);
      assert.ok(path, `${file}: cannot resolve the path ${match[2]}`);
      found.add(`${match[1]!.toUpperCase()} ${path}`);
    }
  }
  assert.ok(found.size >= 25, `the scan finds the modules' routes (${found.size})`);
  const classified = new Set([...Object.keys(AI_ADJACENT_ROUTES)]);
  assert.deepEqual([...found].filter((route) => !classified.has(route) && !(route in AI_HTTP_ROUTES)).sort(), [], 'unclassified routes in the named modules');
  assert.deepEqual([...classified].filter((route) => !found.has(route)).sort(), [], 'listed routes no named module registers');
  assert.deepEqual(Object.keys(AI_ADJACENT_ROUTES).filter((route) => route in AI_HTTP_ROUTES), [], 'a route is classified in one list');
});
