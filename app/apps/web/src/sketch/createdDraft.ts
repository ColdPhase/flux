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
const memory = new Map<string, ThoughtDraft>();

function read(key: string | null): ThoughtDraft | null {
  if (!key) return null;
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
  return memory.get(key) ?? null;
}

export function forgetThoughtDrafts() {
  memory.clear();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Refused storage never received these drafts. */ }
}

/** One private capture for this account and actual authorized map audience. */
export function useThoughtDraft(personId: string, sketchId: string, sketch: SketchDetail | null) {
  // A reload after revocation cannot fetch the old audience. Only this person's own private
  // text may still be recovered; no shared title or content is stored in the draft.
  const privateKeys = new Set(memory.keys());
  try { for (const item of Object.keys(sessionStorage)) privateKeys.add(item); } catch { /* memory fallback */ }
  const recoveredKey = [...privateKeys].find((item) => item.startsWith(`${PREFIX}${personId}:`) && item.endsWith(`:${sketchId}`)) ?? null;
  const key = sketch ? `${PREFIX}${personId}:${sketch.workspaceId}:${sketch.scope}:${sketch.projectId ?? sketch.dmId ?? personId}:${sketch.id}` : recoveredKey;
  const [loaded, setLoaded] = useState(() => ({ key, draft: read(key) }));
  let current = loaded;
  if (loaded.key !== key) {
    current = { key, draft: read(key) };
    setLoaded(current);
  }
  const set = (draft: ThoughtDraft | null) => {
    if (!key) return;
    if (draft) memory.set(key, draft); else memory.delete(key);
    try {
      if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key);
    } catch { /* Keep the visit-local copy. */ }
    setLoaded({ key, draft });
  };
  return { draft: current.draft, set };
}
