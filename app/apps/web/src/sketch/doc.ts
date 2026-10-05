import { useCallback, useEffect, useRef, useState } from 'react';
import type { SketchDetail, Thought, ThoughtLink } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import * as api from '../api/sketches';
import { useStreamEvents } from '../api/stream';
import type { SharedMap } from '../editing/map';
import { applyLocal, type Me, type NewThought, type Op } from './projection.js';

export { applyLocal, applyLivePreviews, type Me, type NewThought, type Op } from './projection.js';

/**
 * One sketch as the person edits it (issue #69). Changes apply locally at once and are sent in
 * order, each with its own Idempotency-Key and the latest version the client knows (If-Match).
 * Undo is a stack of inverse operations sent the same way, so it never rewrites history on
 * the server. Stream events for this sketch trigger a refetch once no change is in flight.
 *
 * Conflicts: a move, resize, shape change or removal made against a stale version is retried
 * once on the current version (the person's intent for that field wins, other fields stay as
 * the server has them). A stale text edit is not forced: the latest text is shown instead.
 *
 * This is the ordinary map, unchanged from before live editing (#228). It is used whenever the
 * live capability is not `configured` (#239 review); `useLiveSketchDoc` (live-doc.ts) is the live one.
 */

export type LoadState = 'loading' | 'ready' | 'not-found' | 'failed';

const uuid = () => crypto.randomUUID();

/** Operations that undo `op` when applied to the sketch after it. */
export function inverse(before: SketchDetail, op: Op): Op[] {
  switch (op.kind) {
    case 'add':
      return [{ kind: 'remove', id: op.thought.id }];
    case 'update': {
      const t = before.thoughts.find((x) => x.id === op.id);
      if (!t) return [];
      const back = Object.fromEntries(Object.keys(op.changes).map((k) => [k, t[k as keyof typeof op.changes]]));
      return [{ kind: 'update', id: op.id, changes: back }];
    }
    case 'move':
      return [{ kind: 'move', moves: op.moves.flatMap((m) => { const t = before.thoughts.find((x) => x.id === m.id); return t ? [{ id: t.id, x: t.x, y: t.y }] : []; }) }];
    case 'remove': {
      const t = before.thoughts.find((x) => x.id === op.id);
      if (!t) return [];
      const restore: Op = { kind: 'add', thought: { id: t.id, text: t.text, x: t.x, y: t.y, width: t.width, height: t.height, shape: t.shape, placement: t.placement, source: t.source } };
      const links = before.links.filter((l) => l.fromId === t.id || l.toId === t.id).map((l): Op => ({ kind: 'link', link: { id: l.id, fromId: l.fromId, toId: l.toId, label: l.label } }));
      return [restore, ...links];
    }
    case 'link':
      return [{ kind: 'unlink', id: op.link.id }];
    case 'unlink': {
      const l = before.links.find((x) => x.id === op.id);
      return l ? [{ kind: 'link', link: { id: l.id, fromId: l.fromId, toId: l.toId, label: l.label } }] : [];
    }
    case 'rename':
      return [{ kind: 'rename', title: before.title }];
  }
}

interface Entry { label: string; ops: Op[]; at: number }

function conflictVersion(error: unknown, id: string): number | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'VERSION_CONFLICT') return null;
  const body = error.body as { currentVersion?: number; conflicts?: { id: string; currentVersion: number }[] } | null;
  if (typeof body?.currentVersion === 'number') return body.currentVersion;
  return body?.conflicts?.find((c) => c.id === id)?.currentVersion ?? null;
}

async function withRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof NetworkError) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
}

