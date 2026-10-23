/** Human collaboration follows Prostota's monochrome tokens; names identify people. */
export const COLLABORATION_INK = 'var(--t1)';
/**
 * Without colour, people at the same text are told apart by a name and a small shape. The shape rides on the caret, on its
 * name tag beside the line and in the People strip, so the three can be matched (Prostota: shape, not colour, carries meaning).
 */
export const PEER_SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const;
export type PeerShape = typeof PEER_SHAPES[number];
/**
 * One shape per person, the same on every viewer's screen ("I'm the square") and kept for as long as the person stays.
 * The server gives each person in a room the smallest free slot when they first show presence and keeps it for them;
 * the slot reaches every viewer with the person's presence, so nobody resolves anything locally and a newcomer never
 * changes an existing person's shape. Beyond four people in one room shapes repeat; the names still tell them apart.
 */
export const shapeOfSlot = (slot: number): PeerShape => PEER_SHAPES[(Math.max(0, Math.trunc(slot)) || 0) % PEER_SHAPES.length]!;
