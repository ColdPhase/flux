import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { draftKey, keep, keepLeft, peekLeft, readKept, retireLeftCopies, takeLeft } from '../../apps/web/src/docs/drafts.js';
import { dropSavedCopy, savedLater, type VersionReader } from '../../apps/web/src/editing/saved-copy.js';

// A kept copy of unsaved Wiki text whose closing save already succeeded (#982): dropped when a later version by the same person holds its
// text, so the next visit shows no false conflict; and the copies a closed tab left do not outlive their account's absence. Browser storage
// is a pair of fake stores; the web modules are the real ones.
class FakeStorage {
  getItem(key: string): string | null { return Object.hasOwn(this, key) ? (this as unknown as Record<string, string>)[key]! : null; }
  setItem(key: string, value: string) { (this as unknown as Record<string, string>)[key] = String(value); }
  removeItem(key: string) { delete (this as unknown as Record<string, string>)[key]; }
}
const globals = globalThis as unknown as Record<string, unknown>;
const ADA = 'user-ada', BOB = 'user-bob', DOC = '11111111-1111-4111-8111-111111111111', PROJECT = '22222222-2222-4222-8222-222222222222';
const doc = (version: number, body: string) => ({ id: DOC, projectId: PROJECT, version, body });
const kept = (body: string, base: number) => ({ title: 'Plan', body, base });
const person = (id: string, kind: 'human' | 'agent' = 'human') => ({ kind, id, name: id });
const key = (user: string) => draftKey(user, DOC, PROJECT);

/** A page's history: version n was saved by `history[n]`, with its text. */
function reader(history: Record<number, { by: ReturnType<typeof person>; body: string }>, calls: string[] = []): VersionReader {
  return {
    async newest(_id, count) {
      calls.push(`newest ${count}`);
      return Object.keys(history).map(Number).sort((a, b) => b - a).slice(0, count).map((version) => ({ version, author: history[version]!.by }));
    },
    async body(_id, version) { calls.push(`body ${version}`); return history[version]!.body; },
  };
}

beforeEach(() => {
  globals.sessionStorage = new FakeStorage();
  globals.localStorage = new FakeStorage();
  keep(key(ADA), null); keep(key(BOB), null);
});

test('a later version by the same person that holds the copy\'s text means the copy was saved', async () => {
  const history = { 3: { by: person(ADA), body: 'Start' }, 4: { by: person(ADA), body: 'Ada text' }, 5: { by: person(BOB), body: 'Bob text' } };
  assert.equal(await savedLater(kept('Ada text', 3), doc(5, 'Bob text'), ADA, reader(history)), true);
  // The same text saved by someone else is not hers; a different text of hers is not this copy; an agent with her id is not her.
  assert.equal(await savedLater(kept('Ada text', 3), doc(5, 'Bob text'), BOB, reader(history)), false);
  assert.equal(await savedLater(kept('Ada text, more', 3), doc(5, 'Bob text'), ADA, reader(history)), false);
  assert.equal(await savedLater(kept('Ada text', 3), doc(5, 'Bob text'), ADA, reader({ ...history, 4: { by: person(ADA, 'agent'), body: 'Ada text' } })), false);
  // Only versions after the copy's own base count: version 3 holding the text is what the copy was made from.
  assert.equal(await savedLater(kept('Start', 3), doc(5, 'Bob text'), ADA, reader(history)), false);
});

test('a copy on the page\'s current version, or with the page\'s own text, needs no look at the history', async () => {
  const calls: string[] = [];
  assert.equal(await savedLater(kept('Ada text', 5), doc(5, 'Other'), ADA, reader({}, calls)), false, 'its save is just pending');
  assert.equal(await savedLater(kept('Same', 3), doc(5, 'Same'), ADA, reader({}, calls)), false, 'the editor sees it is clean');
  assert.deepEqual(calls, [], 'nothing was read');
});

