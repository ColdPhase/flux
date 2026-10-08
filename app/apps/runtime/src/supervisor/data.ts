import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BINDING_ID, MAX_REPORTED_BINDINGS, type RuntimeClient } from '@flux/runtime-protocol';
import { CLIENT_DIRS, CREDENTIAL_FILES } from './templates.js';

// The slot's `/data` (F-022 "A binding directory"). At most one binding directory, named by its UUID,
// mode 0700, never a symlink. Binding refuses while `/data` holds any entry at all. Credential files
// are checked by `stat` only and never opened; they are only ever deleted.

export interface DataEntries { bindings: string[]; other: number }

export async function dataEntries(dataDir: string): Promise<DataEntries> {
  const bindings: string[] = [];
  let other = 0;
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (BINDING_ID.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink() && bindings.length < MAX_REPORTED_BINDINGS) bindings.push(entry.name);
    else other += 1;
  }
  return { bindings: bindings.sort(), other };
}

export const isEmpty = (entries: DataEntries) => entries.bindings.length === 0 && entries.other === 0;

export async function tmpIsEmpty(tmpDir: string): Promise<boolean> {
  try { return (await readdir(tmpDir)).length === 0; } catch { return false; }
}

const SUBDIRS = [CLIENT_DIRS.claude_code, CLIENT_DIRS.codex, 'home'];

async function privateDir(path: string) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

/** Creates `/data/<id>` and the CLI homes. The caller has checked that `/data` is empty. */
export async function createBinding(dataDir: string, bindingId: string): Promise<void> {
  if (!BINDING_ID.test(bindingId)) throw new Error('Not a binding id');
  const dir = join(dataDir, bindingId);
  await privateDir(dir);
  for (const sub of SUBDIRS) await privateDir(join(dir, sub));
}

export type BindingCheck = { ok: true; dir: string } | { ok: false; code: 'no_binding' | 'binding_unsafe' };

/** The binding directory, only when it is a real 0700 directory owned by this process with real subdirectories. */
export async function openBinding(dataDir: string, bindingId: string): Promise<BindingCheck> {
  if (!BINDING_ID.test(bindingId)) return { ok: false, code: 'binding_unsafe' };
  const dir = join(dataDir, bindingId);
  const stat = await lstat(dir).catch(() => null);
  if (!stat) return { ok: false, code: 'no_binding' };
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) {
    return { ok: false, code: 'binding_unsafe' };
  }
  for (const sub of SUBDIRS) {
    const child = await lstat(join(dir, sub)).catch(() => null);
    if (!child || !child.isDirectory() || child.isSymbolicLink()) return { ok: false, code: 'binding_unsafe' };
  }
  return { ok: true, dir };
}

/** Removes `/data/<id>` without following any link inside it (a link at the top is removed itself). */
export async function removeBinding(dataDir: string, bindingId: string): Promise<boolean> {
  if (!BINDING_ID.test(bindingId)) return false;
  try {
    await rm(join(dataDir, bindingId), { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/** Deletes one CLI's files from the binding directory and leaves its home empty (sign-out). */
export async function clearClientFiles(bindingDir: string, client: RuntimeClient): Promise<void> {
  const home = join(bindingDir, CLIENT_DIRS[client]);
  await rm(home, { recursive: true, force: true });
  await privateDir(home);
  if (client === 'claude_code') {
    for (const entry of await readdir(join(bindingDir, 'home')).catch(() => [] as string[])) {
      if (entry.startsWith('.claude')) await rm(join(bindingDir, 'home', entry), { recursive: true, force: true });
    }
  }
}

/** Whether the binding directory holds anything of this client: its home directory is not empty, or Claude's `~/.claude*` exists. */
export async function clientHasFiles(bindingDir: string, client: RuntimeClient): Promise<boolean> {
  if (((await readdir(join(bindingDir, CLIENT_DIRS[client])).catch(() => [] as string[]))).length > 0) return true;
  if (client !== 'claude_code') return false;
  return (await readdir(join(bindingDir, 'home')).catch(() => [] as string[])).some((entry) => entry.startsWith('.claude'));
}

export async function credentialFileState(bindingDir: string, client: RuntimeClient): Promise<'ok' | 'missing' | 'loose_mode'> {
  const stat = await lstat(join(bindingDir, CLIENT_DIRS[client], CREDENTIAL_FILES[client])).catch(() => null);
  if (!stat) return 'missing';
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return 'loose_mode';
  return 'ok';
}

/**
 * Bytes the binding directory uses on disk, counted by `lstat` (allocated blocks, so a sparse file
 * counts what it occupies). Stops once past `limit` or after `maxEntries`, which counts as over.
 */
export async function bindingBytes(bindingDir: string, limit: number, maxEntries = 200_000): Promise<{ bytes: number; overLimit: boolean }> {
  let bytes = 0;
  let seen = 0;
  const stack = [bindingDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > maxEntries) return { bytes, overLimit: true };
      const path = join(dir, entry.name);
      const stat = await lstat(path).catch(() => null);
      if (!stat) continue;
      bytes += Math.max(stat.size, stat.blocks * 512);
      if (bytes > limit) return { bytes, overLimit: true };
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
    }
  }
  return { bytes, overLimit: false };
}
