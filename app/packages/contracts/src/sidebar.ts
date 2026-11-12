/**
 * The sidebar's own state, per person (#1250, v0.2.1): the order of the Spaces list, and "Mark all as read".
 *
 * The order is the person's and the same on every device. Everyone is always first and is never stored; a space the person has not
 * moved (a new one included) goes after the ordered ones, in the order the spaces were made in. A change reaches the person's other
 * open tabs through `SPACE_ORDER_CHANGED_EVENT`, which only they receive; the tabs read the order again and show it without animation.
 */

export const SPACE_ORDER_PATH = '/api/v1/me/space-order';
export const READ_ALL_PATH = '/api/v1/me/read-all';
export const READ_ALL_UNDO_PATH = '/api/v1/me/read-all/undo';

/** `person.space_order_changed.v1`: recorded about the person themself, so it reaches only their own tabs. */
export const SPACE_ORDER_CHANGED_EVENT = 'person.space_order_changed.v1';

/** The most spaces one order holds. */
export const SPACE_ORDER_LIMIT = 500;

/** The spaces the person moved, first to last. Everyone is not in it. */
export interface SpaceOrder { order: string[] }

/** `PUT`: the whole order the person made, first to last. Ids the person cannot see, and Everyone, are left out of what is kept. */
export interface SetSpaceOrderCommand { order: string[] }

/** What `read-all` changed, so that Undo can put back exactly that and nothing the person did since. Opaque to the client. */
export interface ReadAllUndo {
  /** The audience position every space was read up to: a space is put back only while it still stands there. */
  mark: string | null;
  /** The spaces whose point moved. */
  spaces: string[];
  /** The chats of the person's agents that were unread, with when each had been read before (null: never). */
  chats: { agentId: string; before: string | null; now: string }[];
}

export interface ReadAllResult { undo: ReadAllUndo }

/**
 * The Spaces list in the person's order: Everyone first (the spaces `everyone` names, in the order given), then the spaces the person
 * moved, in the order they moved them, then the rest in the order given (the order the spaces were made in): so a new space, and one
 * the person was added to, comes last. An id in `order` that is not among `spaces` is ignored.
 */
export function orderSpaces<T extends { id: string }>(spaces: readonly T[], order: readonly string[], everyone: (space: T) => boolean): T[] {
  const first = spaces.filter(everyone);
  const rest = spaces.filter((space) => !everyone(space));
  const rank = new Map(order.map((id, index) => [id, index] as const));
  const moved = rest.filter((space) => rank.has(space.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...first, ...moved, ...rest.filter((space) => !rank.has(space.id))];
}
