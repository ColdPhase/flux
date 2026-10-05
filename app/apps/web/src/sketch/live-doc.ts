import { useCallback, useEffect, useRef, useState } from 'react';
import { liveMapUndoPath, type LiveMapDelta, type LiveMapPosition, type SketchDetail, type Thought, type UndoLiveMap, type UndoneLiveMap } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';
import { SharedMap } from '../editing/map';
import * as api from '../api/sketches';
import { useStreamEvents } from '../api/stream';
import { applyLocal, applyLivePreviews, type Me, type Op } from './projection.js';
import { inverse, type LoadState } from './doc';

/**
 * Native confirmed state is independent of per-object pending intent and transient
 * authorized movement. Live commits arrive in room order. Native HTTP receipts may settle
 * an intent, but their historical response bodies never patch the live graph. Own undo
 * names this editor's original commands for server-side atomic inverse/CAS verification.
 */

const uuid = () => crypto.randomUUID();

interface Entry { label: string; ops: Op[]; commands: string[]; at: number; undoAttempt?: UndoLiveMap }

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

type Lease = { leaseId: string; versions: Map<string, number> };
interface Intent { id: string; scope: number; op: Op; epochs: Map<string, number>; entry?: Entry; lease?: Promise<Lease> }
function touched(op: Op, sketch: SketchDetail): string[] {
  switch (op.kind) {
    case 'move': return op.moves.map((move) => move.id);
    case 'update': case 'remove': return [op.id];
    case 'add': return [op.thought.id, ...(op.link ? [op.link.fromId] : [])];
    case 'link': return [op.link.fromId, op.link.toId];
    case 'unlink': { const link = sketch.links.find((item) => item.id === op.id); return link ? [link.fromId, link.toId] : []; }
    case 'rename': return [sketch.id];
  }
}

