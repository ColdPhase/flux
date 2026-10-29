import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { SEALED_COLUMNS, type SealedTable } from '../sealed-columns.js';

/**
 * Rows of a key rotation (F-030 S2c, #655; docs/product/encrypted-workspaces.md#the-state-machine). Every table and
 * column comes from the S2a registry (`SEALED_COLUMNS`), so a table a later slice registers is re-encrypted, sampled and
 * checked by the finish without a change here. Satisfies core's `KeyRotationRepository` structurally. No key here.
 *
 * The version test is a prefix test on the visible envelope header (`fx1.<v>.`), which needs no key: a value is stale
 * when it is an envelope whose version is not the current one (no envelope has a newer one).
 */
type Kind = 'text' | 'json' | 'digest';
interface Column { column: string; field: string; kind: Kind }

const rowsOf = async <T>(db: DbExecutor, query: SQL) => (await db.execute(query)).rows as unknown as T[];
const id = (name: string) => sql.identifier(name);

/** The registry in its fixed order (the pass's steps). */
export function rotationTables(): { table: string; columns: Column[] }[] {
  return Object.entries(SEALED_COLUMNS).map(([table, entry]) => ({
    table, columns: Object.entries(entry.columns).map(([column, spec]) => ({ column, field: spec.field, kind: spec.kind })),
  }));
}

/** The column's envelope as text: the string itself, or `$sealed` of a jsonb value. */
function envelopeText(column: string, kind: Kind): SQL {
  return kind === 'json' ? sql`(t.${id(column)} ->> '$sealed')` : sql`t.${id(column)}`;
}
function staleTest(column: string, kind: Kind, current: number): SQL {
  const text = envelopeText(column, kind);
  return sql`(${text} LIKE 'fx1.%' AND ${text} NOT LIKE ${`fx1.${current}.%`})`;
}
function workspaceTest(entry: SealedTable, workspaceId: string): SQL {
  if (entry.workspace === 'workspace_id') return sql`t.workspace_id = ${workspaceId}::uuid`;
  const path = entry.workspace;
  return sql`t.${id(path.column)} IN (SELECT p.${id(path.key)} FROM ${id(path.table)} p WHERE p.workspace_id = ${workspaceId}::uuid)`;
}

/** The primary-key column types, for the cursor and the compare-and-set (`uuid`, `integer`, `text` …). */
const keyTypes = new Map<string, string[]>();
async function identityTypes(db: DbExecutor, table: string, entry: SealedTable): Promise<string[]> {
  const known = keyTypes.get(table);
  if (known) return known;
  const rows = await rowsOf<{ name: string; type: string }>(db, sql`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid = to_regclass(${table}) AND a.attnum > 0 AND NOT a.attisdropped`);
  const types = entry.identity.map((column) => {
    const type = rows.find((row) => row.name === column)?.type;
    if (!type || !/^[a-z ]+(\([0-9]+\))?$/.test(type)) throw new Error(`${table}.${column}: unknown identity column`);
    return type;
  });
  keyTypes.set(table, types);
  return types;
}
const typed = (value: string, type: string) => sql`${value}::${sql.raw(type)}`;
function identityRow(entry: SealedTable): SQL {
  return sql.join(entry.identity.map((column) => sql`t.${id(column)}`), sql`, `);
}
function identityMatch(entry: SealedTable, types: string[], identity: string[]): SQL {
  return sql.join(entry.identity.map((column, i) => sql`t.${id(column)} = ${typed(identity[i]!, types[i]!)}`), sql` AND `);
}

function registry(table: string): SealedTable {
  const entry = SEALED_COLUMNS[table];
  if (!entry) throw new Error(`${table} is not in the registry`);
  return entry;
}

async function stalePage(db: DbExecutor, table: string, workspaceId: string, current: number, cursor: string[] | null, limit: number) {
  const entry = registry(table);
  const columns = Object.entries(entry.columns);
  const types = await identityTypes(db, table, entry);
  const after = cursor ? sql` AND (${identityRow(entry)}) > (${sql.join(cursor.map((value, i) => typed(value, types[i]!)), sql`, `)})` : sql``;
  const stale = sql.join(columns.map(([column, spec]) => staleTest(column, spec.kind, current)), sql` OR `);
  const identity = sql.join(entry.identity.map((column) => sql`t.${id(column)}::text`), sql`, `);
  const values = sql.join(columns.map(([column]) => sql`t.${id(column)}`), sql`, `);
  const rows = await rowsOf<Record<string, unknown> & { __identity: string[] }>(db, sql`SELECT ARRAY[${identity}] AS __identity, ${values}
    FROM ${id(table)} t WHERE ${workspaceTest(entry, workspaceId)} AND (${stale})${after}
    ORDER BY ${identityRow(entry)} LIMIT ${limit}`);
  return rows.map(({ __identity, ...rest }) => ({ identity: __identity, values: rest }));
}

