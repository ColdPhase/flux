import { useEffect, useState } from 'react';
import type { SketchDetail } from '@flux/contracts';
import { buildOutline, emptyOutline, OUTLINE_STORE_KEY, readStoredOutline, rememberThoughts, writeStoredOutline, type OutlineState } from './outline';

export function outlineKey(personId: string, workspaceId: string, sketchId: string): string {
  return `${personId}:${workspaceId}:${sketchId}`;
}

function load(key: string | null): OutlineState {
  try { return key ? readStoredOutline(localStorage.getItem(OUTLINE_STORE_KEY), key) : emptyOutline(); } catch { return emptyOutline(); }
}

/** Session state stays useful if localStorage is unavailable. It never caches graph content. */
export function useOutline(personId: string, sketch: SketchDetail | null) {
  const key = sketch ? outlineKey(personId, sketch.workspaceId, sketch.id) : null;
  const [loaded, setLoaded] = useState(() => ({ key, state: load(key), undo: [] as OutlineState[] }));
  let current = loaded;
  if (loaded.key !== key) {
    current = { key, state: load(key), undo: [] };
    setLoaded(current);
  }
  const state = sketch ? rememberThoughts(current.state, sketch.thoughts) : current.state;
  if (state !== current.state) setLoaded({ ...current, state });
  const outline = buildOutline(sketch?.thoughts ?? [], sketch?.links ?? [], state);
  useEffect(() => {
    if (!key) return;
    try { localStorage.setItem(OUTLINE_STORE_KEY, writeStoredOutline(localStorage.getItem(OUTLINE_STORE_KEY), key, state)); } catch { /* only this session can remember it */ }
  }, [key, state]);

  const change = (update: (before: OutlineState) => OutlineState, undoable = false) => {
    setLoaded((before) => ({ ...before, state: update(sketch ? rememberThoughts(before.state, sketch.thoughts) : before.state), undo: undoable ? [...before.undo.slice(-19), before.state] : before.undo }));
  };
  const group = (id: string, parentId: string | null, undoable = true) => change((before) => {
    const grouped = { ...before, order: before.order.includes(id) ? before.order : [...before.order, id], parents: { ...before.parents, [id]: parentId } };
    const ancestors = parentId ? [...(outline.byId.get(parentId)?.ancestors ?? []), parentId] : [];
    return { ...grouped, collapsed: grouped.collapsed.filter((item) => !ancestors.includes(item)) };
  }, undoable);
  return {
    state,
    outline,
    group,
    toggle: (id: string) => change((before) => ({ ...before, collapsed: before.collapsed.includes(id) ? before.collapsed.filter((item) => item !== id) : [...before.collapsed, id] })),
    reveal: (id: string) => change((before) => ({ ...before, collapsed: before.collapsed.filter((item) => !outline.byId.get(id)?.ancestors.includes(item)) })),
    restoreCollapsed: (collapsed: string[]) => change((before) => ({ ...before, collapsed })),
    canUndo: current.undo.length > 0,
    undo: () => setLoaded((before) => {
      const previous = before.undo.at(-1);
      return previous ? { ...before, state: { ...before.state, parents: previous.parents }, undo: before.undo.slice(0, -1) } : before;
    }),
  };
}

export type PersonalOutline = ReturnType<typeof useOutline>;
