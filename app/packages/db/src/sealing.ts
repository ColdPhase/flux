import { sql } from 'drizzle-orm';
import type { DbExecutor } from './repositories/push.js';
import { SEALED_COLUMNS, type SealedTable } from './sealed-columns.js';

/**
 * Sealing in the repositories (F-030, #655, S2a; docs/product/encrypted-workspaces.md#enforcement). This package
 * cannot import core, so core's `WorkspaceSeal` is met structurally by {@link FieldSeal}, and the API and worker
 * install core's `sealFor` here at start (`configureSeals`). A repository asks `sealOf(executor, workspaceId, { write })`
 * in the operation's own transaction and seals on write and opens on read with `sealRow` / `openRow`, which read
 * `SEALED_COLUMNS` and compute the identity from the row.
 *
 * Fail closed: a sealed workspace never gets the identity seal. Locked, the resolver throws core's
 * `WorkspaceLockedError` (423); unconfigured (a process that never installed `sealFor`), {@link SealsUnavailableError}.
 */
export interface FieldSeal {
  readonly sealed: boolean;
  readonly workspaceId: string;
  seal(field: string, identity: readonly string[], value: string): string;
  open(field: string, identity: readonly string[], envelope: string): string;
  digest(field: string, identity: readonly string[], bytes: Buffer | string): string;
  digestMatches(field: string, identity: readonly string[], stored: string, bytes: Buffer | string): boolean;
}

export type SealResolver = (executor: DbExecutor, workspaceId: string, options: { write: boolean }) => Promise<FieldSeal>;

/** A sealed workspace in a process without `sealFor`: a configuration bug, never a plaintext fallback. */
export class SealsUnavailableError extends Error {
  readonly code = 'WORKSPACE_LOCKED';
  constructor(readonly workspaceId: string) {
    super('This process cannot open encrypted workspaces');
    this.name = 'SealsUnavailableError';
  }
}

let resolver: SealResolver | null = null;
/** Installed once per API or worker process with core's `sealFor` over this process's keys. */
export function configureSeals(next: SealResolver) {
  resolver = next;
}

/**
 * Workspaces known not to be encrypted. `workspaces.encrypted` cannot change (0119 trigger), and an id is cached only
 * after its row was read, so a plain workspace costs one lookup per process for its whole life.
 */
const plain = new Set<string>();
const PLAIN_LIMIT = 50_000;

const passThrough = (workspaceId: string): FieldSeal => ({
  sealed: false, workspaceId,
  seal: (_f, _i, value) => value,
  open: (_f, _i, value) => value,
  digest: () => { throw new Error('A plain workspace stores its digests as before'); },
  digestMatches: () => { throw new Error('A plain workspace compares its digests as before'); },
});

/** The seal of a workspace in this transaction: pass-through for a plain one; `sealFor` for an encrypted one. */
export async function sealOf(executor: DbExecutor, workspaceId: string, options: { write: boolean }): Promise<FieldSeal> {
  if (plain.has(workspaceId)) return passThrough(workspaceId);
  const result = await executor.execute(sql`SELECT encrypted FROM workspaces WHERE id = ${workspaceId}::uuid`);
  const row = result.rows[0] as { encrypted: boolean } | undefined;
  if (row && !row.encrypted) {
    if (plain.size >= PLAIN_LIMIT) plain.clear();
    plain.add(workspaceId);
    return passThrough(workspaceId);
  }
  if (!row) return passThrough(workspaceId); // no such workspace: nothing to seal or open, and the write fails on its own
  if (!resolver) throw new SealsUnavailableError(workspaceId);
  const seal = await resolver(executor, workspaceId, options);
  if (!seal.sealed) throw new SealsUnavailableError(workspaceId); // never the identity seal for an encrypted workspace
  return seal;
}

/** The seals of several workspaces (a list that spans them), one lookup each. */
export async function sealsOf(executor: DbExecutor, workspaceIds: Iterable<string>, options: { write: boolean }) {
  const seals = new Map<string, FieldSeal>();
  for (const id of new Set(workspaceIds)) seals.set(id, await sealOf(executor, id, options));
  return seals;
}

function registry(table: string): SealedTable {
  const entry = SEALED_COLUMNS[table];
  if (!entry) throw new Error(`${table} has no sealed columns`);
  return entry;
}

const camel = (column: string) => column.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** A row's value of a column, by its SQL name or its Drizzle property. */
function read(row: Record<string, unknown>, column: string): [string, unknown] | null {
  if (column in row) return [column, row[column]];
  const property = camel(column);
  return property in row ? [property, row[property]] : null;
}

/** The identity of a row: its primary-key values as text, in registry order. */
export function rowIdentity(table: string, row: Record<string, unknown>): string[] {
  return registry(table).identity.map((column) => {
    const found = read(row, column);
    if (!found || found[1] === null || found[1] === undefined) throw new Error(`${table}: the identity needs ${column}`);
    return String(found[1]);
  });
}

