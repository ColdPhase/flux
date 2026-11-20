import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { removedName, type PinnedMessage, type PinPart, type PinPlace } from '@flux/contracts';
import * as schema from '../schema.js';
import { openRows } from '../sealing.js';
import { fileRows } from './files.js';
import { workRows } from './work.js';
import type { DbExecutor } from './push.js';

/**
 * Pinned messages (C-74, #1615, migration 0112): persistence only. The use case decides who may read or change a conversation's list, with
 * the conversation checked first, and calls these inside that transaction. A pin names a message of its conversation that is still there:
 * a deleted message ("Message removed") is never pinned and never listed, and its delete takes its pin (`messageChangeRows`).
 */

const p = schema.messagePins;
const pm = schema.projectMessages;
const dm = schema.dmMessages;
const runs = schema.personalRuns;
const lines = schema.agentChatMessages;

/** The columns of one pin's message: which message, in which conversation. */
export type PinTarget =
  | { kind: 'project'; workspaceId: string; projectId: string; messageId: string }
  | { kind: 'dm'; workspaceId: string; dmId: string; messageId: string }
  | { kind: 'run'; workspaceId: string; agentId: string; messageId: string; part: PinPart }
  | { kind: 'line'; workspaceId: string; agentId: string; messageId: string };

/** A pinned message as stored; `sources` is how many sources an agent's answer cites, for the use case to take its `[n]` marks out. */
export type PinRecord = PinnedMessage & { sources?: number };

const columns = (target: PinTarget) => target.kind === 'project' ? { projectId: target.projectId, projectMessageId: target.messageId }
  : target.kind === 'dm' ? { dmId: target.dmId, dmMessageId: target.messageId }
  : target.kind === 'run' ? { agentId: target.agentId, runId: target.messageId, runPart: target.part }
  : { agentId: target.agentId, agentChatMessageId: target.messageId };

const where = (target: PinTarget) => target.kind === 'project' ? eq(p.projectMessageId, target.messageId)
  : target.kind === 'dm' ? eq(p.dmMessageId, target.messageId)
  : target.kind === 'run' ? and(eq(p.runId, target.messageId), eq(p.runPart, target.part))!
  : eq(p.agentChatMessageId, target.messageId);

