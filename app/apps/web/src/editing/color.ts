/** Human collaboration follows Prostota's monochrome tokens; names identify people. */
export const COLLABORATION_INK = 'var(--t1)';
/**
 * Without colour, people at the same text are told apart by a name and a small shape. The shape rides on the caret, on its
 * name tag beside the line and in the People strip, so the three can be matched (Prostota: shape, not colour, carries meaning).
 */
export const PEER_SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const;
export type PeerShape = typeof PEER_SHAPES[number];
/**
 * One shape per person, the same on every viewer's screen ("I'm the square"). A person prefers the shape their id hashes to;
 * people in the room are taken in id order and one whose shape is taken moves on to the next free one, so every viewer who
 * knows the same people resolves a collision the same way. `participants` is everyone in the room who shows presence,
 * the viewer included (a viewer's own cursor is never drawn, but their shape is what others see).
 */
export function shapesFor(participants: readonly string[]): Map<string, PeerShape> {
  const result = new Map<string, PeerShape>();
  const taken = new Set<number>();
  for (const id of [...new Set(participants)].sort()) {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
    let index = hash % PEER_SHAPES.length;
    if (taken.size < PEER_SHAPES.length) while (taken.has(index)) index = (index + 1) % PEER_SHAPES.length;
    taken.add(index);
    result.set(id, PEER_SHAPES[index]!);
  }
  return result;
}
