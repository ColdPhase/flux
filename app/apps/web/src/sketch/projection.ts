import { DEFAULT_THOUGHT_SIZE, type LiveMapPosition, type SketchDetail, type Thought, type ThoughtFile, type ThoughtShape } from '@flux/contracts';

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

export interface Me { id: string; name: string }

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

/** Overlay current authorized positions without replacing the native graph or
 * unaffected thought identities. An absent/expired overlay returns the native
 * objects themselves; it cannot restore an object absent from confirmed state. */
export function applyLivePreviews(sketch: SketchDetail, previews: ReadonlyMap<string, LiveMapPosition>): SketchDetail {
  if (!previews.size) return sketch;
  let changed = false;
  const thoughts = sketch.thoughts.map((thought) => {
    const position = previews.get(thought.id);
    if (!position || thought.x === position.x && thought.y === position.y
      && (position.width === undefined || thought.width === position.width)
      && (position.height === undefined || thought.height === position.height)) return thought;
    changed = true;
    return { ...thought, x: position.x, y: position.y,
      ...(position.width === undefined ? {} : { width: position.width }),
      ...(position.height === undefined ? {} : { height: position.height }) };
  });
  return changed ? { ...sketch, thoughts } : sketch;
}
