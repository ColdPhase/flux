import { useEffect, useState } from 'react';
import type { SketchDetail } from '@flux/contracts';
import { buildOutline, emptyOutline, OUTLINE_STORE_KEY, readStoredOutline, rememberThoughts, sibling, swapOrder, writeStoredOutline, type OutlineState } from './outline';

export function outlineKey(personId: string, workspaceId: string, sketchId: string): string {
  return `${personId}:${workspaceId}:${sketchId}`;
}

function load(key: string | null): OutlineState {
  try { return key ? readStoredOutline(localStorage.getItem(OUTLINE_STORE_KEY), key) : emptyOutline(); } catch { return emptyOutline(); }
}

/**
 * The List's tree (#510) with this person's reading preferences (#134): sibling order and folded
 * branches. Session state stays useful if localStorage is unavailable. It never caches graph content.
 */
export function useOutline(personId: string, sketch: SketchDetail | null) {
  const key = sketch ? outlineKey(personId, sketch.workspaceId, sketch.id) : null;
  const [loaded, setLoaded] = useState(() => ({ key, state: load(key) }));
  let current = loaded;
  if (loaded.key !== key) {
    current = { key, state: load(key) };
    setLoaded(current);
  }
  const state = sketch ? rememberThoughts(current.state, sketch.thoughts) : current.state;
  if (state !== current.state) setLoaded({ ...current, state });
  const outline = buildOutline(sketch?.thoughts ?? [], sketch?.links ?? [], state);
  useEffect(() => {
    if (!key) return;
    try { localStorage.setItem(OUTLINE_STORE_KEY, writeStoredOutline(localStorage.getItem(OUTLINE_STORE_KEY), key, state)); } catch { /* only this session can remember it */ }
  }, [key, state]);

  const change = (update: (before: OutlineState) => OutlineState) => {
    setLoaded((before) => ({ ...before, state: update(sketch ? rememberThoughts(before.state, sketch.thoughts) : before.state) }));
  };
  return {
    state,
    outline,
    toggle: (id: string) => change((before) => ({ ...before, collapsed: before.collapsed.includes(id) ? before.collapsed.filter((item) => item !== id) : [...before.collapsed, id] })),
    reveal: (id: string) => change((before) => ({ ...before, collapsed: before.collapsed.filter((item) => !outline.byId.get(id)?.ancestors.includes(item)) })),
    restoreCollapsed: (collapsed: string[]) => change((before) => ({ ...before, collapsed })),
    /** ⌥↑/⌥↓ (#510 AC-6): this person's order among siblings; the map is unchanged. False at either end. */
    move: (id: string, step: -1 | 1) => {
      const other = sibling(outline, id, step);
      if (!other) return false;
      change((before) => swapOrder(before, id, other));
      return true;
    },
  };
}

export type PersonalOutline = ReturnType<typeof useOutline>;