/**
 * The values to write, with every registered sealed column present in `values` sealed. `identityRow` supplies the
 * primary key when `values` is a partial update. NULL and '' carry no content and are kept as they are.
 */
export function sealRow<T extends object>(table: string, values: T, seal: FieldSeal, identityRow: object = values): T {
  if (!seal.sealed) return values;
  const entry = registry(table);
  const identity = rowIdentity(table, { ...identityRow, ...values } as Record<string, unknown>);
  const out = { ...values } as Record<string, unknown>;
  for (const [column, spec] of Object.entries(entry.columns)) {
    const found = read(values as Record<string, unknown>, column);
    if (!found) continue;
    const [key, value] = found;
    if (value === null || value === undefined || value === '') continue;
    if (spec.kind === 'text') out[key] = seal.seal(spec.field, identity, String(value));
    else if (spec.kind === 'json') out[key] = { $sealed: seal.seal(spec.field, identity, JSON.stringify(value)) };
    else out[key] = seal.seal(spec.field, identity, String(value)); // a digest computed by the caller (SHA-256 hex), sealed
  }
  return out as T;
}

/** The row with every registered sealed column it has opened. A value that does not open throws (tampering or a bug). */
export function openRow<T extends object>(table: string, row: T, seal: FieldSeal): T {
  if (!seal.sealed) return row;
  const entry = registry(table);
  const identity = rowIdentity(table, row as Record<string, unknown>);
  const out = { ...row } as Record<string, unknown>;
  for (const [column, spec] of Object.entries(entry.columns)) {
    const found = read(row as Record<string, unknown>, column);
    if (!found) continue;
    const [key, value] = found;
    if (value === null || value === undefined || value === '') continue;
    if (spec.kind === 'json') {
      const envelope = typeof value === 'object' && value !== null ? (value as { $sealed?: unknown }).$sealed : value;
      out[key] = JSON.parse(seal.open(spec.field, identity, String(envelope)));
    } else {
      out[key] = seal.open(spec.field, identity, String(value));
    }
  }
  return out as T;
}

/** Opens one field of a row read by raw SQL under another alias (`title` of a decision read as `work_title`). */
export function openField(table: string, column: string, identity: readonly string[], value: string | null | undefined, seal: FieldSeal): string | null | undefined {
  if (!seal.sealed || value === null || value === undefined || value === '') return value;
  const spec = registry(table).columns[column];
  if (!spec) throw new Error(`${table}.${column} is not sealed`);
  return seal.open(spec.field, identity, value);
}

/** Opens every row of a list, one seal per workspace (`workspaceId` or `workspace_id` on each row). */
export async function openRows<T extends object>(executor: DbExecutor, table: string, rows: T[], workspaceOf?: (row: T) => string): Promise<T[]> {
  if (!rows.length) return rows;
  const of = workspaceOf ?? ((row: T) => { const r = row as Record<string, unknown>; return String(r.workspaceId ?? r.workspace_id); });
  const seals = await sealsOf(executor, rows.map(of), { write: false });
  return rows.map((row) => openRow(table, row, seals.get(of(row))!));
}

/** Seals the values of an insert or update in this transaction (`write`: the unlock rows are read FOR SHARE). */
export async function sealFor<T extends object>(executor: DbExecutor, table: string, workspaceId: string, values: T, identityRow?: object): Promise<T> {
  return sealRow(table, values, await sealOf(executor, workspaceId, { write: true }), identityRow);
}

/**
 * A stored digest of content (`request_fingerprint`, `request_hash` …): the SHA-256 hex as before in a plain workspace,
 * sealed in an encrypted one (F-030 Digests). `matches` compares in RAM.
 */
export const storedDigest = {
  store(seal: FieldSeal, table: string, column: string, identity: readonly string[], hex: string): string {
    if (!seal.sealed) return hex;
    return seal.seal(registry(table).columns[column]!.field, identity, hex);
  },
  matches(seal: FieldSeal, table: string, column: string, identity: readonly string[], stored: string, hex: string): boolean {
    if (!seal.sealed) return stored === hex;
    try { return seal.open(registry(table).columns[column]!.field, identity, stored) === hex; } catch { return false; }
  },
};

/**
 * Opens one aliased sealed column of rows read by a join or raw SQL (`opening` of a conversation is `project_messages.body`
 * of its first message): each row names its workspace and the source row's identity (null when the join found none).
 */
export async function openAliased<T extends object, K extends keyof T>(executor: DbExecutor, rows: T[], spec: {
  table: string; column: string; key: K; workspace: (row: T) => string; identity: (row: T) => readonly string[] | null;
}): Promise<T[]> {
  if (!rows.length) return rows;
  const seals = await sealsOf(executor, rows.map(spec.workspace), { write: false });
  return rows.map((row) => {
    const seal = seals.get(spec.workspace(row))!;
    const identity = spec.identity(row);
    if (!seal.sealed || !identity) return row;
    return { ...row, [spec.key]: openField(spec.table, spec.column, identity, row[spec.key] as string | null, seal) };
  });
}
