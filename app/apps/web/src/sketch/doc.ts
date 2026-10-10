import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_THOUGHT_SIZE, type SketchDetail, type Thought, type ThoughtFile, type ThoughtLink, type ThoughtShape } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import * as api from '../api/sketches';
import { useStreamEvents } from '../api/stream';

/**
 * One sketch as the person edits it (issue #69). Changes apply locally at once and are sent in
 * order, each with its own Idempotency-Key and the latest version the client knows (If-Match).
 * Undo is a stack of inverse operations sent the same way, so it never rewrites history on
 * the server. Stream events for this sketch trigger a refetch once no change is in flight.
 *
 * Conflicts: a move, resize, shape change or removal made against a stale version is retried
 * once on the current version (the person's intent for that field wins, other fields stay as
 * the server has them). A stale text edit is not forced: the latest text is shown instead.
 */

export interface NewThought {
  id: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: ThoughtShape;
  placement?: { type: 'draft'; id: string; title: string | null } | null;
  /** The message it came from (#96); only a message of the sketch's own DM is restored on the server. */
  source?: Thought['source'];
  /** Its image (#252): a staged file on first save, or the same published file when Undo restores the thought. */
  file?: ThoughtFile;
}

export type Op =
  | { kind: 'add'; thought: NewThought; link?: { id: string; fromId: string; label: string | null } }
  | { kind: 'update'; id: string; changes: Partial<Pick<Thought, 'text' | 'width' | 'height' | 'shape'>> }
  | { kind: 'move'; moves: { id: string; x: number; y: number }[] }
  | { kind: 'remove'; id: string }
  | { kind: 'link'; link: { id: string; fromId: string; toId: string; label: string | null } }
  | { kind: 'unlink'; id: string }
  | { kind: 'rename'; title: string };

export type LoadState = 'loading' | 'ready' | 'not-found' | 'failed';
export interface Me { id: string; name: string }

const uuid = () => crypto.randomUUID();

function localThought(me: Me, sketchId: string, input: NewThought): Thought {
  const now = new Date().toISOString();
  return {
    id: input.id, sketchId, text: input.text, x: input.x, y: input.y, width: input.width ?? DEFAULT_THOUGHT_SIZE.width,
    height: input.height ?? DEFAULT_THOUGHT_SIZE.height, shape: input.shape ?? 'card', placement: input.placement ?? null,
    source: input.source ?? null, ...(input.file ? { file: input.file } : {}),
    createdBy: { kind: 'human', id: me.id, name: me.name }, version: 0, createdAt: now, updatedAt: now,
  };
}

