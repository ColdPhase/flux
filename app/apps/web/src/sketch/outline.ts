import type { Thought, ThoughtLink } from '@flux/contracts';

/**
 * A personal reading preference (#134): the order of siblings and the folded branches. The tree itself
 * comes from the map's connections (#510); `parents` is kept only so older saved preferences still read.
 */
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
  /** The connection to the parent: its label is the row's tag (#510 AC-2). */
  link: ThoughtLink | null;
  /** Other thoughts this one is connected under ("also under …", #510 AC-2), in reading order. */
  also: { id: string; link: ThoughtLink }[];
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
  const available = Math.max(0, OUTLINE_LIMIT - state.order.length);
  if ((!added.length || !available) && state.order.length <= OUTLINE_LIMIT) return state;
  const order = [...state.order, ...added.slice(0, available)].slice(-OUTLINE_LIMIT);
  const remembered = new Set(order);
  return { version: 1, order, parents: Object.fromEntries(Object.entries(state.parents).filter(([id]) => remembered.has(id))), collapsed: state.collapsed.filter((id) => remembered.has(id)) };
}

/**
 * The map as a tree (#510 AC-1). Connections record which thought they were drawn from. A thought sits
 * under the oldest thought (in reading order) with a connection drawn to it; its other such connections
 * read "also under …". A connection that would close a loop is a relation too, and thoughts nothing was
 * drawn to are roots. The tree depends only on the current graph and the reading order, so an undo that
 * restores the graph restores the tree. Siblings follow the personal reading order (creation by default).
 * Every current thought occurs exactly once; every connection is either a branch or an "also under".
 */
export function buildOutline(thoughts: readonly Thought[], links: readonly ThoughtLink[], state: OutlineState): Outline {
  const present = new Map(thoughts.map((thought) => [thought.id, thought]));
  const remembered = new Set(state.order);
  const order = [...state.order.filter((id) => present.has(id)), ...[...present.values()].filter((thought) => !remembered.has(thought.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((thought) => thought.id)];
  const rank = new Map(order.map((id, index) => [id, index]));
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;
  const incoming = new Map<string, ThoughtLink[]>();
  for (const link of links) {
    if (link.fromId === link.toId || !present.has(link.fromId) || !present.has(link.toId)) continue;
    const list = incoming.get(link.toId) ?? [];
    list.push(link);
    incoming.set(link.toId, list);
  }
  const parents = new Map<string, ThoughtLink>();
  const above = (id: string, target: string) => {
    for (let next: string | undefined = id; next; next = parents.get(next)?.fromId) if (next === target) return true;
    return false;
  };
  for (const id of order) {
    const candidates = (incoming.get(id) ?? []).sort((a, b) => byRank(a.fromId, b.fromId));
    const link = candidates.find((candidate) => !above(candidate.fromId, id));
    if (link) parents.set(id, link);
  }
  const children = new Map<string | null, string[]>();
  for (const id of order) {
    const parent = parents.get(id)?.fromId ?? null;
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
    const link = parents.get(id) ?? null;
    rows.push({ thought: present.get(id)!, parentId: link?.fromId ?? null, depth: ancestors.length, ancestors, children: rowChildren, link,
      also: (incoming.get(id) ?? []).filter((item) => item !== link).map((item) => ({ id: item.fromId, link: item })) });
    for (const child of [...rowChildren].reverse()) stack.push({ id: child, ancestors: [...ancestors, id] });
  }
  return { rows, byId: new Map(rows.map((row) => [row.thought.id, row])) };
}

export type ReparentStep = { kind: 'link'; link: { id: string; fromId: string; toId: string; label: string | null } } | { kind: 'unlink'; id: string };
/** Either the connection changes to apply, in order, or the thought that would not stay where the person put it, and under which thought it would read instead. */
export type ReparentPlan = { ok: true; steps: ReparentStep[] } | { ok: false; thoughtId: string; under: string | null };

/**
 * Tab / Shift+Tab (#510 AC-6): puts `id` under `parentId` (null: the top level) by moving the connection to its parent.
 * A thought with several parents reads under the oldest one, so before anything is sent the connections are projected
 * and the tree rebuilt: if the thought (or another one) would land anywhere but where it was meant to, nothing changes.
 * The new connection comes before the old one is removed, so a failure part-way leaves a second parent, never an orphan;
 * only an existing connection between the same two thoughts goes first, because a pair holds one connection.
 */
export function planReparent(thoughts: readonly Thought[], links: readonly ThoughtLink[], state: OutlineState, id: string, parentId: string | null, newLinkId: string): ReparentPlan {
  const before = buildOutline(thoughts, links, state);
  const row = before.byId.get(id);
  if (!row) return { ok: true, steps: [] };
  const existing = parentId ? links.find((item) => (item.fromId === parentId && item.toId === id) || (item.fromId === id && item.toId === parentId)) : undefined;
  const label = existing?.label ?? row.link?.label ?? null;
  const reuse = !!existing && existing.fromId === parentId && existing.label === label;
  const steps: ReparentStep[] = [];
  if (parentId && !reuse) {
    if (existing) steps.push({ kind: 'unlink', id: existing.id });
    steps.push({ kind: 'link', link: { id: newLinkId, fromId: parentId, toId: id, label } });
  }
  if (row.link && row.link.id !== existing?.id) steps.push({ kind: 'unlink', id: row.link.id });
  const removed = new Set(steps.flatMap((step) => step.kind === 'unlink' ? [step.id] : []));
  const added = steps.flatMap((step): ThoughtLink[] => step.kind === 'link' ? [{ ...step.link, sketchId: row.thought.sketchId, createdAt: row.thought.createdAt }] : []);
  const after = buildOutline(thoughts, [...links.filter((item) => !removed.has(item.id)), ...added], state);
  const landed = after.byId.get(id);
  if (landed && landed.parentId !== parentId) return { ok: false, thoughtId: id, under: landed.parentId };
  for (const other of before.rows) {
    const next = after.byId.get(other.thought.id);
    if (other.thought.id !== id && next && next.parentId !== other.parentId) return { ok: false, thoughtId: other.thought.id, under: next.parentId };
  }
  return { ok: true, steps };
}

/** The sibling before or after a row in the tree, for indenting and moving (#510 AC-6). */
export function sibling(outline: Outline, id: string, step: -1 | 1): string | null {
  const row = outline.byId.get(id);
  if (!row) return null;
  const siblings = row.parentId ? outline.byId.get(row.parentId)?.children ?? [] : outline.rows.filter((item) => item.depth === 0).map((item) => item.thought.id);
  return siblings[siblings.indexOf(id) + step] ?? null;
}

/** Swaps two remembered thoughts in the personal reading order; anything not remembered stays put. */
export function swapOrder(state: OutlineState, a: string, b: string): OutlineState {
  const i = state.order.indexOf(a);
  const j = state.order.indexOf(b);
  if (i < 0 || j < 0) return state;
  const order = [...state.order];
  [order[i], order[j]] = [order[j]!, order[i]!];
  return { ...state, order };
}

export function visibleRows(outline: Outline, collapsed: readonly string[]): OutlineRow[] {
  const hidden = new Set(collapsed);
  return outline.rows.filter((row) => !row.ancestors.some((id) => hidden.has(id)));
}
