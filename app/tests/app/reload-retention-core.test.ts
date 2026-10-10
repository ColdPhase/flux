import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { forgetReloadRetention, reloadRetention, reloadRetentionRevision, setReloadRetention } from '../../apps/web/src/app/reload-retention.js';
import { documentDraftGeneration, draftKey, forgetDocumentDrafts, keep, readKept, type Kept } from '../../apps/web/src/docs/drafts.js';

const owner = 'owner-one', other = 'owner-two';
const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  for (const store of ['draft', 'composer', 'thought', 'wiki'] as const) forgetReloadRetention(store);
  forgetDocumentDrafts();
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

function storage() {
  const items: Record<string, string> = Object.create(null);
  const refusal = { write: false, clear: false };
  Object.defineProperties(items, {
    getItem: { value: (key: string) => items[key] ?? null },
    setItem: { value: (key: string, value: string) => {
      if (refusal.write) throw new DOMException('Full', 'QuotaExceededError'); items[key] = value;
    } },
    removeItem: { value: (key: string) => {
      if (refusal.clear) throw new DOMException('Denied', 'SecurityError'); delete items[key];
    } },
  });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: items });
  return { items, refusal };
}

test('an owned visit copy blocks reload; a foreign or unverified copy is never declared disposable', () => {
  setReloadRetention('composer', 'command', owner, true);
  assert.equal(reloadRetention(owner), 'blocked');
  assert.equal(reloadRetention(other), 'unknown');
  assert.equal(reloadRetention(null), 'unknown');
  setReloadRetention('composer', 'command', owner, false);
  assert.equal(reloadRetention(owner), 'safe');
});

test('a new risk or successful settlement invalidates the decision revision, independently of other store retirement', () => {
  const before = reloadRetentionRevision();
  setReloadRetention('thought', Symbol.for('selected-private-bytes'), owner, true);
  assert.notEqual(reloadRetentionRevision(), before);
  setReloadRetention('draft', 'failed-empty-clear', owner, true);
  forgetReloadRetention('thought');
  assert.equal(reloadRetention(owner), 'blocked', 'retiring one source never silently discards another source');
  forgetReloadRetention('draft');
  assert.equal(reloadRetention(owner), 'safe');
  const beforeSavedEdit = reloadRetentionRevision();
  setReloadRetention('draft', 'durably-written-edit', owner, false, true);
  assert.notEqual(reloadRetentionRevision(), beforeSavedEdit, 'even a safe newer edit invalidates an earlier in-flight reload decision');
});

test('confirmed device retirement invalidates a held reload decision even with no unsafe work', () => {
  for (const store of ['draft', 'composer', 'thought', 'wiki'] as const) forgetReloadRetention(store);
  assert.equal(reloadRetention(owner), 'safe');
  const before = reloadRetentionRevision();
  forgetReloadRetention('composer');
  assert.notEqual(reloadRetentionRevision(), before, 'empty/safe retirement still changes the action ownership epoch');
  assert.equal(reloadRetention(owner), 'safe');
});

test('Wiki refused newer bytes retain exact fields/base/attempt over older storage; a refused clear remains a tombstone', () => {
  const { items, refusal } = storage();
  const key = draftKey(owner, 'doc', 'project');
  const earlier: Kept = { title: 'Earlier A', body: 'Older private bytes', state: 'draft', reason: '', base: 7, attempt: 'same-save-command' };
  const latest: Kept = { ...earlier, title: 'Newest B', body: 'Latest private bytes including [source](doc:123)' };
  keep(key, earlier);
  refusal.write = true;
  keep(key, latest);
  assert.deepEqual(readKept(key), latest);
  assert.deepEqual(JSON.parse(items[key]!), earlier);
  assert.equal(reloadRetention(owner), 'blocked');
  refusal.clear = true;
  keep(key, null);
  assert.equal(readKept(key), null);
  assert.deepEqual(JSON.parse(items[key]!), earlier);
  assert.equal(reloadRetention(owner), 'blocked', 'a failed clear cannot revive A on reload');
  refusal.clear = false;
  keep(key, null);
  assert.equal(items[key], undefined);
  assert.equal(reloadRetention(owner), 'safe');
});

test('confirmed Wiki retirement fences a held earlier writer even when durable removal is refused', () => {
  const { items, refusal } = storage();
  const key = draftKey(owner, 'old-doc', 'project');
  const value: Kept = { title: 'Private', body: 'Visit work', state: 'draft', reason: '', base: 2, attempt: 'old-attempt' };
  const oldLifetime = documentDraftGeneration();
  keep(key, value, oldLifetime);
  refusal.clear = true;
  forgetDocumentDrafts();
  keep(key, { ...value, body: 'Late old callback' }, oldLifetime);
  assert.equal(readKept(key), null);
  assert.deepEqual(JSON.parse(items[key]!), value, 'failed retirement was not falsely claimed durable');
  assert.equal(reloadRetention(owner), 'safe', 'the confirmed retired session has no live visit copy');
});