/** The sketch after `op`, as the person expects to see it before the server answers. */
export function applyLocal(sketch: SketchDetail, op: Op, me: Me): SketchDetail {
  switch (op.kind) {
    case 'add': {
      const thoughts = [...sketch.thoughts, localThought(me, sketch.id, op.thought)];
      const links = op.link ? [...sketch.links, { id: op.link.id, sketchId: sketch.id, fromId: op.link.fromId, toId: op.thought.id, label: op.link.label, createdAt: new Date().toISOString() }] : sketch.links;
      return { ...sketch, thoughts, links };
    }
    case 'update':
      return { ...sketch, thoughts: sketch.thoughts.map((t) => (t.id === op.id ? { ...t, ...op.changes } : t)) };
    case 'move': {
      const to = new Map(op.moves.map((m) => [m.id, m]));
      return { ...sketch, thoughts: sketch.thoughts.map((t) => (to.has(t.id) ? { ...t, x: to.get(t.id)!.x, y: to.get(t.id)!.y } : t)) };
    }
    case 'remove':
      return { ...sketch, thoughts: sketch.thoughts.filter((t) => t.id !== op.id), links: sketch.links.filter((l) => l.fromId !== op.id && l.toId !== op.id) };
    case 'link':
      return { ...sketch, links: [...sketch.links, { ...op.link, sketchId: sketch.id, createdAt: new Date().toISOString() }] };
    case 'unlink':
      return { ...sketch, links: sketch.links.filter((l) => l.id !== op.id) };
    case 'rename':
      return { ...sketch, title: op.title };
  }
}

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
      const restore: Op = { kind: 'add', thought: { id: t.id, text: t.text, x: t.x, y: t.y, width: t.width, height: t.height, shape: t.shape, placement: t.placement, source: t.source, ...(t.file ? { file: t.file } : {}) } };
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
  // Counts writes that have finished (#271). A read that was out while one finished may have been
  // answered before that write committed, so it is never adopted over the confirmed change.
  const finishedWrites = useRef(0);
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
    const merge = (t: Thought): Thought => (replace ? thought : { ...t, version: thought.version, createdBy: thought.createdBy, createdAt: thought.createdAt, updatedAt: thought.updatedAt, placement: thought.placement, source: thought.source, ...(thought.file ? { file: thought.file } : {}) });
    commit({ ...current, thoughts: current.thoughts.map((t) => (t.id === thought.id ? merge(t) : t)) });
  }, [commit]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      let fresh: SketchDetail;
      let finished: number;
      do {
        finished = finishedWrites.current;
        fresh = await api.getSketch(sketchId, signal);
        // A write still out: read again once every write has finished (see enqueue).
        if (inFlight.current) { staleRef.current = true; return; }
        // #271: a write finished while this read was out, whether it began before or after the
        // read was sent. The answer may predate it and would hide a confirmed thought until the
        // next event, so read again.
      } while (finishedWrites.current !== finished);
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
          sourceMessageId: op.thought.source?.dmMessageId ?? undefined, fileId: op.thought.file?.id,
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
      finishedWrites.current += 1;
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
  const perform = useCallback((ops: Op[], label: string, options: { coalesce?: boolean; undoable?: boolean } = {}) => {
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

  /**
   * Explicit draft save: no optimistic shared thought or undo step before confirmation. Several thoughts (a pasted
   * list, #252) are sent in order and stop at the first failure; only the confirmed ones join the document, as one
   * undo step. Returns the confirmed thought IDs; the caller keeps the rest of its draft with their IDs and keys.
   */
  const saveThoughts = useCallback(async (items: { thought: NewThought; parent: { id: string; linkId: string } | null; key: string }[], options?: {
    /** Phone confirmation of an earlier connected attempt may read/edit an existing thought, never create its link. */
    existingOnly?: ReadonlySet<string>;
    expectedText?: ReadonlyMap<string, string>;
    onAttempt?(item: { thought: NewThought; parent: { id: string; linkId: string } | null; key: string }): void;
  }): Promise<string[]> => {
    flushMoves();
    inFlight.current += 1;
    setSaving(true);
    setProblem(null);
    const saved: string[] = [];
    let unconfirmed = false;
    let changedEarlier = false;
    const operation = queue.current.then(async () => {
      for (const { thought, parent, key } of items) {
        let created: { thought: Thought; link: ThoughtLink | null };
        const recoverExisting = async (failure: unknown) => {
          const current = await api.getSketch(sketchId);
          const existing = current.thoughts.find((item) => item.id === thought.id);
          if (!existing) { if (options?.existingOnly?.has(thought.id)) unconfirmed = true; throw failure; }
          const expected = options?.expectedText?.get(thought.id);
          const untouchedOwnCreation = expected === undefined && existing.version === 1 && existing.createdBy.id === meRef.current;
          if (existing.text !== thought.text && existing.text !== expected && !untouchedOwnCreation) {
            changedEarlier = true;
            patchThought(existing, true);
            throw new Error('Earlier saved thought was changed');
          }
          const text = existing.text === thought.text ? existing
            : await withRetry(() => api.updateThought(sketchId, existing.id, { text: thought.text }, existing.version, `${key}-text`));
          return { thought: text, link: parent ? current.links.find((item) => item.id === parent.linkId) ?? null : null };
        };
        if (options?.existingOnly?.has(thought.id)) {
          created = await recoverExisting(new Error('Earlier connected save is not confirmed'));
        } else {
        options?.onAttempt?.({ thought, parent, key });
        try {
          created = await withRetry(() => api.addThought(sketchId, {
            id: thought.id, text: thought.text, x: thought.x, y: thought.y, width: thought.width, height: thought.height,
            ...(thought.file ? { fileId: thought.file.id } : {}),
            ...(parent ? { linkFrom: { thoughtId: parent.id, linkId: parent.linkId } } : {}),
          }, key));
        } catch (error) {
          // The draft's stable ID already exists: an earlier save of this draft committed although every response was
          // lost, and its text may predate edits made since. Finish that save instead of failing forever: the newer
          // text becomes an ordinary edit at the version just read, so another author's change still conflicts.
          if (!(error instanceof ApiError && error.status === 409 && error.code === 'THOUGHT_EXISTS')) throw error;
          created = await recoverExisting(error);
        }
        }
        const current = ref.current;
        if (!current) break;
        const latest = current.thoughts.find((item) => item.id === created.thought.id);
        const confirmed = latest && latest.version > created.thought.version ? latest : created.thought;
        versions.current.set(confirmed.id, confirmed.version);
        commit({ ...current,
          thoughts: [...current.thoughts.filter((item) => item.id !== created.thought.id), confirmed],
          links: created.link ? [...current.links.filter((item) => item.id !== created.link!.id), created.link] : current.links,
        });
        saved.push(created.thought.id);
      }
    }).catch(() => {
      const rest = items.length - saved.length;
      setProblem(changedEarlier ? 'Someone changed the earlier saved thought. Your text is kept; cancel to inspect their version before editing again.' : unconfirmed ? 'The earlier draft’s save is not confirmed yet. Your text is kept; check or retry that save on a computer.' : items.length === 1
        ? 'The thought could not be saved. Your draft is kept; check access and its parent, then try again.'
        : saved.length
          ? `Saved ${saved.length} of ${items.length} thoughts. The other ${rest} are kept in your draft; check access and their parent, then try again.`
          : 'The pasted thoughts could not be saved. Your draft is kept; check access and their parent, then try again.');
      staleRef.current = true;
    }).finally(() => {
      if (saved.length) {
        const label = saved.length === 1 ? 'added a thought' : `added ${saved.length} thoughts`;
        undoStack.current.push({ label, ops: [...saved].reverse().map((id): Op => ({ kind: 'remove', id })), at: Date.now() });
        if (undoStack.current.length > 50) undoStack.current.shift();
        setUndoLabel(label);
      }
      inFlight.current -= 1;
      finishedWrites.current += 1;
      if (inFlight.current) return;
      setSaving(false);
      if (staleRef.current) { staleRef.current = false; void reload(); }
    });
    queue.current = operation;
    await operation;
    return saved;
  }, [commit, flushMoves, patchThought, reload, sketchId]);

  const saveThought = useCallback(async (thought: NewThought, parent: { id: string; linkId: string } | null, key: string): Promise<boolean> =>
    (await saveThoughts([{ thought, parent, key }])).length === 1, [saveThoughts]);

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
      finishedWrites.current += 1;
      if (inFlight.current) return;
      setSaving(false);
      if (staleRef.current) { staleRef.current = false; void reload(); }
    });
    queue.current = operation.then(() => undefined);
    return operation;
  }, [flushMoves, patchThought, reload, sketchId]);

  useEffect(() => () => flushMoves(), [flushMoves]);

  return { sketch, load, saving, problem, clearProblem: () => setProblem(null), canUndo: undoLabel !== null, perform, saveThought, saveThoughts, saveText, undo, reload, newId: uuid };
}

export type SketchDoc = ReturnType<typeof useSketchDoc>;
export type { ThoughtLink };
