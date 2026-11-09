import { AddressTooLong, DomainError, PrivateTextIndex, privateFragmentIn, writtenAddresses, type AddressChain } from '@flux/core';
import { personalRunWebReadRows, type DbExecutor } from '@flux/db';
import { toolError } from './tool-results.js';

// The private Flux text a run has read, as its address check reads it (#1065, #1136, C-30). One index per run, kept in this process and
// added to as the run keeps more text: each check fetches only the rows it does not hold yet (the worker writes the brief, and any API
// process a tool result, so the database is where they meet). Every check runs behind one gate, so parallel reads of a run, or of many
// runs, wait their turn instead of each loading, indexing and scanning everything at once, and the runs take turns at it (#1144); the work
// inside yields to the event loop.
// A run's index goes when the run is seen to have ended (its rows are gone, or its token is refused), when it has not been used for
// a while, or when the cache is over its bounds (least recently used first).

/** How many runs' indexes this process keeps, how many characters they may hold together, and how long an unused one stays. */
const CACHE = { runs: 16, characters: 48 << 20, idleMs: 10 * 60_000 } as const;

interface Entry { index: PrivateTextIndex; seen: Set<string>; usedAt: number }
const cache = new Map<string, Entry>();

/**
 * One check at a time in this process: the work at any moment is one check's, whatever the number of callers. The runs take turns (#1144):
 * each run waits in its own line, and the gate serves one check of each waiting run in turn, so one run's 40 parallel reads delay another
 * run's single read by at most one check of each, never by all 40.
 */
const waiting = new Map<string, (() => Promise<void>)[]>();
let serving = false;
function gated<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const turn = async () => { try { resolve(await work()); } catch (error) { reject(error); } };
    const line = waiting.get(runId);
    if (line) line.push(turn); else waiting.set(runId, [turn]);
    if (!serving) void serve();
  });
}
async function serve() {
  serving = true;
  // The run that has waited longest goes first, then the back of the line (a `Map` keeps the order its keys were set in).
  for (let next = waiting.entries().next(); !next.done; next = waiting.entries().next()) {
    const [runId, line] = next.value;
    const turn = line.shift()!;
    waiting.delete(runId);
    if (line.length) waiting.set(runId, line);
    await turn();
  }
  serving = false;
}

/** An index nobody checks against any more (its run ended in this process's silence) still goes after `idleMs`. */
setInterval(() => evict(Date.now(), ''), 60_000).unref();

function evict(now: number, keep: string) {
  for (const [runId, entry] of cache) if (runId !== keep && now - entry.usedAt > CACHE.idleMs) cache.delete(runId);
  let characters = [...cache.values()].reduce((sum, entry) => sum + entry.index.size, 0);
  for (const [runId, entry] of cache) {
    if (cache.size <= CACHE.runs && characters <= CACHE.characters) break;
    if (runId === keep) continue;
    cache.delete(runId);
    characters -= entry.index.size;
  }
}

/** The run's index, with every text it has kept so far: only the rows this process does not hold yet are read. */
async function synced(db: DbExecutor, runId: string): Promise<PrivateTextIndex> {
  const rows = personalRunWebReadRows(db);
  const ids = await rows.privateTextIds(runId);
  let entry = cache.get(runId);
  // No rows: the run kept nothing yet, or it ended and its text went with it (migration 0050). Fewer than held: rebuilt from what is there.
  if (!ids.length || (entry && ids.length < entry.seen.size)) { cache.delete(runId); entry = undefined; }
  if (!entry) entry = { index: new PrivateTextIndex(), seen: new Set<string>(), usedAt: Date.now() };
  const missing = ids.filter((id) => !entry.seen.has(id));
  for (let at = 0; at < missing.length; at += 64) {
    for (const kept of await rows.privateTexts(runId, missing.slice(at, at + 64))) {
      await entry.index.add(kept);
      entry.seen.add(kept.id);
    }
  }
  entry.usedAt = Date.now();
  if (ids.length) { cache.delete(runId); cache.set(runId, entry); }
  evict(entry.usedAt, runId);
  return entry.index;
}

/** The run ended, as this process saw (its token was refused): its index goes now. */
export function forgetRunPrivateText(runId: string) { cache.delete(runId); }

/**
 * The fragment of the run's private text the address carries, or null (`privateFragmentIn`), behind the gate. `index` is the read's own,
 * from its first address, for its redirect hops; without it the run's index is brought up to date first.
 */
export async function checkRunAddress(db: DbExecutor, runId: string, address: string, chain: AddressChain, index?: PrivateTextIndex):
  Promise<{ fragment: string | null; index: PrivateTextIndex }> {
  return gated(runId, async () => {
    const current = index ?? await synced(db, runId);
    return { fragment: await privateFragmentIn(address, current, chain), index: current };
  });
}

/**
 * The first web address written in a change's text that carries private text the run read (#1138, C-30), and the fragment it carries;
 * null when none does. A link a person wrote, copied as it is, passes; so a later read of what the run wrote cannot pass a copy as one. An
 * address longer than a web address may be cannot be read later, and is not checked.
 */
export async function privateAddressWritten(db: DbExecutor, runId: string, text: string): Promise<{ address: string; fragment: string } | null> {
  const addresses = writtenAddresses(text);
  if (!addresses.length) return null;
  return gated(runId, async () => {
    const index = await synced(db, runId);
    for (const address of addresses) {
      try {
        const fragment = await privateFragmentIn(address, index);
        if (fragment) return { address, fragment };
      } catch (error) { if (!(error instanceof AddressTooLong)) throw error; }
    }
    return null;
  });
}

/** Every string a change's arguments hold, one per line. */
function argumentText(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) argumentText(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) argumentText(item, into);
  return into;
}

/** A run's change that writes a web address carrying private text it read, refused in plain words (#1138, C-30); null for any other change. */
export async function refusedPrivateAddress(db: DbExecutor, runId: string, args: Record<string, unknown>) {
  const found = await privateAddressWritten(db, runId, argumentText(args).join('\n'));
  if (!found) return null;
  return toolError(new DomainError(422, 'CHANGE_PRIVATE_ADDRESS', `That change writes a web address that carries words you read in Flux ("${found.fragment}"), `
    + 'and nothing from Flux may go into a web address. Make the change without that address; a link a person wrote can be copied as it is.'));
}