export function useSketchDoc(sketchId: string, me: Me) {
  const [sketch, setSketch] = useState<SketchDetail | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const ref = useRef<SketchDetail | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  const staleRef = useRef(false);
  const undoStack = useRef<Entry[]>([]);
  const moveBuffer = useRef<{ moves: Map<string, { x: number; y: number }>; timer: number | null }>({ moves: new Map(), timer: null });
  const meRef = useRef(me);
  useEffect(() => { meRef.current = me; });

  // The versions the server last confirmed, by thought id (and the sketch's own under its id).
  // Local state may already be ahead of them; If-Match always sends these.
  const versions = useRef(new Map<string, number>());
  const commit = useCallback((next: SketchDetail) => { ref.current = next; setSketch(next); }, []);
  const adopt = useCallback((fresh: SketchDetail) => {
    versions.current = new Map([[fresh.id, fresh.version], ...fresh.thoughts.map((t): [string, number] => [t.id, t.version])]);
    commit(fresh);
  }, [commit]);
  /** Learns the server's version of a thought; with `replace`, shows the server's thought as is. */
  const patchThought = useCallback((thought: Thought, replace = false) => {
    versions.current.set(thought.id, thought.version);
    const current = ref.current;
    if (!current) return;
    // The local thought may be ahead (a later change is queued); keep its intent, take the server's facts.
    const merge = (t: Thought): Thought => (replace ? thought : { ...t, version: thought.version, createdBy: thought.createdBy, createdAt: thought.createdAt, updatedAt: thought.updatedAt, placement: thought.placement, source: thought.source });
    commit({ ...current, thoughts: current.thoughts.map((t) => (t.id === thought.id ? merge(t) : t)) });
  }, [commit]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const fresh = await api.getSketch(sketchId, signal);
      if (inFlight.current) { staleRef.current = true; return; }
      adopt(fresh);
      setLoad('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ApiError && error.status === 404) { setLoad('not-found'); return; }
      if (!ref.current) setLoad('failed');
    }
  }, [sketchId, adopt]);

  useEffect(() => {
    // One hook instance serves one sketch: the route remounts the view for another id.
    const controller = new AbortController();
    api.getSketch(sketchId, controller.signal).then((fresh) => { adopt(fresh); setLoad('ready'); }, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoad(error instanceof ApiError && error.status === 404 ? 'not-found' : 'failed');
    });
    return () => controller.abort();
  }, [sketchId, adopt]);

  // Another person's change (or this person's in another tab): refetch once nothing is in flight.
  const refetchTimer = useRef<number | null>(null);
  const scheduleRefetch = () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => { refetchTimer.current = null; void reload(); }, 120);
  };
  useStreamEvents(me.id, (event) => {
    if (event.objectType === 'sketch' && event.objectId === sketchId) scheduleRefetch();
  }, scheduleRefetch);

  /** Sends one operation with the latest known versions; returns when the server answered. */
  const send = useCallback(async (op: Op) => {
    const k = uuid();
    const current = () => ref.current!;
    const version = (id: string) => versions.current.get(id) ?? 0;
    const retryOnConflict = async <T,>(id: string, run: (version: number) => Promise<T>) => {
      try {
        return await withRetry(() => run(version(id)));
      } catch (error) {
        const latest = conflictVersion(error, id);
        if (latest === null) throw error;
        return withRetry(() => run(latest));
      }
    };
    switch (op.kind) {
      case 'add': {
        const created = await withRetry(() => api.addThought(sketchId, {
          id: op.thought.id, text: op.thought.text, x: op.thought.x, y: op.thought.y, width: op.thought.width, height: op.thought.height,
          shape: op.thought.shape, placement: op.thought.placement ? { type: op.thought.placement.type, id: op.thought.placement.id } : undefined,
          linkFrom: op.link ? { thoughtId: op.link.fromId, label: op.link.label, linkId: op.link.id } : undefined,
          sourceMessageId: op.thought.source?.dmMessageId ?? undefined,
        }, k));
        patchThought(created.thought);
        return;
      }
      case 'update': {
        if (op.changes.text !== undefined) {
          try {
            patchThought(await withRetry(() => api.updateThought(sketchId, op.id, op.changes, version(op.id), k)));
          } catch (error) {
            const body = error instanceof ApiError && error.status === 409 ? (error.body as { current?: Thought } | null) : null;
            if (!body?.current) throw error;
            patchThought(body.current, true);
            setProblem(`Someone else changed “${body.current.text}” just before you. Their version is shown.`);
          }
          return;
        }
        patchThought(await retryOnConflict(op.id, (v) => api.updateThought(sketchId, op.id, op.changes, v, k)));
        return;
      }
      case 'move': {
        const moves = () => op.moves.map((m) => ({ ...m, expectedVersion: version(m.id) })).filter((m) => m.expectedVersion > 0);
        let result;
        try {
          result = await withRetry(() => api.moveThoughts(sketchId, { moves: moves() }, k));
        } catch (error) {
          const body = error instanceof ApiError && error.status === 409 ? (error.body as { conflicts?: { id: string; currentVersion: number }[] } | null) : null;
          if (!body?.conflicts) throw error;
          // Moves are intent: put them where the person dropped them, on top of the latest versions.
          const latest = new Map(body.conflicts.map((c) => [c.id, c.currentVersion]));
          result = await withRetry(() => api.moveThoughts(sketchId, { moves: moves().map((m) => ({ ...m, expectedVersion: latest.get(m.id) ?? m.expectedVersion })) }, uuid()));
        }
        for (const thought of result.thoughts) patchThought(thought);
        return;
      }
      case 'remove':
        try {
          await retryOnConflict(op.id, (v) => api.removeThought(sketchId, op.id, v, k));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        versions.current.delete(op.id);
        return;
      case 'link':
        await withRetry(() => api.addLink(sketchId, op.link, k));
        return;
      case 'unlink':
        try {
          await withRetry(() => api.removeLink(sketchId, op.id, k));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        return;
      case 'rename': {
        const run = (v: number) => api.renameSketch(sketchId, op.title, v, k);
        let renamed;
        try {
          renamed = await withRetry(() => run(version(sketchId)));
        } catch (error) {
          const latest = conflictVersion(error, sketchId);
          if (latest === null) throw error;
          renamed = await withRetry(() => run(latest));
        }
        versions.current.set(sketchId, renamed.version);
        commit({ ...current(), version: renamed.version });
      }
    }
  }, [sketchId, commit, patchThought]);

  const enqueue = useCallback((op: Op) => {
    inFlight.current += 1;
    setSaving(true);
    queue.current = queue.current.then(() => send(op)).catch(() => {
      setProblem('A change couldn’t be saved. The sketch was reloaded from the server.');
      staleRef.current = true;
    }).finally(() => {
      inFlight.current -= 1;
      if (inFlight.current) return;
      setSaving(false);
      if (staleRef.current) { staleRef.current = false; void reload(); }
    });
  }, [send, reload]);

  const flushMoves = useCallback(() => {
    const buffer = moveBuffer.current;
    if (buffer.timer !== null) { window.clearTimeout(buffer.timer); buffer.timer = null; }
    if (!buffer.moves.size) return;
    const moves = [...buffer.moves].map(([id, p]) => ({ id, ...p }));
    buffer.moves.clear();
    enqueue({ kind: 'move', moves });
  }, [enqueue]);

  /**
   * Applies operations as one undoable step. `coalesce` (keyboard nudges) merges repeated moves
   * into the previous step and sends the final positions once the keys rest.
   */
  const perform = useCallback((ops: Op[], label: string, options: { coalesce?: boolean; undoable?: boolean; lease?: Promise<unknown> } = {}) => {
    let current = ref.current;
    if (!current || !ops.length) return;
    const inverses: Op[][] = [];
    for (const op of ops) {
      inverses.unshift(inverse(current, op));
      current = applyLocal(current, op, meRef.current);
    }
    commit(current);
    setProblem(null);
    const top = undoStack.current[undoStack.current.length - 1];
    // A coalesced step keeps the earlier inverse, which knows where the thoughts started; a step
    // that is not undoable on its own (a new thought's first text) belongs to the step before it.
    const merge = (options.coalesce && top?.label === label && Date.now() - top.at < 1200) || options.undoable === false;
    if (merge && top) top.at = Date.now();
    if (!merge) {
      undoStack.current.push({ label, ops: inverses.flat(), at: Date.now() });
      if (undoStack.current.length > 50) undoStack.current.shift();
      setUndoLabel(label);
    }
    if (options.coalesce && ops.every((op) => op.kind === 'move')) {
      const buffer = moveBuffer.current;
      for (const op of ops) if (op.kind === 'move') for (const m of op.moves) buffer.moves.set(m.id, { x: m.x, y: m.y });
      if (buffer.timer !== null) window.clearTimeout(buffer.timer);
      buffer.timer = window.setTimeout(flushMoves, 450);
      return;
    }
    flushMoves();
    for (const op of ops) enqueue(op);
  }, [commit, enqueue, flushMoves]);

  const undo = useCallback((): string | null => {
    const entry = undoStack.current.pop();
    let current = ref.current;
    if (!entry || !current) return null;
    flushMoves();
    // Skip steps that no longer apply (e.g. someone else removed the thought meanwhile).
    const ops = entry.ops.filter((op) => op.kind !== 'move' || op.moves.every((m) => current!.thoughts.some((t) => t.id === m.id)));
    for (const op of ops) current = applyLocal(current, op, meRef.current);
    commit(current);
    for (const op of ops) enqueue(op);
    setUndoLabel(undoStack.current[undoStack.current.length - 1]?.label ?? null);
    return entry.label;
  }, [commit, enqueue, flushMoves]);

  /** Explicit draft save: no optimistic shared thought or undo step before confirmation. */
  const saveThought = useCallback(async (thought: NewThought, parent: { id: string; linkId: string } | null, key: string): Promise<boolean> => {
    flushMoves();
    inFlight.current += 1;
    setSaving(true);
    setProblem(null);
    const operation = queue.current.then(async () => {
      let created: { thought: Thought; link: ThoughtLink | null };
      try {
        created = await withRetry(() => api.addThought(sketchId, {
          id: thought.id, text: thought.text, x: thought.x, y: thought.y,
          ...(parent ? { linkFrom: { thoughtId: parent.id, linkId: parent.linkId } } : {}),
        }, key));
      } catch (error) {
        // The draft's stable ID already exists: an earlier save of this draft committed although every response was
        // lost, and its text may predate edits made since. Finish that save instead of failing forever: the newer
        // text becomes an ordinary edit at the version just read, so another author's change still conflicts.
        if (!(error instanceof ApiError && error.status === 409 && error.code === 'THOUGHT_EXISTS')) throw error;
        const saved = await api.getSketch(sketchId);
        const existing = saved.thoughts.find((item) => item.id === thought.id);
        if (!existing) throw error;
        const text = existing.text === thought.text ? existing
          : await withRetry(() => api.updateThought(sketchId, existing.id, { text: thought.text }, existing.version, `${key}-text`));
        created = { thought: text, link: parent ? saved.links.find((item) => item.id === parent.linkId) ?? null : null };
      }
      const current = ref.current;
      if (!current) return false;
      versions.current.set(created.thought.id, created.thought.version);
      commit({ ...current,
        thoughts: [...current.thoughts.filter((item) => item.id !== created.thought.id), created.thought],
        links: created.link ? [...current.links.filter((item) => item.id !== created.link!.id), created.link] : current.links,
      });
      undoStack.current.push({ label: 'added a thought', ops: [{ kind: 'remove', id: created.thought.id }], at: Date.now() });
      if (undoStack.current.length > 50) undoStack.current.shift();
      setUndoLabel('added a thought');
      return true;
    }).catch(() => {
      setProblem('The thought could not be saved. Your draft is kept; check access and its parent, then try again.');
      staleRef.current = true;
      return false;
    }).finally(() => {
      inFlight.current -= 1;
      if (inFlight.current) return;
      setSaving(false);
      if (staleRef.current) { staleRef.current = false; void reload(); }
    });
    queue.current = operation.then(() => undefined);
    return operation;
  }, [commit, flushMoves, reload, sketchId]);

  /**
   * Text belongs to the version opened by the editor, even if the stream learns a newer one.
   * A newer version that still has the opened text (a move, resize or shape change, such as this
   * person's own nudge just before editing) holds nothing this edit would overwrite: the edit is
   * sent once on that version, which then stays with its request key for an explicit retry.
   */
  const rebased = useRef(new Map<string, number>());
  const saveText = useCallback(async (id: string, text: string, opened: { text: string; version: number }, key: string): Promise<boolean> => {
    flushMoves();
    inFlight.current += 1;
    setSaving(true);
    setProblem(null);
    const operation = queue.current.then(async () => {
      const before = ref.current;
      const send = (version: number) => withRetry(() => api.updateThought(sketchId, id, { text }, version, key));
      let updated: Thought;
      try {
        updated = await send(rebased.current.get(key) ?? opened.version);
      } catch (error) {
        const current = error instanceof ApiError && error.status === 409 ? (error.body as { current?: Thought } | null)?.current : undefined;
        if (!current || current.text !== opened.text) throw error;
        rebased.current.set(key, current.version);
        updated = await send(current.version);
      }
      patchThought(updated, true);
      if (before) {
        undoStack.current.push({ label: 'edited a thought', ops: inverse(before, { kind: 'update', id, changes: { text } }), at: Date.now() });
        if (undoStack.current.length > 50) undoStack.current.shift();
        setUndoLabel('edited a thought');
      }
      return true;
    }).catch((error: unknown) => {
      const body = error instanceof ApiError && error.status === 409 ? (error.body as { current?: Thought } | null) : null;
      if (body?.current) {
        patchThought(body.current, true);
        setProblem('Someone else changed this thought. Your edit is kept; cancel to inspect their version before editing again.');
      } else {
        setProblem('The edit could not be saved. Your text is kept; check access, then try again.');
      }
      staleRef.current = true;
      return false;
    }).finally(() => {
      inFlight.current -= 1;
      if (inFlight.current) return;
      setSaving(false);
      if (staleRef.current) { staleRef.current = false; void reload(); }
    });
    queue.current = operation.then(() => undefined);
    return operation;
  }, [flushMoves, patchThought, reload, sketchId]);

  useEffect(() => () => flushMoves(), [flushMoves]);

  // The view's draft save names one add operation; the ordinary save takes its thought and parent.
  const saveDraft = useCallback((op: Extract<Op, { kind: 'add' }>, key: string) =>
    saveThought(op.thought, op.link ? { id: op.link.fromId, linkId: op.link.id } : null, key), [saveThought]);

  return { sketch, load, saving, problem, clearProblem: () => setProblem(null), canUndo: undoLabel !== null, perform, saveThought: saveDraft, saveText, undo, reload, newId: uuid, ...ORDINARY };
}

/** No live room, movement, presence or server undo: the ordinary map's inert live fields. */
const ORDINARY = {
  liveStatus: 'unavailable' as SharedMap['status'],
  liveCanWrite: true,
  ownGesture: null as SharedMap['ownGesture'],
  previews: new Map() as SharedMap['previews'],
  peers: new Map() as SharedMap['peers'],
  privateMovement: null as SharedMap['privateMovement'],
  discardPrivateMovement: (): void => {},
  beginGesture: (): boolean => true,
  previewGesture: (): void => {},
  cancelGesture: (): void => {},
  finishGesture: (): Promise<{ leaseId: string; versions: Map<string, number> }> | undefined => undefined,
  presence: (): void => {},
};

export type SketchDoc = ReturnType<typeof useSketchDoc>;
export type { ThoughtLink };
