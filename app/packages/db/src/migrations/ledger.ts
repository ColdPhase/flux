import { readdir } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export interface MigrationFile {
  name: string;
  version: number;
}

type LedgerReader = Pick<Pool | PoolClient, 'query'>;

/** All SQL files in the image belong to exactly one numbered migration. */
export function parseMigrationManifest(names: readonly string[], expectedLatest: number): MigrationFile[] {
  const versions = new Map<number, string>();
  for (const name of names) {
    if (!/^\d{4}/.test(name) && !/\.sql$/i.test(name)) continue;
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid Flux migration filename: ${name}`);
    const version = Number(match[1]);
    if (version < 1) throw new Error(`Invalid Flux migration version in ${name}`);
    const previous = versions.get(version);
    if (previous) throw new Error(`Duplicate Flux migration version ${version}: ${previous}, ${name}`);
    versions.set(version, name);
  }
  const files = [...versions].sort(([a], [b]) => a - b).map(([version, name]) => ({ name, version }));
  if (files.at(-1)?.version !== expectedLatest) {
    throw new Error(`Flux migration image expects latest version ${expectedLatest}, found ${files.at(-1)?.version ?? 'none'}`);
  }
  return files;
}

export async function readMigrationManifest(directory: string, expectedLatest: number): Promise<MigrationFile[]> {
  return parseMigrationManifest(await readdir(directory), expectedLatest);
}

export async function readAppliedMigrationVersions(db: LedgerReader): Promise<number[]> {
  const table = await db.query("SELECT to_regclass('flux_schema_version') AS name");
  if (!table.rows[0]?.name) return [];
  const rows = await db.query('SELECT version FROM flux_schema_version ORDER BY version');
  return rows.rows.map((row: { version: number }) => Number(row.version));
}

/** Applied rows must be files in this image. Missing rows may be applied by the migrator. */
export function assertKnownMigrationVersions(manifest: readonly MigrationFile[], applied: readonly number[]): void {
  const known = new Set(manifest.map((file) => file.version));
  const unknown = applied.filter((version) => !known.has(version));
  if (unknown.length) throw new Error(`Flux migration ledger has versions without files in this image: ${unknown.join(', ')}. Restore the matching image or database backup; do not edit the ledger by hand.`);
}

/** A running API/worker, or a completed migration run, needs every file recorded. */
export function assertExactMigrationLedger(manifest: readonly MigrationFile[], applied: readonly number[]): void {
  assertKnownMigrationVersions(manifest, applied);
  const recorded = new Set(applied);
  const missing = manifest.filter((file) => !recorded.has(file.version));
  if (missing.length) throw new Error(`Flux migration ledger is missing files: ${missing.map((file) => file.name).join(', ')}. Run the migrator before starting Flux.`);
}

/** SQL may self-record its own version, as old migrations do, but no other ledger change. */
export function assertMigrationSqlLedgerChange(before: readonly number[], afterSql: readonly number[], file: MigrationFile): void {
  const allowed = new Set([...before, file.version]);
  const unexpected = afterSql.filter((version) => !allowed.has(version));
  const removed = before.filter((version) => !afterSql.includes(version));
  if (unexpected.length || removed.length) {
    throw new Error(`Flux migration ${file.name} changed unrelated ledger versions (added: ${unexpected.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}). Transaction rolled back.`);
  }
}

export function assertMigrationStepLedger(before: readonly number[], after: readonly number[], file: MigrationFile): void {
  const expected = new Set([...before, file.version]);
  if (after.length !== expected.size || after.some((version) => !expected.has(version))) {
    throw new Error(`Flux migration ${file.name} did not record exactly its own version. Transaction rolled back.`);
  }
}
