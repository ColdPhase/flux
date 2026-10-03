import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

type Drafts = typeof import('../../apps/web/src/sketch/createdDraft.js');

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ada = uuid(1);
const jonas = uuid(2);
const map = uuid(900);
const keyOf = (person: string, sketch = map) => `flux:thought-draft:${person}:${uuid(10)}:project:${uuid(20)}:${sketch}`;
const thoughtDraft = (text: string) => ({ id: uuid(100), linkId: uuid(101), key: uuid(102), parentId: null, text, x: 0, y: 0 });
const EARLIER = 'Earlier persisted draft';
const LATEST = 'Latest recoverable draft after quota exhaustion';

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

/** Session storage as a browser exposes it: items are own properties and a full quota refuses a write. */
function installStorage() {
  const items: Record<string, string> = Object.create(null);
  const quota = { full: false };
  Object.defineProperties(items, {
    getItem: { value: (key: string) => items[key] ?? null },
    setItem: { value: (key: string, value: string) => {
      if (quota.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      items[key] = value;
    } },
    removeItem: { value: (key: string) => { delete items[key]; } },
  });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: items });
  return { items, quota };
}

let visits = 0;
/** A new page visit: no drafts are held in memory, while session storage stays as it was. */
const visit = async () => (await import(`../../apps/web/src/sketch/createdDraft.js?visit=${++visits}`)) as Drafts;

test('a refused storage write keeps this visit’s newest draft ahead of the older persisted copy', async () => {
  const { items, quota } = installStorage();
  const drafts = await visit();
  const key = keyOf(ada);
  drafts.writeThoughtDraft(key, thoughtDraft(EARLIER));
  quota.full = true;
  drafts.writeThoughtDraft(key, thoughtDraft(LATEST));
  assert.equal(JSON.parse(items[key]!).text, EARLIER, 'the browser kept only the older text');
  assert.equal(drafts.readThoughtDraft(key)?.text, LATEST);
});

test('storage that accepts writes again catches up, and a reload then restores the newest persisted draft', async () => {
  const { quota } = installStorage();
  const drafts = await visit();
  const key = keyOf(ada);
  drafts.writeThoughtDraft(key, thoughtDraft(EARLIER));
  quota.full = true;
  drafts.writeThoughtDraft(key, thoughtDraft(LATEST));
  quota.full = false;
  drafts.writeThoughtDraft(key, thoughtDraft('Newest draft once storage accepts writes again'));
  assert.equal(drafts.readThoughtDraft(key)?.text, 'Newest draft once storage accepts writes again');
  assert.equal((await visit()).readThoughtDraft(key)?.text, 'Newest draft once storage accepts writes again');
});

test('a reload restores only what storage accepted, and never a malformed entry', async () => {
  const { items, quota } = installStorage();
  const drafts = await visit();
  const key = keyOf(ada);
  drafts.writeThoughtDraft(key, thoughtDraft(EARLIER));
  quota.full = true;
  drafts.writeThoughtDraft(key, thoughtDraft(LATEST));
  const reloaded = await visit();
  assert.equal(reloaded.readThoughtDraft(key)?.text, EARLIER);
  items[key] = '{bad';
  assert.equal(reloaded.readThoughtDraft(key), null);
  items[key] = JSON.stringify({ ...thoughtDraft(EARLIER), id: 'not-an-id' });
  assert.equal(reloaded.readThoughtDraft(key), null);
});

test('cancel and save clear this visit’s copy and the persisted one, so a refused write cannot bring either back', async () => {
  const { items, quota } = installStorage();
  const drafts = await visit();
  const key = keyOf(ada);
  drafts.writeThoughtDraft(key, thoughtDraft(EARLIER));
  quota.full = true;
  drafts.writeThoughtDraft(key, thoughtDraft(LATEST));
  drafts.writeThoughtDraft(key, null);
  assert.equal(drafts.readThoughtDraft(key), null);
  assert.deepEqual(Object.keys(items), []);
  assert.equal((await visit()).readThoughtDraft(key), null);
});

test('sign-out forgets every draft of this tab, in memory and in storage, and leaves other storage alone', async () => {
  const { items, quota } = installStorage();
  const drafts = await visit();
  drafts.writeThoughtDraft(keyOf(ada), thoughtDraft('Ada stored'));
  quota.full = true;
  drafts.writeThoughtDraft(keyOf(jonas), thoughtDraft('Jonas in memory only'));
  quota.full = false;
  items['flux.sketch.mode'] = 'list';
  drafts.forgetThoughtDrafts();
  assert.equal(drafts.readThoughtDraft(keyOf(ada)), null);
  assert.equal(drafts.readThoughtDraft(keyOf(jonas)), null);
  assert.deepEqual(Object.keys(items), ['flux.sketch.mode']);
});

test('a draft is recoverable only by its own account and map, in its own tab', async () => {
  const { quota } = installStorage();
  const drafts = await visit();
  drafts.writeThoughtDraft(keyOf(ada), thoughtDraft('Ada stored'));
  quota.full = true;
  drafts.writeThoughtDraft(keyOf(ada, uuid(901)), thoughtDraft('Ada on another map, in memory only'));
  assert.equal(drafts.recoverableThoughtDraftKey(ada, map), keyOf(ada));
  assert.equal(drafts.recoverableThoughtDraftKey(ada, uuid(901)), keyOf(ada, uuid(901)));
  assert.equal(drafts.recoverableThoughtDraftKey(jonas, map), null);
  assert.equal(drafts.recoverableThoughtDraftKey(ada, uuid(902)), null);
  assert.equal(drafts.readThoughtDraft(keyOf(jonas)), null);
  installStorage();
  const otherTab = await visit();
  assert.equal(otherTab.recoverableThoughtDraftKey(ada, map), null);
  assert.equal(otherTab.readThoughtDraft(keyOf(ada)), null);
});

test('blocked session storage still keeps this visit’s drafts, without throwing', async () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('Access is denied.', 'SecurityError'); } });
  const drafts = await visit();
  const key = keyOf(ada);
  drafts.writeThoughtDraft(key, thoughtDraft(LATEST));
  assert.equal(drafts.readThoughtDraft(key)?.text, LATEST);
  assert.equal(drafts.recoverableThoughtDraftKey(ada, map), key);
  drafts.writeThoughtDraft(key, null);
  assert.equal(drafts.readThoughtDraft(key), null);
  drafts.forgetThoughtDrafts();
});
