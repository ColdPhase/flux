import type { DocState } from '@flux/contracts';
import { forgetReloadRetention, setReloadRetention } from '../app/reload-retention';

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
  setReloadRetention('wiki', key, key.split(':')[2]!, refused, true);
}

/** Confirmed device sign-out, not error recovery, retires these private editor copies. */
export function forgetDocumentDrafts() {
  generation++;
  retiredStorage = true;
  memory.clear();
  forgetReloadRetention('wiki');
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('flux:doc-edit:')) sessionStorage.removeItem(key);
  } catch { /* Retirement has still discarded this visit's private overrides. */ }
}
