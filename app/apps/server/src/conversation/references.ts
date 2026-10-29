import { messagePreview, type MessageReference, type MessageReferenceCard } from '@flux/contracts';
import { accessReader, messageReferenceRows, workRows, type DbExecutor, type LocatedMessage, type LocatedThought } from '@flux/db';
import { evaluateDm, evaluateProject, evaluateSketch, NotFoundError, type Principal } from '@flux/core';

/** The longest title a card shows: one line of the thought or message, never its whole text. */
const TITLE = 160;
const oneLine = (text: string) => {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length > TITLE ? `${first.slice(0, TITLE - 1).trimEnd()}…` : first;
};

type Opened = { card: Extract<MessageReferenceCard, { state: 'available' }>; author: { kind: 'human' | 'agent'; id: string } | null };
type Owner = { kind: 'project' | 'dm'; workspaceId: string };

/**
 * What a message cites, for the reader who asks (#469, F-026 §6). A reference stores only the kind and the id of its target;
 * every card is made here, after the reader's own access to that target is decided by the one access policy (`sketch.read`,
 * `project.read`, `dm.read`). A target the reader cannot open, one that no longer exists and one in another workspace all come
 * back as the same `unavailable` card with no id, title, author or place, so a reference never shows what its reader may not read.
 */
export function messageReferences(db: DbExecutor) {
  const rows = messageReferenceRows(db);
  const reader = accessReader(db);

  async function thought(principal: Principal, located: LocatedThought): Promise<Opened | null> {
    if (!(await evaluateSketch(principal, 'sketch.read', located.sketchId, reader)).allowed) return null;
    return { author: located.author, card: { kind: 'thought', state: 'available', title: oneLine(located.text) || 'Thought', author: null, at: located.updatedAt.toISOString(),
      place: located.sketchTitle, target: { type: 'thought', sketchId: located.sketchId, thoughtId: located.id, dmId: located.dmId } } };
  }

  async function message(principal: Principal, located: LocatedMessage): Promise<Opened | null> {
    if (located.kind === 'dm') {
      if (!(await evaluateDm(principal, 'dm.read', located.dmId, reader)).allowed) return null;
      return { author: located.author, card: { kind: 'message', state: 'available', title: oneLine(located.body) || 'Message', author: null, at: located.createdAt.toISOString(),
        place: 'Direct message', target: { type: 'dm_message', dmId: located.dmId, messageId: located.id } } };
    }
    if (!(await evaluateProject(principal, 'project.read', located.projectId, reader)).allowed) return null;
    return { author: located.author, card: { kind: 'message', state: 'available', title: oneLine(located.body) || messagePreview('', located.attachmentCount) || 'Message',
      author: null, at: located.createdAt.toISOString(), place: located.projectName,
      target: { type: 'message', projectId: located.projectId, conversationId: located.conversationId, messageId: located.id } } };
  }

  /** The target as this reader may open it now, or null; the workspace of the citing message bounds it. */
  async function open(principal: Principal, reference: MessageReference, workspaceId: string): Promise<Opened | null> {
    if (reference.kind === 'thought') {
      const located = await rows.thought(reference.id, workspaceId);
      return located ? thought(principal, located) : null;
    }
    const located = await rows.message(reference.id, workspaceId);
    return located ? message(principal, located) : null;
  }

  /** The cards of these messages for `principal`, by message id; a message with no references is absent. */
  async function cards(principal: Principal, owner: Owner, messageIds: readonly string[]): Promise<Map<string, MessageReferenceCard[]>> {
    const stored = await rows.stored(owner.kind, messageIds);
    const result = new Map<string, MessageReferenceCard[]>();
    if (!stored.size) return result;
    const opened = new Map<string, Opened | null>();
    for (const list of stored.values()) {
      for (const reference of list) {
        const key = `${reference.kind}:${reference.id}`;
        if (!opened.has(key)) opened.set(key, await open(principal, reference, owner.workspaceId));
      }
    }
    const authors = [...opened.values()].flatMap((item) => item?.author ? [item.author] : []);
    const names = authors.length ? await workRows(db).names(authors) : new Map<string, string>();
    for (const [messageId, list] of stored) {
      result.set(messageId, list.map((reference): MessageReferenceCard => {
        const item = opened.get(`${reference.kind}:${reference.id}`);
        if (!item) return { kind: reference.kind, state: 'unavailable' };
        return { ...item.card, author: item.author ? names.get(`${item.author.kind}:${item.author.id}`) ?? null : null };
      }));
    }
    return result;
  }

  return {
    /**
     * Before a message is stored: the sender must be able to read every target now, in the message's own workspace. A target that
     * is absent, another workspace's or unreadable all answer 404 REFERENCE_UNAVAILABLE, so the answer tells nothing about it.
     */
    async assertReadable(principal: Principal, workspaceId: string, references: readonly MessageReference[]) {
      for (const reference of references) {
        if (!(await open(principal, reference, workspaceId))) throw new NotFoundError('Reference', 'REFERENCE_UNAVAILABLE');
      }
    },

    cards,

    /** The cards of the messages of one direct message, for a reader who is asking through that DM's own route. */
    async dmCards(principal: Principal, dmId: string, messageIds: readonly string[]) {
      const located = await reader.locateDm(dmId);
      return located ? cards(principal, { kind: 'dm', workspaceId: located.workspaceId }, messageIds) : new Map<string, MessageReferenceCard[]>();
    },

    /** Stores the references of a message just inserted (inside its transaction). */
    save: (owner: { kind: 'project' | 'dm'; id: string }, workspaceId: string, references: readonly MessageReference[]) => rows.save(owner, workspaceId, references),
  };
}

export type MessageReferences = ReturnType<typeof messageReferences>;
