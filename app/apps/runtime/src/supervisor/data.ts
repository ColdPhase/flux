import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BINDING_ID, MAX_REPORTED_BINDINGS, type RuntimeClient } from '@flux/runtime-protocol';
import { runFixed, type Person } from './process.js';
import { CLIENT_DIRS, CREDENTIAL_FILES } from './templates.js';
import { removeTreeScript, sweepOwned } from './tree.js';

// The runtime's `/data` (F-022 "A binding directory"; #860). One directory per person, named by a UUID, mode 0700 and owned by
// that person's own user id, never a symlink. Credential files are checked by `stat` only and never opened; they are only ever
// deleted. A person's CLI can leave anything in their directory, also a link to someone else's, so everything below it is written
// and deleted as that person (asThem), who has no rights outside their own files. Root touches only `/data/<id>` itself, after
// endProcesses proved no process of theirs is left to change it (their own CLI can have opened the directory to everyone, so that proof is what makes the removal safe), and removes it with the walk of tree.ts, which follows no link.
// A tree too deep for any tool that works with whole paths goes through tree.ts (#915).

/** The user ids given to people: one each, one for every binding directory `/data` can report. */
export const PERSON_IDS = { first: 20_000, last: 59_999 } as const;

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

/** The Anthropic configuration directory under the CLI's HOME (the default location of the Console profile). */
export const CONSOLE_PROFILE_DIR = '.config/anthropic';

const SUBDIRS = [CLIENT_DIRS.claude_code, CLIENT_DIRS.codex, 'home', 'tmp'];

async function privateDir(path: string, person: Person) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  if (person) await chown(path, person.uid, person.gid);
}

/** The lowest user id no binding directory has. The caller allows one at a time. Null when every id is taken. */
export async function freePerson(dataDir: string): Promise<Exclude<Person, null> | null> {
  const taken = new Set<number>();
  for (const name of (await dataEntries(dataDir)).bindings) {
    const stat = await lstat(join(dataDir, name)).catch(() => null);
    if (stat) taken.add(stat.uid);
  }
  for (let id: number = PERSON_IDS.first; id <= PERSON_IDS.last; id += 1) if (!taken.has(id)) return { uid: id, gid: id };
  return null;
}

/** Creates `/data/<id>` and the CLI homes, owned by the person. */
export async function createBinding(dataDir: string, bindingId: string, person: Person): Promise<void> {
  if (!BINDING_ID.test(bindingId)) throw new Error('Not a binding id');
  const dir = join(dataDir, bindingId);
  await privateDir(dir, person);
  for (const sub of SUBDIRS) await privateDir(join(dir, sub), person);
}

export type BindingCheck = { ok: true; dir: string; person: Person } | { ok: false; code: 'no_binding' | 'binding_unsafe' };

/**
 * The binding directory, only when it is a real 0700 directory with real subdirectories. `separate`: people have their own
 * user ids here, so it must be owned by one of those; otherwise by this process.
 */
export async function openBinding(dataDir: string, bindingId: string, separate = false): Promise<BindingCheck> {
  if (!BINDING_ID.test(bindingId)) return { ok: false, code: 'binding_unsafe' };
  const dir = join(dataDir, bindingId);
  const stat = await lstat(dir).catch(() => null);
  if (!stat) return { ok: false, code: 'no_binding' };
  const owner = separate ? stat.uid >= PERSON_IDS.first && stat.uid <= PERSON_IDS.last : !process.getuid || stat.uid === process.getuid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || !owner) return { ok: false, code: 'binding_unsafe' };
  for (const sub of SUBDIRS) {
    const child = await lstat(join(dir, sub)).catch(() => null);
    if (!child || !child.isDirectory() || child.isSymbolicLink()) return { ok: false, code: 'binding_unsafe' };
  }
  return { ok: true, dir, person: separate ? { uid: stat.uid, gid: stat.gid } : null };
}

/** The owner of a binding directory, whatever else is wrong with it: a release must end their processes either way. */
export async function ownerOf(dataDir: string, bindingId: string, separate: boolean): Promise<Person> {
  if (!separate || !BINDING_ID.test(bindingId)) return null;
  const stat = await lstat(join(dataDir, bindingId)).catch(() => null);
  return stat && stat.uid >= PERSON_IDS.first && stat.uid <= PERSON_IDS.last ? { uid: stat.uid, gid: stat.gid } : null;
}

/**
 * Removes `/data/<id>` without following any link inside it. A directory is taken down only by the walk of tree.ts, which goes by
 * `chdir` and short names and checks (device and inode) every directory it stands in. Not by `rm -r` or Node's `fs.rm`: both go by
 * path, so a link that another person swaps in for an entry after they looked is followed, and root deletes what is behind it. That
 * happens while the owner's directories are open to everyone and a second person is running (review of #952). `rm` or `lstat` is used
 * only for the top-level entry when it is not a directory (a link or a file at `/data/<id>` is removed itself). It creates nothing in `/data`.
 */
export async function removeBinding(dataDir: string, bindingId: string): Promise<boolean> {
  if (!BINDING_ID.test(bindingId)) return false;
  const path = join(dataDir, bindingId);
  const stat = await lstat(path).catch(() => null);
  if (!stat) return true;
  if (!stat.isDirectory()) {
    try { await rm(path, { force: true }); } catch { return false; }
    return (await lstat(path).catch(() => null)) === null;
  }
  return removeTreeScript(null, path);
}

