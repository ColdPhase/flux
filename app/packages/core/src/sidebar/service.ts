import { SPACE_ORDER_CHANGED_EVENT, SPACE_ORDER_LIMIT, type ReadAllResult, type ReadAllUndo, type SetSpaceOrderCommand, type SpaceOrder } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { SidebarUnitOfWork } from './ports.js';

// The sidebar's own state (#1250, v0.2.1). Two small things that belong to one person and to nobody else:
//
// - The order of their Spaces list. One flat list; the person moves a space and the whole order is written at once. Everyone is always
//   first, so it is never stored; a space the person never moved (a new one too) goes after the ordered ones in the order spaces were
//   made in, which is the client's sort. Only the spaces of the person's sidebar are kept and answered: an id they cannot see is left
//   out, when it is written and when it is read (they may have lost access since). A change
//   is recorded as an event about the person, which only they receive, so their other tabs read the order again.
// - "Mark all as read": every space's return point moves to the newest position of the person's own audience, and the chats of their
//   agents are marked read. Undo puts back exactly what this moved, and only where nothing has moved it since. Nothing here touches the
//   Inbox: what needs an action stays where it is.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most chats one Undo carries: a person has a handful of agents. */
const MOST_CHATS = 100;

function human(principal: Principal) {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

function ids(value: unknown, what: string, most: number): string[] {
  if (!Array.isArray(value) || value.length > most) throw new InvalidInputError(`${what} must be a list of at most ${most} ids`, 'INVALID_SPACE_ORDER');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !UUID.test(item)) throw new InvalidInputError(`${what} holds an id that is not valid`, 'INVALID_SPACE_ORDER');
    seen.add(item.toLowerCase());
  }
  return [...seen];
}

export function createSidebarUseCases(unit: SidebarUnitOfWork) {
  async function visible(principal: Principal, workspaces: readonly string[], read: (workspaceId: string) => Promise<Set<string>>) {
    const found = new Set<string>();
    for (const workspaceId of workspaces) for (const id of await read(workspaceId)) found.add(id);
    return found;
  }

  return {
    /** The spaces the person moved, first to last: only those they can still see (a space they lost access to is left out). */
    async order(principal: Principal): Promise<SpaceOrder> {
      const userId = human(principal);
      return unit.run(async ({ access, repository }) => {
        const stored = await repository.order(userId);
        // Most people never move a space: nothing is asked of the access policy for them.
        if (!stored.length) return { order: [] };
        const workspaces = await access.workspaceIds(principal);
        const mine = await visible(principal, workspaces, (workspaceId) => access.memberProjects(principal, workspaceId));
        return { order: stored.filter((id) => mine.has(id)) };
      });
    },

    /** Replaces the order. Ids the person cannot see, and Everyone, are not kept; the order kept is answered. */
    async setOrder(principal: Principal, command: SetSpaceOrderCommand): Promise<SpaceOrder> {
      const userId = human(principal);
      const wanted = ids(command?.order, 'The order', SPACE_ORDER_LIMIT);
      return unit.run(async ({ access, repository, events }) => {
        const workspaces = await access.workspaceIds(principal);
        const mine = await visible(principal, workspaces, (workspaceId) => access.memberProjects(principal, workspaceId));
        const everyone = await repository.everyone(workspaces);
        const kept = wanted.filter((id) => mine.has(id) && !everyone.has(id));
        await repository.replaceOrder(userId, kept);
        const workspaceId = await access.eventWorkspace(principal);
        if (workspaceId) await events.record(principal, workspaceId, SPACE_ORDER_CHANGED_EVENT, userId, {});
        return { order: kept };
      });
    },

    /** Reads every space and every agent's chat. What it moved comes back, for Undo. */
    async readAll(principal: Principal): Promise<ReadAllResult> {
      const userId = human(principal);
      const recipient = `human:${userId}`;
      return unit.run(async ({ access, repository }) => {
        const last = await repository.lastEvent(recipient);
        const moved: string[] = [];
        if (last) {
          const workspaces = await access.readableWorkspaceIds(principal);
          const spaces = [...await visible(principal, workspaces, (workspaceId) => access.memberProjects(principal, workspaceId))];
          const points = await repository.points(userId, spaces.map((id) => `project:${id}`));
          for (const id of spaces) {
            // A space whose point is already at the newest position has nothing to read.
            if ((points.get(`project:${id}`)?.seq ?? -1) >= last.seq) continue;
            await repository.advance(userId, id, last.seq);
            moved.push(id);
          }
        }
        const chats = await repository.readChats(userId);
        const undo: ReadAllUndo = { mark: last?.id ?? null, spaces: moved, chats };
        return { undo };
      });
    },

    /** Puts back what `readAll` moved, wherever nothing has moved it since. */
    async undoReadAll(principal: Principal, command: ReadAllUndo): Promise<void> {
      const userId = human(principal);
      const recipient = `human:${userId}`;
      const spaces = ids(command?.spaces, 'The spaces', SPACE_ORDER_LIMIT);
      const chats = command?.chats;
      if (!Array.isArray(chats) || chats.length > MOST_CHATS) throw new InvalidInputError('The chats must be a short list', 'INVALID_READ_UNDO');
      for (const chat of chats) {
        if (!chat || typeof chat !== 'object' || typeof chat.agentId !== 'string' || !UUID.test(chat.agentId) || typeof chat.now !== 'string' || chat.now.length > 64
          || (chat.before !== null && (typeof chat.before !== 'string' || chat.before.length > 64))) throw new InvalidInputError('A chat is not valid', 'INVALID_READ_UNDO');
      }
      if (command.mark !== null && (typeof command.mark !== 'string' || !UUID.test(command.mark))) throw new InvalidInputError('mark must come from Mark all as read', 'INVALID_READ_UNDO');
      await unit.run(async ({ repository }) => {
        const seq = command.mark === null ? null : await repository.audienceSeq(recipient, command.mark.toLowerCase());
        if (command.mark !== null && seq === null) throw new InvalidInputError('mark must come from Mark all as read', 'INVALID_READ_UNDO');
        if (seq !== null) for (const id of spaces) await repository.restore(userId, id, seq);
        for (const chat of chats) await repository.restoreChat(userId, chat);
      });
    },
  };
}

export type SidebarUseCases = ReturnType<typeof createSidebarUseCases>;
