import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runFixed, type Person } from './process.js';

// Removing what a person's program left behind, whatever shape it has (#915). A program can build a tree deeper than PATH_MAX
// (`mkdir d && cd d` a few thousand times), which no tool that works with whole paths can enter or remove, BusyBox `rm` and Node's
// `rm` included; it can leave directories nobody can open; and it can leave a directory of its own inside a directory of someone
// else's that anyone may write to. This walks with `chdir` and short names only, so depth is no limit, and it follows no link: it
// descends only into what `lstat` says is a directory and checks, after every `chdir`, that it stands in that very directory
// (device and inode), otherwise it stops. It creates nothing.
//
// Two ways to run it, both as a separate process (`chdir` is process-wide, so never in the supervisor itself):
// - `remove PATH`: PATH and everything below it. A link at PATH is removed itself.
// - `sweep ROOT UID`: everything below ROOT that user UID owns, wherever it stands, also inside directories of other people that the
//   caller can enter. Those are only looked through, never removed themselves. Run as that person, so it never reaches more than their
//   user id reaches. It finds only what it can list: in a directory of someone else's that it may enter but not read (mode 0733, or one
//   opened to everyone and closed to 0700 by its owner), a file of theirs is not found, and the walk still ends with nothing left.
// Exit 0 when nothing is left, 1 when something is (a root-owned entry inside, a directory of someone else's that holds files the
// caller cannot enter), 3 when the walk had to stop, 2 on anything unforeseen.

export const TREE_SCRIPT = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(1);
const mode = args[0];
const asRoot = process.getuid() === 0;
const done = (code) => process.exit(code);
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
let leftover = false;

let start, only, uid = null;
if (mode === 'remove' && args.length === 2) {
  const path = args[1];
  const cut = path.lastIndexOf('/');
  start = cut <= 0 ? '/' : path.slice(0, cut);
  only = path.slice(cut + 1);
} else if (mode === 'sweep' && args.length === 3) {
  start = args[1];
  uid = Number(args[2]);
} else done(2);

// The frames are the directories from the start down to the one this process stands in.
const frames = [];
const stand = (name, expected) => {
  process.chdir(name);
  const here = fs.statSync('.');
  if (!same(here, expected)) done(3);
};
// A directory is given rights only when it needs them and only by its owner: opening up one that is to be removed, but could not
// be (something of someone else's inside), would lock out the person whose directory it is that still has to be cleaned inside it.
const grant = () => { if (asRoot) return false; try { fs.chmodSync('.', 0o700); return true; } catch { return false; } };
const attempt = (action, mayGrant) => {
  try { action(); return true; } catch (error) {
    if (error.code === 'ENOENT') return true;
    if ((error.code === 'EACCES' || error.code === 'EPERM') && mayGrant && grant()) {
      try { action(); return true; } catch (again) { if (again.code === 'ENOENT') return true; }
    }
    return false;
  }
};
const readNames = (removing) => {
  try { return fs.readdirSync('.'); } catch { /* an owned directory may give itself the right to read */ }
  if (!removing || !grant()) return null;
  try { return fs.readdirSync('.'); } catch { return null; }
};
const enter = (name, stat, removing) => {
  try { process.chdir(name); } catch {
    if (!removing || asRoot) return null;
    try { fs.chmodSync(name, 0o700); process.chdir(name); } catch { return null; }
  }
  if (!same(fs.statSync('.'), stat)) done(3);
  const names = readNames(removing);
  if (!names) { stand('..', frames[frames.length - 1].stat); return null; }
  return names;
};

try {
  const first = fs.lstatSync(start);
  if (!first.isDirectory()) done(2);
  process.chdir(start);
  if (!same(fs.statSync('.'), first)) done(3);
  const names = readNames(false);
  if (!names) done(2);
  frames.push({ stat: first, names: only === undefined ? names : names.filter((entry) => entry === only), at: 0, removing: false, name: null });
  while (frames.length) {
    const top = frames[frames.length - 1];
    if (top.at < top.names.length) {
      const name = top.names[top.at++];
      let stat;
      try { stat = fs.lstatSync(name); } catch { continue; }
      const mine = uid === null || stat.uid === uid;
      const removing = top.removing || mine;
      if (stat.isDirectory()) {
        const inside = enter(name, stat, removing);
        if (!inside) {
          // What cannot be entered goes if it is empty; if it is not, and it was to go, something is left.
          if (removing && !attempt(() => fs.rmdirSync(name), top.removing)) leftover = true;
          continue;
        }
        frames.push({ stat, names: inside, at: 0, removing, name });
      } else if (removing) {
        if (!attempt(() => fs.unlinkSync(name), top.removing)) leftover = true;
      }
    } else {
      frames.pop();
      if (!frames.length) break;
      stand('..', frames[frames.length - 1].stat);
      if (top.removing && !attempt(() => fs.rmdirSync(top.name), frames[frames.length - 1].removing)) leftover = true;
    }
  }
  done(leftover ? 1 : 0);
} catch {
  done(2);
}
`;

const FIXED = { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 30_000 };

/** One run of the walk, as `person` (or as this process when null). True only when it ended with nothing left (exit 0). */
export async function walkTree(person: Person, args: readonly string[]): Promise<boolean> {
  const done = await runFixed(process.execPath, ['-e', TREE_SCRIPT, ...args], { ...FIXED, person });
  return done.code === 0 && !done.timedOut;
}

/** Removes `path` and everything below it, as `person` (or as this process when null). True only when it is gone. */
export function removeTreeScript(person: Person, path: string): Promise<boolean> {
  return walkTree(person, ['remove', path]);
}

/**
 * Removes what user `uid` owns anywhere under `root`, as that person. True only when none of it is left. A directory of someone
 * else's is looked through to find more but kept; one that holds something of the person's which they cannot enter keeps theirs.
 */
export function sweepOwned(root: string, person: Exclude<Person, null>): Promise<boolean> {
  return walkTree(person, ['sweep', root, String(person.uid)]);
}

// The operator's way to remove a tree by hand, with the same walk (docs/operations/agent-runtime.md):
//   docker compose … exec runtime-1 node /opt/flux-runtime/apps/runtime/dist/supervisor/tree.js remove /data/<id>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, path] = process.argv.slice(2);
  if (mode !== 'remove' || !path?.startsWith('/')) {
    console.error('usage: tree.js remove /absolute/path');
    process.exit(2);
  }
  const done = spawnSync(process.execPath, ['-e', TREE_SCRIPT, 'remove', path], { stdio: 'inherit' });
  console.log(done.status === 0 ? `removed ${path}` : `could not remove all of ${path} (exit ${done.status})`);
  process.exit(done.status ?? 2);
}
