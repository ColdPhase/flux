import type { Thought, ThoughtLink } from '@flux/contracts';

/** A personal display preference, never a domain parent or authorization cache (#134). */
export interface OutlineState {
  version: 1;
  order: string[];
  parents: Record<string, string | null>;
  collapsed: string[];
}
export interface OutlineRow {
  thought: Thought;
  parentId: string | null;
  depth: number;
  ancestors: string[];
  children: string[];
}
export interface Outline {
  rows: OutlineRow[];
  byId: Map<string, OutlineRow>;
}

export const OUTLINE_LIMIT = 2000;
export const OUTLINE_STORE_KEY = 'flux.sketch.outlines.v1';
export const OUTLINE_STORE_LIMIT = 4000;
export const OUTLINE_STORE_BYTES = 512_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const emptyOutline = (): OutlineState => ({ version: 1, order: [], parents: {}, collapsed: [] });

/** Drop malformed/content-bearing state; all rendering still comes from the current GET. */
export function readOutline(raw: string | null): OutlineState {
  if (!raw) return emptyOutline();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return emptyOutline();
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || !Array.isArray(state.order) || !Array.isArray(state.collapsed) || !state.parents || typeof state.parents !== 'object') return emptyOutline();
    const ids = (values: unknown[]) => [...new Set(values.filter((id): id is string => typeof id === 'string' && uuid.test(id)))].slice(-OUTLINE_LIMIT);
    const order = ids(state.order);
    const remembered = new Set(order);
    const parents: Record<string, string | null> = {};
    for (const [id, parent] of Object.entries(state.parents)) {
      if (remembered.has(id) && (parent === null || (typeof parent === 'string' && uuid.test(parent) && parent !== id))) parents[id] = parent;
    }
    return { version: 1, order, parents, collapsed: ids(state.collapsed).filter((id) => remembered.has(id)) };
  } catch { return emptyOutline(); }
}

function storedOutlines(raw: string | null): { key: string; state: OutlineState }[] {
  if (!raw || raw.length > OUTLINE_STORE_BYTES) return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.slice(-16).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') return [];
      const ids = entry.key.split(':');
      if (ids.length !== 3 || !ids.every((id: string) => uuid.test(id))) return [];
      return [{ key: entry.key, state: readOutline(JSON.stringify(entry.state)) }];
    });
  } catch { return []; }
}

export function readStoredOutline(raw: string | null, key: string): OutlineState {
  return storedOutlines(raw).find((entry) => entry.key === key)?.state ?? emptyOutline();
}

/** One bounded store across accounts/sketches, oldest visited sketches evicted first. */
export function writeStoredOutline(raw: string | null, key: string, state: OutlineState): string {
  const values = [...storedOutlines(raw).filter((entry) => entry.key !== key), { key, state: readOutline(JSON.stringify(state)) }];
  while (values.length > 1 && (values.length > 16 || values.reduce((count, entry) => count + entry.state.order.length, 0) > OUTLINE_STORE_LIMIT || JSON.stringify(values).length > OUTLINE_STORE_BYTES)) values.shift();
  return JSON.stringify(values);
}

/** Remember immutable reading order and bounded ID-only tombstones for graph undo. */
export function rememberThoughts(state: OutlineState, thoughts: readonly Thought[]): OutlineState {
  const known = new Set(state.order);
  const added = [...thoughts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).filter((thought) => !known.has(thought.id)).map((thought) => thought.id);
  if (!added.length && state.order.length <= OUTLINE_LIMIT) return state;
  const order = [...state.order, ...added].slice(-OUTLINE_LIMIT);
  const remembered = new Set(order);
  return { version: 1, order, parents: Object.fromEntries(Object.entries(state.parents).filter(([id]) => remembered.has(id))), collapsed: state.collapsed.filter((id) => remembered.has(id)) };
}

export function linkedPairs(links: readonly ThoughtLink[]): Set<string> {
  return new Set(links.map((link) => pair(link.fromId, link.toId)));
}
export const pair = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;

/** Fresh graphs are roots. Only remembered explicit choices can become a displayed edge. */
export function buildOutline(thoughts: readonly Thought[], links: readonly ThoughtLink[], state: OutlineState): Outline {
  const present = new Map(thoughts.map((thought) => [thought.id, thought]));
  const remembered = new Set(state.order);
  const order = [...state.order.filter((id) => present.has(id)), ...[...present.values()].filter((thought) => !remembered.has(thought.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((thought) => thought.id)];
  const pairs = linkedPairs(links);
  const parents = new Map(order.map((id) => {
    const parent = state.parents[id];
    return [id, parent && parent !== id && present.has(parent) && pairs.has(pair(id, parent)) ? parent : null] as const;
  }));
  // Corrupt local cycles are detached together, independent of input traversal order.
  const done = new Set<string>();
  for (const id of order) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let next: string | null = id;
    while (next && !done.has(next)) {
      const start = seen.get(next);
      if (start !== undefined) { for (const cyclic of path.slice(start)) parents.set(cyclic, null); break; }
      seen.set(next, path.length);
      path.push(next);
      next = parents.get(next) ?? null;
    }
    for (const visited of path) done.add(visited);
  }
  const children = new Map<string | null, string[]>();
  for (const id of order) {
    const parent = parents.get(id) ?? null;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const rows: OutlineRow[] = [];
  // Iterative traversal also handles long imported chains without recursive stack overflow.
  const stack = [...(children.get(null) ?? [])].reverse().map((id) => ({ id, ancestors: [] as string[] }));
  while (stack.length) {
    const { id, ancestors } = stack.pop()!;
    const rowChildren = children.get(id) ?? [];
    rows.push({ thought: present.get(id)!, parentId: parents.get(id) ?? null, depth: ancestors.length, ancestors, children: rowChildren });
    for (const child of [...rowChildren].reverse()) stack.push({ id: child, ancestors: [...ancestors, id] });
  }
  return { rows, byId: new Map(rows.map((row) => [row.thought.id, row])) };
}

export function visibleRows(outline: Outline, collapsed: readonly string[]): OutlineRow[] {
  const hidden = new Set(collapsed);
  return outline.rows.filter((row) => !row.ancestors.some((id) => hidden.has(id)));
}

/** Existing authorized graph neighbors only, with descendants removed to avoid local cycles. */
export function groupingChoices(id: string, outline: Outline, links: readonly ThoughtLink[]): OutlineRow[] {
  const neighbors = new Set(links.flatMap((link) => link.fromId === id ? [link.toId] : link.toId === id ? [link.fromId] : []));
  return outline.rows.filter((row) => neighbors.has(row.thought.id) && !row.ancestors.includes(id));
}
