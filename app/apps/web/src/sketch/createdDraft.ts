import { useState } from 'react';
import { SKETCH_LIMITS, type SketchDetail } from '@flux/contracts';

export interface ThoughtDraft {
  id: string;
  linkId: string;
  key: string;
  parentId: string | null;
  text: string;
  x: number;
  y: number;
}
const PREFIX = 'flux:thought-draft:';
// This visit's newest copy of each draft. Session storage can refuse a write (quota) and keep an
// older copy, so it only supplies a draft this visit has not touched, such as after a reload.
const memory = new Map<string, ThoughtDraft>();

function persisted(key: string): ThoughtDraft | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object') {
      const draft = value as Partial<ThoughtDraft>;
      if ([draft.id, draft.linkId, draft.key].every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
        && (draft.parentId === null || typeof draft.parentId === 'string')
        && typeof draft.text === 'string' && draft.text.length <= SKETCH_LIMITS.text
        && typeof draft.x === 'number' && Number.isFinite(draft.x) && typeof draft.y === 'number' && Number.isFinite(draft.y)) return draft as ThoughtDraft;
    }
  } catch { /* Storage may be refused; the current visit still retains its drafts. */ }
  return null;
}

/** The newest draft for this key: this visit's own copy, else one persisted before a reload. */
export function readThoughtDraft(key: string | null): ThoughtDraft | null {
  return key ? memory.get(key) ?? persisted(key) : null;
}

/** Saves the draft, or clears it everywhere with `null`. A refused storage write keeps the visit's copy. */
export function writeThoughtDraft(key: string, draft: ThoughtDraft | null) {
  if (draft) memory.set(key, draft); else memory.delete(key);
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key);
  } catch { /* Keep the visit-local copy. */ }
}

export function forgetThoughtDrafts() {
  memory.clear();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Refused storage never received these drafts. */ }
}

/** A reload after revocation cannot fetch the old audience. Only this person's own private text
 *  may still be recovered; no shared title or content is stored in the draft. */
export function recoverableThoughtDraftKey(personId: string, sketchId: string): string | null {
  const privateKeys = new Set(memory.keys());
  try { for (const item of Object.keys(sessionStorage)) privateKeys.add(item); } catch { /* memory fallback */ }
  return [...privateKeys].find((item) => item.startsWith(`${PREFIX}${personId}:`) && item.endsWith(`:${sketchId}`)) ?? null;
}

/** One private capture for this account and actual authorized map audience. */
export function useThoughtDraft(personId: string, sketchId: string, sketch: SketchDetail | null) {
  const key = sketch ? `${PREFIX}${personId}:${sketch.workspaceId}:${sketch.scope}:${sketch.projectId ?? sketch.dmId ?? personId}:${sketch.id}` : recoverableThoughtDraftKey(personId, sketchId);
  const [loaded, setLoaded] = useState(() => ({ key, draft: readThoughtDraft(key) }));
  let current = loaded;
  if (loaded.key !== key) {
    current = { key, draft: readThoughtDraft(key) };
    setLoaded(current);
  }
  const set = (draft: ThoughtDraft | null) => {
    if (!key) return;
    writeThoughtDraft(key, draft);
    setLoaded({ key, draft });
  };
  return { draft: current.draft, set };
}
