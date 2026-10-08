/** Visit-only recovery metadata. Private contents and command/file identities stay in their stores. */
type Store = 'draft' | 'composer' | 'thought' | 'wiki';
type Key = string | symbol;
const retained = new Map<Key, { store: Store; accountId: string }>();
const listeners = new Set<() => void>();
let revision = 0;
let notificationQueued = false;

function changed() {
  revision++;
  if (notificationQueued) return;
  notificationQueued = true;
  queueMicrotask(() => { notificationQueued = false; listeners.forEach((listener) => listener()); });
}

export function setReloadRetention(store: Store, key: Key, accountId: string, unsafe: boolean, invalidate = false) {
  const old = retained.get(key);
  if (!unsafe) { if (retained.delete(key) || invalidate) changed(); return; }
  if (old?.store === store && old.accountId === accountId) { if (invalidate) changed(); return; }
  retained.set(key, { store, accountId });
  changed();
}

/** Called by a store's existing confirmed retirement, never by the recovery UI. */
export function forgetReloadRetention(store: Store) {
  let removed = false;
  for (const [key, entry] of retained) if (entry.store === store) { retained.delete(key); removed = true; }
  if (removed) changed();
}

export function reloadRetention(accountId: string | null): 'safe' | 'blocked' | 'unknown' {
  if (accountId && [...retained.values()].some((entry) => entry.accountId === accountId)) return 'blocked';
  // Another or unverified account's memory is never treated as disposable by this UI.
  return retained.size ? 'unknown' : 'safe';
}

export const reloadRetentionRevision = () => revision;
export function subscribeReloadRetention(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
