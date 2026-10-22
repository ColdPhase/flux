/** Human collaboration follows Prostota's monochrome tokens; names identify people. */
export const COLLABORATION_INK = 'var(--t1)';
/**
 * Without colour, people at the same text are told apart by a name and a small shape. The shape rides on the caret, on its
 * name tag beside the line and in the People strip, so the three can be matched (Prostota: shape, not colour, carries meaning).
 */
export const PEER_SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const;
export type PeerShape = typeof PEER_SHAPES[number];