test('only the newest versions after the copy are read, and only a few of the person\'s own in full', async () => {
  const history: Record<number, { by: ReturnType<typeof person>; body: string }> = {};
  for (let version = 1; version <= 60; version += 1) history[version] = { by: person(ADA), body: `Text ${version}` };
  const calls: string[] = [];
  assert.equal(await savedLater(kept('Text 2', 1), doc(60, 'Text 60'), ADA, reader(history, calls)), false, 'version 2 is too far back to look for');
  assert.deepEqual(calls, ['newest 20', 'body 60', 'body 59', 'body 58', 'body 57', 'body 56']);
});

test('dropping removes both the tab\'s copy and the one a closed tab left; a failed read keeps them', async () => {
  const copy = kept('Ada text', 3);
  keepLeft(key(ADA), copy);
  keep(key(ADA), copy);
  keepLeft(key(ADA), copy); // keep() with a value leaves the device copy as it was; leaving writes it again
  assert.ok(peekLeft(key(ADA)) && readKept(key(ADA)));
  const failing: VersionReader = { async newest() { throw new Error('offline'); }, async body() { return ''; } };
  assert.equal(await dropSavedCopy(doc(5, 'Bob text'), ADA, failing), false);
  assert.ok(peekLeft(key(ADA)) && readKept(key(ADA)), 'a copy is only dropped when the history says so');
  const history = { 4: { by: person(ADA), body: 'Ada text' }, 5: { by: person(BOB), body: 'Bob text' } };
  assert.equal(await dropSavedCopy(doc(5, 'Bob text'), ADA, reader(history)), true);
  assert.equal(peekLeft(key(ADA)), null);
  assert.equal(readKept(key(ADA)), null);
  assert.equal(takeLeft(key(ADA)), null);
  assert.equal(await dropSavedCopy(doc(5, 'Bob text'), ADA, reader(history)), false, 'nothing left to drop');
});

test('a look that stalls ends at its limit with the copy kept, and the reads of the person\'s own versions run together', async () => {
  keep(key(ADA), kept('Ada text', 3));
  const stalled: VersionReader = {
    newest: (_id, _count, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
    body: async () => '',
  };
  const started = Date.now();
  assert.equal(await dropSavedCopy(doc(5, 'Bob text'), ADA, stalled, undefined, 30), false);
  assert.ok(Date.now() - started < 1000, 'the editor is not held up');
  assert.ok(readKept(key(ADA)), 'and the copy is still there');
  // Every body is asked for before the first answer: no read waits for another.
  const asked: number[] = [];
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const parallel: VersionReader = {
    async newest() { return [5, 4, 3].map((version) => ({ version, author: person(ADA) })); },
    async body(_id, version) { asked.push(version); await gate; return `Text ${version}`; },
  };
  const look = savedLater(kept('Text 4', 1), doc(5, 'Text 5'), ADA, parallel);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, [5, 4, 3], 'all three were asked before any answered');
  release();
  assert.equal(await look, true);
});

test('another account\'s visit removes the copies closed tabs left; the person\'s own are never removed by age (#982)', () => {
  const store = globals.localStorage as FakeStorage;
  const long = 400 * 24 * 3600 * 1000;
  const write = (user: string, doc: string, at?: number) => store.setItem(`flux:doc-left:${user}:${doc}`, JSON.stringify({ title: 'T', body: 'B', base: 1, ...(at === undefined ? {} : { at }) }));
  write(ADA, 'fresh');
  write(ADA, 'very-old', Date.now() - long);
  write(BOB, 'fresh');
  store.setItem('flux:sidebar', 'rail');
  retireLeftCopies(ADA);
  assert.deepEqual(Object.keys(store).sort(), ['flux:doc-left:user-ada:fresh', 'flux:doc-left:user-ada:very-old', 'flux:sidebar'],
    'Bob\'s copy went with Ada\'s visit; Ada\'s own stay, though one is more than a year old: unsaved text may be the only copy there is');
  retireLeftCopies(BOB);
  assert.deepEqual(Object.keys(store).sort(), ['flux:sidebar'], 'and Ada\'s went with Bob\'s visit');
});