export function messagePinRows(db: DbExecutor) {
  /** The names of the people and agents a list shows, as every view names them ("Stefan Kowal (removed)"). */
  async function names(workspaceId: string, refs: { kind: 'human' | 'agent'; id: string }[]) {
    const { names: found, gone } = await workRows(db).namesIn(refs, workspaceId);
    return (ref: { kind: 'human' | 'agent'; id: string }) => {
      const name = found.get(`${ref.kind}:${ref.id}`) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member');
      return gone.has(`${ref.kind}:${ref.id}`) ? removedName(name) : name;
    };
  }

  return {
    /**
     * The message `messageId` names in this conversation, still there and one people wrote or read as a message: what a pin may name. An id of
     * another conversation is not found, so the check made for this conversation is never borrowed for another one. In an agent's chat the
     * id is a run of that chat (with `part`; an answer only once the run has one) or one of the agent's lines.
     */
    async target(place: PinPlace, workspaceId: string, messageId: string, part: PinPart | null): Promise<PinTarget | null> {
      if (place.type === 'project') {
        if (part) return null;
        const [row] = await db.select({ id: pm.id }).from(pm).where(and(eq(pm.id, messageId), eq(pm.projectId, place.id), isNull(pm.removedAt)));
        return row ? { kind: 'project', workspaceId, projectId: place.id, messageId: row.id } : null;
      }
      if (place.type === 'dm') {
        if (part) return null;
        const [row] = await db.select({ id: dm.id }).from(dm).where(and(eq(dm.id, messageId), eq(dm.dmId, place.id), eq(dm.kind, 'text'), isNull(dm.removedAt)));
        return row ? { kind: 'dm', workspaceId, dmId: place.id, messageId: row.id } : null;
      }
      if (part) {
        // A run of the chat itself: no space, no direct message.
        const [run] = await db.select({ id: runs.id, answer: runs.answerBody }).from(runs)
          .where(and(eq(runs.id, messageId), eq(runs.agentId, place.id), isNull(runs.projectId), isNull(runs.dmId)));
        if (!run || (part === 'answer' && !run.answer)) return null;
        return { kind: 'run', workspaceId, agentId: place.id, messageId: run.id, part };
      }
      const [line] = await db.select({ id: lines.id }).from(lines).where(and(eq(lines.id, messageId), eq(lines.agentId, place.id)));
      return line ? { kind: 'line', workspaceId, agentId: place.id, messageId: line.id } : null;
    },

    /** Pins the message once; true when this call pinned it (a pinned message stays as it was). */
    async pin(target: PinTarget, pinnedBy: string): Promise<boolean> {
      const made = await db.insert(p).values({ workspaceId: target.workspaceId, pinnedBy, ...columns(target) }).onConflictDoNothing().returning({ id: p.id });
      return made.length > 0;
    },

    /** Unpins the message; true when it was pinned. */
    async unpin(target: PinTarget): Promise<boolean> {
      return (await db.delete(p).where(where(target)).returning({ id: p.id })).length > 0;
    },

    /** The conversation's pins, newest first, at most `limit`: each with its message as everyone in the conversation reads it. */
    async list(place: PinPlace, workspaceId: string, limit: number): Promise<PinRecord[]> {
      if (place.type === 'project') {
        const rows = await db.select({ pin: p, message: pm }).from(p).innerJoin(pm, eq(pm.id, p.projectMessageId))
          .where(and(eq(p.projectId, place.id), isNull(pm.removedAt))).orderBy(desc(p.pinnedAt), desc(p.id)).limit(limit);
        // An encrypted space's words are opened as its stream opens them (a locked one refuses, 423).
        const opened = await openRows(db, 'project_messages', rows.map((row) => row.message));
        const files = await fileRows(db).messageFiles(opened.map((row) => row.id));
        const replies = [...new Set(opened.filter((row) => row.sequence > 1).map((row) => row.conversationId))];
        const roots = new Map(replies.length ? (await db.select({ id: pm.id, conversationId: pm.conversationId }).from(pm)
          .where(and(inArray(pm.conversationId, replies), eq(pm.sequence, 1)))).map((row) => [row.conversationId, row.id]) : []);
        const named = await names(workspaceId, [...opened.map((row) => (row.authorId !== null ? { kind: 'human' as const, id: row.authorId } : { kind: 'agent' as const, id: row.authorAgentId! })),
          ...rows.map((row) => ({ kind: 'human' as const, id: row.pin.pinnedBy }))]);
        const colours = await agentColours(opened.flatMap((row) => (row.authorAgentId ? [row.authorAgentId] : [])));
        return rows.map((row, index) => {
          const message = opened[index]!;
          const author = message.authorId !== null ? { kind: 'human' as const, id: message.authorId } : { kind: 'agent' as const, id: message.authorAgentId! };
          const root = message.sequence > 1 ? roots.get(message.conversationId) : undefined;
          return { messageId: message.id, conversationId: message.conversationId, ...(root ? { threadRootId: root } : {}),
            author: { ...author, name: named(author), ...(author.kind === 'agent' && colours.get(author.id) ? { colour: colours.get(author.id)! } : {}) },
            body: message.body, ...(files.get(message.id)?.length ? { files: files.get(message.id) } : {}), createdAt: message.createdAt.toISOString(),
            pinnedBy: { id: row.pin.pinnedBy, name: named({ kind: 'human', id: row.pin.pinnedBy }) }, pinnedAt: row.pin.pinnedAt.toISOString() };
        });
      }
      if (place.type === 'dm') {
        const rows = await db.select({ pin: p, message: dm }).from(p).innerJoin(dm, eq(dm.id, p.dmMessageId))
          .where(and(eq(p.dmId, place.id), isNull(dm.removedAt))).orderBy(desc(p.pinnedAt), desc(p.id)).limit(limit);
        const opened = await openRows(db, 'dm_messages', rows.map((row) => row.message));
        const files = await fileRows(db).messageFiles(opened.map((row) => row.id));
        const named = await names(workspaceId, [...opened.map((row) => ({ kind: 'human' as const, id: row.authorId })), ...rows.map((row) => ({ kind: 'human' as const, id: row.pin.pinnedBy }))]);
        return rows.map((row, index) => {
          const message = opened[index]!;
          return { messageId: message.id, ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
            author: { kind: 'human' as const, id: message.authorId, name: named({ kind: 'human', id: message.authorId }) },
            body: message.body, ...(files.get(message.id)?.length ? { files: files.get(message.id) } : {}), createdAt: message.createdAt.toISOString(),
            pinnedBy: { id: row.pin.pinnedBy, name: named({ kind: 'human', id: row.pin.pinnedBy }) }, pinnedAt: row.pin.pinnedAt.toISOString() };
        });
      }
      // An agent's chat: its owner's requests, the agent's answers and its own lines. Only its owner reads it, and it is never encrypted (no AI there).
      const rows = await db.select({ pin: p, run: { id: runs.id, ownerUserId: runs.ownerUserId, prompt: runs.prompt, answer: runs.answerBody, sources: runs.answerSources, createdAt: runs.createdAt, completedAt: runs.completedAt },
        line: { id: lines.id, body: lines.body, createdAt: lines.createdAt } })
        .from(p).leftJoin(runs, eq(runs.id, p.runId)).leftJoin(lines, eq(lines.id, p.agentChatMessageId))
        .where(eq(p.agentId, place.id)).orderBy(desc(p.pinnedAt), desc(p.id)).limit(limit);
      const agent = { kind: 'agent' as const, id: place.id };
      const named = await names(workspaceId, [agent, ...rows.flatMap((row) => [{ kind: 'human' as const, id: row.pin.pinnedBy }, ...(row.run ? [{ kind: 'human' as const, id: row.run.ownerUserId }] : [])])]);
      const colour = (await agentColours([place.id])).get(place.id);
      const said = { ...agent, name: named(agent), ...(colour ? { colour } : {}) };
      return rows.flatMap((row): PinRecord[] => {
        const pinnedBy = { id: row.pin.pinnedBy, name: named({ kind: 'human', id: row.pin.pinnedBy }) };
        const pinnedAt = row.pin.pinnedAt.toISOString();
        if (row.line) return [{ messageId: row.line.id, author: said, body: row.line.body, createdAt: row.line.createdAt.toISOString(), pinnedBy, pinnedAt }];
        if (!row.run) return [];
        if (row.pin.runPart === 'answer') return row.run.answer === null ? [] : [{ messageId: row.run.id, part: 'answer', author: said, body: row.run.answer,
          sources: row.run.sources.length, createdAt: (row.run.completedAt ?? row.run.createdAt).toISOString(), pinnedBy, pinnedAt }];
        const owner = { kind: 'human' as const, id: row.run.ownerUserId };
        return [{ messageId: row.run.id, part: 'prompt', author: { ...owner, name: named(owner) }, body: row.run.prompt, createdAt: row.run.createdAt.toISOString(), pinnedBy, pinnedAt }];
      });
    },

    /** Which of these messages (a space's or a direct message's) are pinned: the search's "Pinned" mark, read for the rows of one page only. */
    async pinnedAmong(messageIds: readonly string[]): Promise<Set<string>> {
      if (!messageIds.length) return new Set();
      const ids = [...new Set(messageIds)];
      const rows = await db.select({ project: p.projectMessageId, dm: p.dmMessageId }).from(p).where(or(inArray(p.projectMessageId, ids), inArray(p.dmMessageId, ids)));
      return new Set(rows.flatMap((row) => [row.project, row.dm].filter((id): id is string => id !== null)));
    },
  };

  async function agentColours(ids: string[]) {
    if (!ids.length) return new Map<string, import('@flux/contracts').AgentColour>();
    const rows = await db.select({ id: schema.assistantSettings.agentId, colour: schema.assistantSettings.colour }).from(schema.assistantSettings)
      .where(inArray(schema.assistantSettings.agentId, [...new Set(ids)]));
    return new Map(rows.map((row) => [row.id, row.colour]));
  }
}

/** Deletes the pin of a message its author deleted, in the delete's transaction (C-74: a deleted message leaves the list). */
export async function forgetPin(db: DbExecutor, message: { kind: 'project' | 'dm'; id: string }) {
  await db.execute(message.kind === 'project' ? sql`DELETE FROM message_pins WHERE project_message_id = ${message.id}` : sql`DELETE FROM message_pins WHERE dm_message_id = ${message.id}`);
}