/** Ordered confirmed native deltas, per-command local overlays, and transient authorized previews. */
export function useLiveSketchDoc(sketchId: string, me: Me) {
  const [sketch, setSketch] = useState<SketchDetail | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<{ status: SharedMap['status']; canWrite: boolean; problem: string | null; ownGesture: SharedMap['ownGesture']; previews: SharedMap['previews']; peers: SharedMap['peers']; privateMovement: SharedMap['privateMovement'] }>({ status: 'connecting', canWrite: false, problem: null, ownGesture: null, previews: new Map(), peers: new Map(), privateMovement: null });
  const confirmed = useRef<SketchDetail | null>(null);
  const ref = useRef<SketchDetail | null>(null);
  const pending = useRef(new Map<string, Intent>());
  const epochs = useRef(new Map<string, number>());
  const undoStack = useRef<Entry[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  const meRef = useRef(me);
  const live = useRef<SharedMap | null>(null);
  const ownCommands = useRef(new Set<string>());
  const receipts = useRef(new Map<string, LiveMapDelta>());
  const tombstones = useRef(new Map<string, number>());
  const scope = useRef({ active: false, number: 0 });
  const snapshots = useRef(0);
  useEffect(() => { meRef.current = me; });
  const publish = useCallback(() => {
    const client = live.current;
    if (client) setLiveState({ status: client.status, canWrite: client.status === 'unavailable' || client.status === 'live' && !!client.head?.canWrite, problem: client.problem, ownGesture: client.ownGesture, previews: new Map(client.previews), peers: new Map(client.peers), privateMovement: client.privateMovement });
    let next = confirmed.current;
    if (!next) { if (live.current?.status === 'private') setLoad('not-found'); else if (live.current?.problem) setLoad('failed'); return; }
    const previews = new Map<string, LiveMapPosition>();
    for (const preview of live.current?.previews.values() ?? []) for (const position of preview.positions) previews.set(position.id, position);
    next = applyLivePreviews(next, previews);
    for (const intent of pending.current.values()) next = applyLocal(next, intent.op, meRef.current);
    ref.current = next; setSketch(next);
  }, []);
  const adopt = useCallback((fresh: SketchDetail) => {
    const before = confirmed.current;
    if (before) for (const thought of before.thoughts) {
      if (fresh.thoughts.find((item) => item.id === thought.id)?.version !== thought.version) epochs.current.set(thought.id, (epochs.current.get(thought.id) ?? 0) + 1);
    }
    snapshots.current++; confirmed.current = fresh; setLoad('ready'); publish();
  }, [publish]);
  const patch = useCallback((thoughts: Thought[], extra: Partial<SketchDetail> = {}) => {
    const current = confirmed.current; if (!current) return;
    const merged = new Map(current.thoughts.map((thought) => [thought.id, thought]));
    for (const thought of thoughts) if ((merged.get(thought.id)?.version ?? -1) <= thought.version) merged.set(thought.id, thought);
    confirmed.current = { ...current, ...extra, thoughts: [...merged.values()] }; publish();
  }, [publish]);
  const delta = useCallback((change: LiveMapDelta) => {
    const current = confirmed.current; if (!current) return;
    const own = ownCommands.current.has(change.commandId);
    if (own) {
      receipts.current.set(change.commandId, change);
      if (receipts.current.size > 1024) receipts.current.delete(receipts.current.keys().next().value!);
      const entry = pending.current.get(change.commandId)?.entry;
      if (entry && !entry.commands.includes(change.commandId)) entry.commands.push(change.commandId);
    }
    if (!own) {
      const changed = new Set([...change.thoughts.map((thought) => thought.id), ...change.removedThoughts.map((thought) => thought.id), ...(change.sketch ? [current.id] : [])]);
      for (const link of [...change.links, ...current.links.filter((link) => change.removedLinks.includes(link.id))]) { changed.add(link.fromId); changed.add(link.toId); }
      for (const id of changed) epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1);
    }
    for (const thought of change.removedThoughts) tombstones.current.set(thought.id, Math.max(tombstones.current.get(thought.id) ?? 0, thought.version));
    while (tombstones.current.size > 4096) tombstones.current.delete(tombstones.current.keys().next().value!);
    const removed = new Map(change.removedThoughts.map((thought) => [thought.id, thought.version]));
    const thoughts = new Map(current.thoughts.filter((thought) => !removed.has(thought.id) || thought.version > removed.get(thought.id)!).map((thought) => [thought.id, thought]));
    for (const thought of change.thoughts) if ((tombstones.current.get(thought.id) ?? -1) < thought.version && (thoughts.get(thought.id)?.version ?? -1) <= thought.version) thoughts.set(thought.id, thought);
    const links = new Map(current.links.filter((link) => !change.removedLinks.includes(link.id) && thoughts.has(link.fromId) && thoughts.has(link.toId)).map((link) => [link.id, link]));
    for (const link of change.links) if (thoughts.has(link.fromId) && thoughts.has(link.toId)) links.set(link.id, link);
    confirmed.current = { ...current, ...(change.sketch && change.sketch.version >= current.version ? change.sketch : {}), thoughts: [...thoughts.values()], links: [...links.values()] };
    if (own) pending.current.delete(change.commandId);
    publish();
  }, [publish]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try { adopt(await api.getSketch(sketchId, signal)); }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; if (error instanceof ApiError && error.status === 404) setLoad('not-found'); else if (!confirmed.current) setLoad('failed'); }
  }, [sketchId, adopt]);
  useEffect(() => {
    scope.current = { active: true, number: scope.current.number + 1 };
    const controller = new AbortController();
    const client = new SharedMap(sketchId, me.id, adopt, delta, publish);
    live.current = client;
    // Capability-off preserves the ordinary native API; capability-on bootstrap is atomic.
    const fallback = window.setInterval(() => {
      if (client.status !== 'unavailable') return;
      window.clearInterval(fallback); void reload(controller.signal);
    }, 50);
    return () => {
      scope.current.active = false; scope.current.number++;
      try { if (pending.current.size) sessionStorage.setItem(`flux:map-pending:${me.id}:${sketchId}`, JSON.stringify([...pending.current.values()].map((intent) => ({ op: intent.op, commandId: intent.id, scope: sketchId })))); } catch { /* Original private drafts also retain their text. */ }
      controller.abort(); window.clearInterval(fallback); client.destroy(); live.current = null;
    };
  }, [sketchId, me.id, adopt, delta, publish, reload]);
  useStreamEvents(me.id, (event) => {
    if (live.current?.status === 'unavailable' && event.objectType === 'sketch' && event.objectId === sketchId) void reload();
  }, () => { if (live.current?.status === 'unavailable') void reload(); });

  const send = useCallback(async (intent: Intent) => {
    const valid = () => scope.current.active && scope.current.number === intent.scope;
    const check = () => { if (!valid()) throw new DOMException('The original account/map editor was closed', 'AbortError'); };
    const deliver = async <T,>(run: () => Promise<T>): Promise<T> => { const value = await withRetry(() => { check(); return run(); }); check(); return value; };
    check();
    const shared = live.current?.status !== 'unavailable';
    const current = confirmed.current; if (!current) throw new Error('The map has not loaded.');
    for (const [id, epoch] of intent.epochs) if ((epochs.current.get(id) ?? 0) !== epoch) throw new Error('Someone else changed this thought or its links. Your intent is kept privately; inspect their change first.');
    const lease = intent.lease ? await intent.lease : undefined;
    check();
    const version = (id: string) => lease?.versions.get(id) ?? current.thoughts.find((thought) => thought.id === id)?.version ?? (id === sketchId ? current.version : 0);
    const { op, id } = intent;
    switch (op.kind) {
      case 'add': {
        const created = await deliver(() => api.addThought(sketchId, {
          id: op.thought.id, text: op.thought.text, x: op.thought.x, y: op.thought.y, width: op.thought.width, height: op.thought.height, shape: op.thought.shape,
          placement: op.thought.placement ? { type: op.thought.placement.type, id: op.thought.placement.id } : undefined,
          sourceMessageId: op.thought.source?.dmMessageId ?? undefined,
          linkFrom: op.link ? { thoughtId: op.link.fromId, label: op.link.label, linkId: op.link.id } : undefined,
        }, id));
        if (!shared) patch([created.thought], created.link ? { links: [...confirmed.current!.links.filter((link) => link.id !== created.link!.id), created.link] } : {}); break;
      }
      case 'update': {
        const expected = version(op.id);
        const changed = await deliver(() => api.updateThought(sketchId, op.id, { ...op.changes, ...(lease ? { leaseId: lease.leaseId } : {}) }, expected, id));
        if (!shared) patch([changed]); break;
      }
      case 'move': {
        const command = { moves: op.moves.map((move) => ({ ...move, expectedVersion: version(move.id) })), ...(lease ? { leaseId: lease.leaseId } : {}) };
        const changed = await deliver(() => api.moveThoughts(sketchId, command, id));
        if (!shared) patch(changed.thoughts); break;
      }
      case 'remove': {
        const expected = version(op.id);
        await deliver(() => api.removeThought(sketchId, op.id, expected, id));
        const current = confirmed.current!;
        if (!shared) confirmed.current = { ...current, thoughts: current.thoughts.filter((thought) => thought.id !== op.id), links: current.links.filter((link) => link.fromId !== op.id && link.toId !== op.id) }; break;
      }
      case 'link': {
        const link = await deliver(() => api.addLink(sketchId, op.link, id));
        if (!shared) confirmed.current = { ...confirmed.current!, links: [...confirmed.current!.links.filter((item) => item.id !== link.id), link] }; break;
      }
      case 'unlink':
        await deliver(() => api.removeLink(sketchId, op.id, id));
        if (!shared) confirmed.current = { ...confirmed.current!, links: confirmed.current!.links.filter((link) => link.id !== op.id) }; break;
      case 'rename': {
        const expected = current.version;
        const renamed = await deliver(() => api.renameSketch(sketchId, op.title, expected, id));
        if (!shared && renamed.version >= confirmed.current!.version) confirmed.current = { ...confirmed.current!, ...renamed }; break;
      }
    }
    if (intent.entry && !intent.entry.commands.includes(id)) intent.entry.commands.push(id);
    if (shared && pending.current.has(id)) {
      const deadline = Date.now() + 1000;
      while (pending.current.has(id) && Date.now() < deadline) { check(); await new Promise((resolve) => window.setTimeout(resolve, 20)); }
      if (pending.current.has(id)) {
        // A successful native HTTP receipt proves commit but its old response is never
        // a graph patch. Missing ordered delivery is a gap: reconcile a fresh atomic
        // snapshot, which also includes any later peer edit/delete/restore.
        const before = snapshots.current; live.current?.resync();
        const until = Date.now() + 5000;
        while (snapshots.current === before && Date.now() < until) { check(); await new Promise((resolve) => window.setTimeout(resolve, 20)); }
        check();
        if (snapshots.current === before) throw new Error('The committed change is waiting for its confirmed map snapshot. Its original intent is kept privately.');
      }
    }
    check(); pending.current.delete(id); publish();
  }, [sketchId, patch, publish]);
  const enqueue = useCallback((intent: Intent): Promise<boolean> => {
    inFlight.current++; setSaving(true);
    const result = queue.current.then(() => send(intent)).then(() => true, (error: unknown) => {
      if (!scope.current.active || intent.scope !== scope.current.number) return false;
      if (receipts.current.has(intent.id)) { pending.current.delete(intent.id); publish(); return true; }
      pending.current.delete(intent.id);
      if (intent.lease) live.current?.cancel();
      if (intent.entry && !intent.entry.commands.length && ![...pending.current.values()].some((other) => other.entry === intent.entry)) {
        undoStack.current = undoStack.current.filter((entry) => entry !== intent.entry);
        setUndoLabel(undoStack.current.at(-1)?.label ?? null);
      }
      try { sessionStorage.setItem(`flux:map-pending:${me.id}:${sketchId}`, JSON.stringify({ op: intent.op, commandId: intent.id, scope: sketchId })); } catch { /* Still explained in this view. */ }
      setProblem(error instanceof Error ? error.message : 'A change was not confirmed. Its intent is kept privately.');
      publish(); return false;
    }).finally(() => { inFlight.current--; setSaving(inFlight.current > 0); });
    queue.current = result.then(() => undefined); return result;
  }, [send, sketchId, me.id, publish]);
  const perform = useCallback((ops: Op[], label: string, options: { coalesce?: boolean; undoable?: boolean; lease?: Promise<Lease> } = {}) => {
    const current = ref.current; if (!current || !ops.length) return;
    const bytes = [...pending.current.values()].reduce((total, intent) => total + JSON.stringify(intent.op).length * 2, 0) + JSON.stringify(ops).length * 2;
    if (pending.current.size + ops.length > 256 || ops.length > 200 || bytes > 1024 * 1024) { setProblem('Sharing reached its bounded capacity. Wait for the pending changes before starting another step.'); return; }
    const top = undoStack.current.at(-1);
    const queuedForTop = [...pending.current.values()].filter((intent) => intent.entry === top).length;
    const merge = options.coalesce && !top?.undoAttempt && top?.label === label && top.commands.length + queuedForTop + ops.length <= 200 && Date.now() - top.at < 1200;
    let entry = merge ? top : undefined;
    if (!entry && options.undoable !== false) {
      let next = current; const inverseOps: Op[][] = [];
      for (const op of ops) { inverseOps.unshift(inverse(next, op)); next = applyLocal(next, op, meRef.current); }
      entry = { label, ops: inverseOps.flat(), commands: [], at: Date.now() };
      undoStack.current.push(entry); if (undoStack.current.length > 50) undoStack.current.shift();
    } else if (entry) entry.at = Date.now();
    setUndoLabel(undoStack.current.at(-1)?.label ?? null); setProblem(null);
    for (const op of ops) {
      const intent: Intent = { id: uuid(), scope: scope.current.number, op, epochs: new Map(touched(op, current).map((id) => [id, epochs.current.get(id) ?? 0])), entry, lease: options.lease };
      ownCommands.current.add(intent.id);
      while (ownCommands.current.size > 12_000) ownCommands.current.delete(ownCommands.current.values().next().value!);
      pending.current.set(intent.id, intent); void enqueue(intent);
    }
    publish();
  }, [enqueue, publish]);
  const undo = useCallback((): string | null => {
    const entry = undoStack.current.at(-1); if (!entry || inFlight.current) { setProblem('Wait until your change is confirmed before undoing it.'); return null; }
    if (live.current?.status === 'live') {
      inFlight.current++; setSaving(true);
      const instance = scope.current.number;
      const command = entry.undoAttempt ?? { originalCommandIds: [...entry.commands], clientCommandId: uuid() };
      entry.undoAttempt = command;
      ownCommands.current.add(command.clientCommandId);
      while (ownCommands.current.size > 12_000) ownCommands.current.delete(ownCommands.current.values().next().value!);
      const completed = () => { undoStack.current = undoStack.current.filter((item) => item !== entry); setUndoLabel(undoStack.current.at(-1)?.label ?? null); };
      queue.current = queue.current.then(async () => {
        const result = await withRetry(() => {
          if (!scope.current.active || instance !== scope.current.number) throw new DOMException('The original map editor closed', 'AbortError');
          return request<UndoneLiveMap>(liveMapUndoPath(sketchId), { method: 'POST', body: command, headers: { 'idempotency-key': command.clientCommandId } });
        });
        if (!scope.current.active || instance !== scope.current.number) return;
        if (result.commandId !== command.clientCommandId || result.delta.commandId !== command.clientCommandId) throw new Error('Unexpected undo receipt. Reconnect to inspect the confirmed map.');
        // Even an exact known inverse receipt can arrive after a later peer change.
        // Its response never patches the graph; ordered delivery or a current gap
        // snapshot establishes the confirmed projection, just like native commands.
        const deadline = Date.now() + 1000;
        while (!receipts.current.has(command.clientCommandId) && (live.current?.head?.sequence ?? -1) < result.delta.sequence && Date.now() < deadline) {
          if (!scope.current.active || instance !== scope.current.number) return;
          await new Promise((resolve) => window.setTimeout(resolve, 20));
        }
        if (!receipts.current.has(command.clientCommandId) && (live.current?.head?.sequence ?? -1) < result.delta.sequence) {
          const before = snapshots.current; live.current?.resync();
          const until = Date.now() + 5000;
          while (snapshots.current === before && Date.now() < until) {
            if (!scope.current.active || instance !== scope.current.number) return;
            await new Promise((resolve) => window.setTimeout(resolve, 20));
          }
          if (snapshots.current === before || (live.current?.head?.sequence ?? -1) < result.delta.sequence) throw new Error('The inverse committed, but its current map snapshot is not confirmed yet. Retry its original receipt before another undo.');
        }
        if (!scope.current.active || instance !== scope.current.number) return;
        completed();
      }).catch((error: unknown) => {
        if (!scope.current.active || instance !== scope.current.number) return;
        if (receipts.current.has(command.clientCommandId)) { completed(); return; }
        if (error instanceof ApiError && error.status < 500 && (!error.body || typeof error.body !== 'object' || (error.body as { outcome?: string }).outcome !== 'unknown')) entry.undoAttempt = undefined;
        setProblem(error instanceof Error ? error.message : 'This change could not be undone because someone else changed the affected objects.');
      })
        .finally(() => { inFlight.current--; setSaving(inFlight.current > 0); });
      return entry.label;
    }
    if (live.current?.status !== 'unavailable') { setProblem('Reconnect before undoing a shared change.'); return null; }
    undoStack.current.pop(); perform(entry.ops, `undid ${entry.label}`, { undoable: false });
    setUndoLabel(undoStack.current.at(-1)?.label ?? null); return entry.label;
  }, [sketchId, perform]);
  const saveThought = useCallback((op: Extract<Op, { kind: 'add' }>, key: string): Promise<boolean> => {
    const current = ref.current; if (!current) return Promise.resolve(false);
    if (pending.current.size >= 256 || [...pending.current.values()].reduce((total, intent) => total + JSON.stringify(intent.op).length * 2, JSON.stringify(op).length * 2) > 1024 * 1024) { setProblem('Wait for the pending changes before sharing this private draft.'); return Promise.resolve(false); }
    const entry: Entry = { label: 'added a thought', ops: [{ kind: 'remove', id: op.thought.id }], commands: [], at: Date.now() };
    const intent: Intent = { id: key, scope: scope.current.number, op, epochs: new Map(touched(op, current).map((id) => [id, epochs.current.get(id) ?? 0])), entry };
    ownCommands.current.add(key);
    while (ownCommands.current.size > 12_000) ownCommands.current.delete(ownCommands.current.values().next().value!);
    // This draft is shared only by explicit Save; no pointer preview or live text uses it.
    pending.current.set(key, intent); publish();
    return enqueue(intent).then((saved) => { if (saved) { undoStack.current.push(entry); if (undoStack.current.length > 50) undoStack.current.shift(); setUndoLabel(entry.label); } return saved; });
  }, [enqueue, publish]);
  const saveText = useCallback((id: string, text: string, opened: { text: string; version: number }, key: string): Promise<boolean> => {
    const current = confirmed.current?.thoughts.find((thought) => thought.id === id);
    if (!current || (current.version !== opened.version && current.text !== opened.text)) { setProblem('Someone else changed this thought. Your edit is kept; compare their text first.'); return Promise.resolve(false); }
    const entry: Entry = { label: 'edited a thought', ops: [{ kind: 'update', id, changes: { text: opened.text } }], commands: [], at: Date.now() };
    const intent: Intent = { id: key, scope: scope.current.number, op: { kind: 'update', id, changes: { text } }, epochs: new Map([[id, epochs.current.get(id) ?? 0]]), entry };
    if (pending.current.size >= 256 || [...pending.current.values()].reduce((total, item) => total + JSON.stringify(item.op).length * 2, JSON.stringify(intent.op).length * 2) > 1024 * 1024) { setProblem('Wait for the pending changes before sharing this private edit.'); return Promise.resolve(false); }
    ownCommands.current.add(key);
    while (ownCommands.current.size > 12_000) ownCommands.current.delete(ownCommands.current.values().next().value!);
    pending.current.set(key, intent); publish();
    return enqueue(intent).then((saved) => { if (saved) { undoStack.current.push(entry); if (undoStack.current.length > 50) undoStack.current.shift(); setUndoLabel(entry.label); } return saved; });
  }, [enqueue, publish]);
  const beginGesture = (ids: string[]) => {
    const current = confirmed.current; if (!current || live.current?.status === 'unavailable') return true;
    const busy = [...pending.current.values()].some((intent) => touched(intent.op, current).some((id) => ids.includes(id)));
    if (busy) { setProblem('Wait for these thoughts to be confirmed before dragging them.'); return false; }
    return live.current?.begin(ids.flatMap((id) => { const thought = current.thoughts.find((thought) => thought.id === id); return thought ? [thought] : []; })) ?? false;
  };
  return { sketch, load, saving, problem: problem ?? liveState.problem, clearProblem: () => setProblem(null), canUndo: undoLabel !== null && !saving, perform, saveThought, saveText, undo, reload, newId: uuid,
    liveStatus: liveState.status, liveCanWrite: liveState.canWrite, ownGesture: liveState.ownGesture, previews: liveState.previews, peers: liveState.peers, privateMovement: liveState.privateMovement, discardPrivateMovement: () => live.current?.discardPrivateMovement(),
    beginGesture, previewGesture: (positions: LiveMapPosition[]) => live.current?.preview(positions), cancelGesture: () => live.current?.cancel(true),
    finishGesture: () => live.current?.status === 'unavailable' ? undefined : live.current?.finish(),
    presence: (ids: string[]) => live.current?.selection(ids),
  };
}

export type LiveSketchDoc = ReturnType<typeof useLiveSketchDoc>;