/** A fixed shell line as the person, with their directory as `$1`: it can reach only what is theirs, whatever a link there says. */
export async function asThem(person: Person, script: string, dir: string): Promise<boolean> {
  const done = await runFixed('/bin/sh', ['-c', script, 'sh', dir], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 30_000, person });
  return done.code === 0 && !done.timedOut;
}

/**
 * The shell lines that remove `$p`, as the person. A CLI can leave a directory with no rights at all (mode 000, or one it cannot write),
 * which `rm` cannot open; only its owner can give the rights back, so they come first, and not through a link (#910). `rm` still fails
 * when anything is left, so the answer says whether it is gone.
 */
const REMOVE = '[ -L "$p" ] || chmod -R u+rwx -- "$p" 2>/dev/null; rm -rf -- "$p"';

/**
 * Removes `path` (a person's own entry) as the person. `rm` first, which is quick; a tree it cannot enter, because it is deeper than
 * PATH_MAX, is then taken down by tree.ts. True only when nothing is left at `path`.
 */
export async function removeAsThem(person: Person, path: string): Promise<boolean> {
  const gone = () => lstat(path).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  if (await asThem(person, `p="$1"; ${REMOVE}`, path) && await gone()) return true;
  return (await removeTreeScript(person, path)) && await gone();
}

/** Empties the person's scratch directory after a run: nothing a CLI left there stays. True only when it is a fresh, empty directory again. */
export async function clearScratch(bindingDir: string, person: Person): Promise<boolean> {
  return await removeAsThem(person, join(bindingDir, 'tmp')) && asThem(person, 'mkdir -m 0700 -- "$1/tmp"', bindingDir);
}

/** Deletes one CLI's transcripts from its home. `names` are fixed names, never input. */
export async function clearClientPaths(bindingDir: string, client: RuntimeClient, names: readonly string[], person: Person): Promise<boolean> {
  return !names.length || asThem(person, `rm -rf -- ${names.map((name) => `"$1/${CLIENT_DIRS[client]}/${name}"`).join(' ')}`, bindingDir);
}

/**
 * Removes what a person left anywhere in the shared `/tmp`, once no process of theirs is left: a user id can go to someone else later,
 * and that person could open whatever it still owns. Run as the person (tree.ts), so it never reaches more than their user id reaches:
 * also a directory of theirs inside a directory of someone else's that anyone may write to, and trees deeper than PATH_MAX. It finds
 * only what it can list: in a directory of someone else's that it may enter but not read (mode 0733, or one opened to everyone and
 * closed again to 0700 by its owner), a file of theirs is not found, and the release can still report that it deleted everything. True only when none of it is left (and when `/tmp` could be read), so a release does not call itself
 * finished while a file of theirs stays (#910, #915). It stays unfinished when the person's directory sits in someone else's directory
 * that they cannot enter; that other person's own cleanup, or a restart of the runtime (`/tmp` is memory), ends it.
 */
export async function clearLeftovers(tmpDir: string, person: Person): Promise<boolean> {
  return !person || sweepOwned(tmpDir, person);
}

/** Deletes one CLI's files from the binding directory and leaves its home empty (sign-out). */
export async function clearClientFiles(bindingDir: string, client: RuntimeClient, person: Person): Promise<boolean> {
  const home = `"$1/${CLIENT_DIRS[client]}"`;
  // The keyless Console sign-in (Claude Code 2.1.242 and later) keeps its Anthropic profile outside
  // CLAUDE_CONFIG_DIR, by default in `$HOME/.config/anthropic`; sign-out must remove it as well.
  const claude = client === 'claude_code' ? ` "$1"/home/.claude* "$1/home/${CONSOLE_PROFILE_DIR}"` : '';
  return asThem(person, `rm -rf -- ${home}${claude} && mkdir -m 0700 -- ${home}`, bindingDir);
}

/**
 * Whether the binding directory holds anything of this client: its home directory is not empty, or Claude's
 * `~/.claude*` exists. A directory that cannot be read counts as holding files: unknown is not "never installed".
 */
export async function clientHasFiles(bindingDir: string, client: RuntimeClient): Promise<boolean> {
  const list = (path: string) => readdir(path).then((entries) => entries, () => null);
  const home = await list(join(bindingDir, CLIENT_DIRS[client]));
  if (home === null || home.length > 0) return true;
  if (client !== 'claude_code') return false;
  const shared = await list(join(bindingDir, 'home'));
  return shared === null || shared.some((entry) => entry.startsWith('.claude'));
}

// A failed or timed-out sign-out leaves this marker in the binding directory, beside the client homes that
// the sign-out then clears. It is the durable record that the sign-out was not confirmed.
const unconfirmedPath = (bindingDir: string, client: RuntimeClient) => join(bindingDir, `unconfirmed-${client}`);

export async function recordUnconfirmed(bindingDir: string, client: RuntimeClient): Promise<void> {
  // O_EXCL opens nothing that already exists, a link least of all; whatever stands at this path counts as recorded.
  await writeFile(unconfirmedPath(bindingDir, client), '', { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
}

/** Whether an earlier sign-out of this client failed. Any error other than "absent" counts as recorded. */
export async function hasUnconfirmed(bindingDir: string, client: RuntimeClient): Promise<boolean> {
  try {
    await lstat(unconfirmedPath(bindingDir, client));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
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
