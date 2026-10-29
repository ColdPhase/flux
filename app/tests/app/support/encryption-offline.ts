import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import {
  deriveKek, envelopeVersion, fileObjectVersion, holderSecretCheckValid, normalizeRecoveryCode, openDekForHolder, openField, openFileObject,
  parseKdfParams, unwrapPrivateKey, WorkspaceKey,
} from '@flux/core';
import { SEALED_COLUMNS } from '@flux/db';
import { pool } from './db.js';

/**
 * The offline checker of F-030 AC-13 (S2c), built on the S1 crypto library: what someone holding a copy of the database
 * and the files volume, plus a removed person's password, an old DEK or an old recovery code, could open. It reads the
 * rows a logical copy holds (every registry table and the key tables, as `pg_dump` writes them) and the object files.
 */

export interface HolderRow {
  id: string; workspace_id: string; kind: 'password' | 'recovery'; user_id: string | null; kdf: unknown; public_key: string; wrapped_private: string;
  secret_check: string;
}
export interface WrapRow { holder_id: string; key_version: number; ephemeral_public: string; sealed_dek: string }

export const holderRows = async (workspaceId: string) =>
  (await pool.query<HolderRow>('SELECT * FROM workspace_holders WHERE workspace_id = $1', [workspaceId])).rows;
export const wrapRows = async (workspaceId: string) =>
  (await pool.query<WrapRow>('SELECT * FROM workspace_dek_wraps WHERE workspace_id = $1', [workspaceId])).rows;

const holderPlace = (holder: HolderRow) => ({ workspaceId: holder.workspace_id, holderId: holder.id, kind: holder.kind, userId: holder.user_id });

/** The holder's private key with this secret (a password or a recovery code), or null when the secret does not open the row. */
export async function openHolder(holder: HolderRow, secret: string): Promise<KeyObject | null> {
  const text = holder.kind === 'recovery' ? normalizeRecoveryCode(secret) ?? secret : secret;
  let kek: Buffer;
  try { kek = await deriveKek(text, parseKdfParams(holder.kdf)); } catch { return null; }
  try {
    if (!holderSecretCheckValid(kek, holderPlace(holder), holder.secret_check)) return null;
    return unwrapPrivateKey(kek, holder.wrapped_private, holderPlace(holder), holder.public_key);
  } catch { return null; } finally { kek.fill(0); }
}

/** The holders of a workspace that a secret opens (each holder row's own KDF parameters). */
export async function holdersOpenedBy(holders: HolderRow[], secret: string): Promise<string[]> {
  const opened: string[] = [];
  for (const holder of holders) if (await openHolder(holder, secret)) opened.push(holder.id);
  return opened;
}

/** Every DEK a holder's private key opens from these wraps, by version. */
export function deksOf(holder: Pick<HolderRow, 'id' | 'workspace_id'>, privateKey: KeyObject, wraps: WrapRow[]): Map<number, Buffer> {
  const deks = new Map<number, Buffer>();
  for (const wrap of wraps.filter((row) => row.holder_id === holder.id)) {
    try {
      deks.set(wrap.key_version, openDekForHolder(privateKey, { ephemeralPublic: wrap.ephemeral_public, sealedDek: wrap.sealed_dek },
        { workspaceId: holder.workspace_id, holderId: holder.id, keyVersion: wrap.key_version }));
    } catch { /* not this key's */ }
  }
  return deks;
}

export interface StoredEnvelope { table: string; column: string; field: string; identity: string[]; envelope: string; version: number }

/** Every sealed value of the workspace in the registry tables, with its place. */
export async function storedEnvelopes(workspaceId: string): Promise<StoredEnvelope[]> {
  const out: StoredEnvelope[] = [];
  for (const [table, entry] of Object.entries(SEALED_COLUMNS)) {
    const where = entry.workspace === 'workspace_id' ? 't.workspace_id = $1'
      : `t.${entry.workspace.column} IN (SELECT p.${entry.workspace.key} FROM ${entry.workspace.table} p WHERE p.workspace_id = $1)`;
    const identity = entry.identity.map((column) => `t.${column}::text`).join(', ');
    const columns = Object.keys(entry.columns).map((column) => `t.${column}`).join(', ');
    const rows = (await pool.query(`SELECT ARRAY[${identity}] AS __identity, ${columns} FROM ${table} t WHERE ${where}`, [workspaceId])).rows;
    for (const row of rows) {
      for (const [column, spec] of Object.entries(entry.columns)) {
        const value = row[column];
        const envelope = spec.kind === 'json' && value && typeof value === 'object' ? (value as { $sealed?: unknown }).$sealed : value;
        const version = envelopeVersion(envelope);
        if (version !== null) out.push({ table, column, field: spec.field, identity: row.__identity, envelope: envelope as string, version });
      }
    }
  }
  return out;
}

/** The key-version check values (fixed texts sealed under each version's DEK) stored for the workspace. */
export async function checkValues(workspaceId: string): Promise<StoredEnvelope[]> {
  return (await pool.query('SELECT key_version, check_value FROM workspace_key_versions WHERE workspace_id = $1', [workspaceId])).rows
    .map((row) => ({ table: 'workspace_key_versions', column: 'check_value', field: 'workspace_key_versions.check_value', identity: [String(row.key_version)],
      envelope: row.check_value as string, version: Number(row.key_version) }));
}

/**
 * How many of these envelopes a DEK opens, whatever version it is tried as (so a DEK of v1 is also tried against
 * values labelled v2: the label alone must not be what protects them).
 */
export function opened(workspaceId: string, dek: Buffer, envelopes: StoredEnvelope[]): number {
  let count = 0;
  for (const value of envelopes) {
    const key = WorkspaceKey.fromDek(workspaceId, value.version, dek);
    try { openField((v) => (v === value.version ? key : undefined), { workspaceId, field: value.field, identity: value.identity }, value.envelope); count += 1; }
    catch { /* does not open */ }
  }
  return count;
}

/** The workspace's file objects in the stack's files volume (read-only at FLUX_TEST_STACK_FILES in the test container), by file id. */
export async function fileObjects(workspaceId: string, filesDir = process.env.FLUX_TEST_STACK_FILES ?? '/data/stack-files'): Promise<Map<string, Buffer>> {
  const ids = (await pool.query<{ id: string }>('SELECT id FROM project_files WHERE workspace_id = $1', [workspaceId])).rows.map((row) => row.id);
  const objects = new Map<string, Buffer>();
  const root = join(filesDir, 'attachments', 'objects');
  for (const id of ids) {
    try {
      if ((await readdir(join(root, id.slice(0, 2)))).includes(id)) objects.set(id, await readFile(join(root, id.slice(0, 2), id)));
    } catch { /* not stored */ }
  }
  return objects;
}

/** How many file objects a DEK opens (tried as every version the objects name). */
export function filesOpened(workspaceId: string, dek: Buffer, objects: Map<string, Buffer>): number {
  let count = 0;
  for (const [id, object] of objects) {
    const version = fileObjectVersion(object);
    if (version === null) continue;
    const key = WorkspaceKey.fromDek(workspaceId, version, dek);
    try { openFileObject((v) => (v === version ? key : undefined), workspaceId, id, object); count += 1; } catch { /* does not open */ }
  }
  return count;
}
