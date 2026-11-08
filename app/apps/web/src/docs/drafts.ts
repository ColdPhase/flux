import type { DocState } from '@flux/contracts';
import { forgetReloadRetention, setReloadRetention } from '../app/reload-retention.js';

// Unsaved editor text, kept per person and page in this tab (#112) so a reload or a move to
// another page or tab does not lose it. The reader says when a page has some (#136).

export interface Fields { title: string; body: string; state: DocState; reason: string }
/** `attempt`: the idempotency key of a save whose answer was lost, reused after a reload. */
export interface Kept extends Fields { base: number; attempt?: string }

export const draftKey = (userId: string, docId: string | null, projectId: string) => `flux:doc-edit:${userId}:${docId ?? `new:${projectId}`}`;
const memory = new Map<string, Kept | null>();
let generation = 0;
let retiredStorage = false;
export const documentDraftGeneration = () => generation;

/**
 * Visit-local recovery copies of the live Wiki (#326 contract, #228 shared working copy). It keeps the
 * newest copy here when browser storage refuses it, and sign-out retires it with the classic copies.
 * It lives here, not beside the shared-text bundle, so an ordinary wiki never loads that bundle.
 */
const liveCopies = new Map<string, unknown>();
export const liveCopyLifetime = () => generation;
export function readLiveCopy<T>(key: string): T | null | undefined {
  return liveCopies.has(key) ? liveCopies.get(key) as T | null : undefined;
}
/** Keeps one live copy (or clears it) and reports whether the browser refused the write. A retired lifetime writes nothing. */
export function keepLiveCopy(key: string, value: unknown, lifetime: number): boolean {
  if (lifetime !== generation) return false;
  liveCopies.set(key, value);
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); return false; }
  catch { return true; }
}

export function readKept(key: string): Kept | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  if (retiredStorage) return null;
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) as Kept : null; } catch { return null; }
}

export function keep(key: string, value: Kept | null, lifetime = generation) {
  if (lifetime !== generation) return;
  memory.set(key, value);
  let refused = false;
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { refused = true; }
  // Saved or set aside: no copy is left on this device either.
  if (!value) keepLeft(key, null, lifetime);
  setReloadRetention('wiki', key, key.split(':')[2]!, refused, true);
}

/**
 * The unsaved text of a tab that closed, kept on this device (#967): the tab's own copy goes with the tab, and the saves
 * sent as it closed may all be refused, so the next visit to the page restores this one. Sign-out removes it.
 */
const leftKey = (key: string) => key.replace(/^flux:doc-edit:/, 'flux:doc-left:');
export function keepLeft(key: string, value: Kept | null, lifetime = generation) {
  if (lifetime !== generation) return;
  try { if (value) localStorage.setItem(leftKey(key), JSON.stringify(value)); else localStorage.removeItem(leftKey(key)); }
  catch { /* The tab's own copy and the saves sent as it closes remain. */ }
}
/** Takes the copy a closed tab left: from now on this tab keeps it. */
export function takeLeft(key: string): Kept | null {
  if (retiredStorage) return null;
  try {
    const raw = localStorage.getItem(leftKey(key));
    if (!raw) return null;
    localStorage.removeItem(leftKey(key));
    const value = JSON.parse(raw) as Partial<Kept> | null;
    return value && typeof value.body === 'string' && typeof value.title === 'string' && Number.isSafeInteger(value.base) ? value as Kept : null;
  } catch { return null; }
}

/** Confirmed device sign-out, not error recovery, retires these private editor copies. */
export function forgetDocumentDrafts() {
  generation++;
  retiredStorage = true;
  memory.clear();
  liveCopies.clear();
  forgetReloadRetention('wiki');
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('flux:doc-edit:') || key.startsWith('flux:wiki-live:')) sessionStorage.removeItem(key);
  } catch { /* Retirement has still discarded this visit's private overrides. */ }
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('flux:doc-left:')) localStorage.removeItem(key); }
  catch { /* A copy left on this device stays unread: this visit no longer reads stored copies. */ }
}
