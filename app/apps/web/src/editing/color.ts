/** Human collaboration follows Prostota's monochrome tokens; names identify people. */
export const COLLABORATION_INK = 'var(--t1)';
/**
 * Without colour, people at the same text are told apart by a name and a small shape. The shape rides on the caret, on its
 * name tag beside the line and in the People strip, so the three can be matched (Prostota: shape, not colour, carries meaning).
 */
export const PEER_SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const;
export type PeerShape = typeof PEER_SHAPES[number];
/**
 * A person keeps one shape while they stay (the first unused one when they arrive), so a peer never changes shape because
 * someone else joined. `kept` is the caller's own memory (per room); ids that are no longer present free their shape.
 */
export function assignShapes(kept: Map<string, PeerShape>, present: readonly string[]): Map<string, PeerShape> {
  const here = [...new Set(present)].sort();
  for (const id of [...kept.keys()]) if (!here.includes(id)) kept.delete(id);
  for (const id of here) if (!kept.has(id)) kept.set(id, PEER_SHAPES.find((shape) => ![...kept.values()].includes(shape)) ?? PEER_SHAPES[kept.size % PEER_SHAPES.length]!);
  return kept;
}