/** One stored envelope of `version` with its place, from the first registry table that has one. */
export async function envelopeSample(db: DbExecutor, workspaceId: string, version: number) {
  for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
    for (const [column, spec] of Object.entries(entry.columns)) {
      const text = envelopeText(column, spec.kind);
      const identity = sql.join(entry.identity.map((c) => sql`t.${id(c)}::text`), sql`, `);
      const [row] = await rowsOf<{ identity: string[]; envelope: string }>(db, sql`SELECT ARRAY[${identity}] AS identity, ${text} AS envelope
        FROM ${id(table)} t WHERE ${workspaceTest(entry, workspaceId)} AND ${text} LIKE ${`fx1.${version}.%`} LIMIT 1`);
      if (row) return { field: spec.field, identity: row.identity, envelope: row.envelope };
    }
  }
  return null;
}

export interface RotationProgressRow {
  targetVersion: number; step: string; cursor: string[] | null; rowsDone: number; rowsEstimate: number; passes: number; passChanges: number;
}

export function keyRotationRows(db: DbExecutor) {
  return {
    async active(): Promise<string[]> {
      return (await rowsOf<{ workspaceId: string }>(db, sql`SELECT k.workspace_id AS "workspaceId" FROM workspace_keys k
        JOIN workspaces w ON w.id = k.workspace_id WHERE w.encrypted AND k.rotation <> 'none' ORDER BY k.workspace_id`)).map((row) => row.workspaceId);
    },
    tables: rotationTables,
    async progress(workspaceId: string, options: { lock?: boolean } = {}): Promise<RotationProgressRow | null> {
      const [row] = await rowsOf<RotationProgressRow>(db, sql`SELECT target_version AS "targetVersion", step, cursor, rows_done AS "rowsDone",
        rows_estimate AS "rowsEstimate", passes, pass_changes AS "passChanges" FROM workspace_rotation_progress WHERE workspace_id = ${workspaceId}
        ${options.lock ? sql`FOR UPDATE` : sql``}`);
      return row ? { ...row, rowsDone: Number(row.rowsDone), rowsEstimate: Number(row.rowsEstimate), passChanges: Number(row.passChanges),
        cursor: Array.isArray(row.cursor) ? row.cursor.map(String) : null } : null;
    },
    /** The pass from the first table; the estimate counts the workspace's values below the new version (one scan per table). */
    async resetProgress(workspaceId: string, targetVersion: number, firstStep: string) {
      let estimate = 0;
      for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
        const stale = sql.join(Object.entries(entry.columns).map(([column, spec]) => staleTest(column, spec.kind, targetVersion)), sql` OR `);
        const [row] = await rowsOf<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM ${id(table)} t WHERE ${workspaceTest(entry, workspaceId)} AND (${stale})`);
        estimate += row?.n ?? 0;
      }
      const [files] = await rowsOf<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM project_files WHERE workspace_id = ${workspaceId}
        AND key_version IS NOT NULL AND key_version < ${targetVersion}`);
      estimate += files?.n ?? 0;
      await db.execute(sql`INSERT INTO workspace_rotation_progress (workspace_id, target_version, step, cursor, rows_done, rows_estimate, passes, pass_changes, started_at, updated_at)
        VALUES (${workspaceId}, ${targetVersion}, ${firstStep}, NULL, 0, ${estimate}, 0, 0, now(), now())
        ON CONFLICT (workspace_id) DO UPDATE SET target_version = EXCLUDED.target_version, step = EXCLUDED.step, cursor = NULL, rows_done = 0,
          rows_estimate = EXCLUDED.rows_estimate, passes = 0, pass_changes = 0, started_at = now(), updated_at = now()`);
    },
    async saveProgress(workspaceId: string, row: { step: string; cursor: string[] | null; rowsDone: number; passes: number; passChanges: number }) {
      await db.execute(sql`UPDATE workspace_rotation_progress SET step = ${row.step}, cursor = ${row.cursor ? JSON.stringify(row.cursor) : null}::jsonb,
        rows_done = ${row.rowsDone}, passes = ${row.passes}, pass_changes = ${row.passChanges}, updated_at = now() WHERE workspace_id = ${workspaceId}`);
    },
    stalePage: (table: string, workspaceId: string, current: number, cursor: string[] | null, limit: number) => stalePage(db, table, workspaceId, current, cursor, limit),
    /**
     * Compare-and-set of one sealed value. Re-encryption changes no content, so the row's triggers (search, artifact
     * deltas, version bumps, the immutability guards of append-only tables) do not run for it: the page transaction
     * runs with `session_replication_role = replica`, which also skips the plaintext backstops (it writes envelopes only).
     */
    async compareAndSet(table: string, identity: string[], column: string, previous: unknown, next: unknown): Promise<boolean> {
      const entry = registry(table);
      const spec = entry.columns[column];
      if (!spec) throw new Error(`${table}.${column} is not sealed`);
      const types = await identityTypes(db, table, entry);
      await db.execute(sql`SET LOCAL session_replication_role = replica`);
      const json = spec.kind === 'json';
      const value = (v: unknown) => (json ? sql`${JSON.stringify(v)}::jsonb` : sql`${String(v)}`);
      const result = await db.execute(sql`UPDATE ${id(table)} t SET ${id(column)} = ${value(next)}
        WHERE ${identityMatch(entry, types, identity)} AND t.${id(column)} = ${value(previous)}`);
      return (result.rowCount ?? 0) > 0;
    },
    async anyStale(workspaceId: string, current: number): Promise<boolean> {
      for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
        const stale = sql.join(Object.entries(entry.columns).map(([column, spec]) => staleTest(column, spec.kind, current)), sql` OR `);
        const [row] = await rowsOf<{ one: number }>(db, sql`SELECT 1 AS one FROM ${id(table)} t WHERE ${workspaceTest(entry, workspaceId)} AND (${stale}) LIMIT 1`);
        if (row) return true;
      }
      const [file] = await rowsOf<{ one: number }>(db, sql`SELECT 1 AS one FROM project_files WHERE workspace_id = ${workspaceId}
        AND key_version IS NOT NULL AND key_version < ${current} AND state = 'ready' LIMIT 1`);
      return !!file;
    },
    async staleFiles(workspaceId: string, current: number, cursor: string | null, limit: number): Promise<{ id: string; keyVersion: number }[]> {
      return rowsOf(db, sql`SELECT id, key_version AS "keyVersion" FROM project_files WHERE workspace_id = ${workspaceId} AND state = 'ready'
        AND key_version IS NOT NULL AND key_version < ${current}${cursor ? sql` AND id > ${cursor}::uuid` : sql``} ORDER BY id LIMIT ${limit}`);
    },
    async setFileVersion(fileId: string, from: number, to: number): Promise<boolean> {
      await db.execute(sql`SET LOCAL session_replication_role = replica`);
      return ((await db.execute(sql`UPDATE project_files SET key_version = ${to} WHERE id = ${fileId} AND key_version = ${from}`)).rowCount ?? 0) > 0;
    },
    async advance(workspaceId: string, next: number) {
      await db.execute(sql`UPDATE workspace_keys SET current_version = ${next}, live_versions = array_append(live_versions, ${next}::integer),
        rotation = 'reencrypting' WHERE workspace_id = ${workspaceId}`);
    },
    async finish(workspaceId: string, current: number) {
      await db.execute(sql`DELETE FROM workspace_dek_wraps WHERE workspace_id = ${workspaceId} AND key_version < ${current}`);
      await db.execute(sql`DELETE FROM workspace_unlocks WHERE workspace_id = ${workspaceId} AND key_version < ${current}`);
      // The old versions' check values are envelopes under their DEKs: they go too (the next commitment stays).
      await db.execute(sql`DELETE FROM workspace_key_versions WHERE workspace_id = ${workspaceId} AND key_version < ${current}`);
      await db.execute(sql`DELETE FROM workspace_removed_holders WHERE workspace_id = ${workspaceId}`);
      await db.execute(sql`DELETE FROM workspace_rotation_progress WHERE workspace_id = ${workspaceId}`);
      await db.execute(sql`UPDATE workspace_keys SET live_versions = ARRAY[${current}::integer], rotation = 'none', rotation_reason = NULL
        WHERE workspace_id = ${workspaceId}`);
    },
  };
}
export type KeyRotationRows = ReturnType<typeof keyRotationRows>;

/** `VACUUM` of the touched tables and `CHECKPOINT`, outside any transaction (the Compose database role may run both). */
export async function rotationMaintenance(db: DbExecutor, tables: string[]): Promise<void> {
  for (const table of tables) await db.execute(sql`VACUUM (ANALYZE) ${id(table)}`);
}
export async function rotationCheckpoint(db: DbExecutor): Promise<void> {
  await db.execute(sql`CHECKPOINT`);
}
