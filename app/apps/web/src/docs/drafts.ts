import type { DocState } from '@flux/contracts';

// Unsaved editor text, kept per person and page in this tab (#112) so a reload or a move to
// another page or tab does not lose it. The reader says when a page has some (#136).

export interface Fields { title: string; body: string; state: DocState; reason: string }
export interface Kept extends Fields { base: number }

export const draftKey = (userId: string, docId: string | null, projectId: string) => `flux:doc-edit:${userId}:${docId ?? `new:${projectId}`}`;

export function readKept(key: string): Kept | null {
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) as Kept : null; } catch { return null; }
}

export function keep(key: string, value: Kept | null) {
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* private mode */ }
}
