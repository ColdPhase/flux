import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/**
 * What the assistant's Undo may take back of the four things it can create that no person can remove: a map, a recorded result,
 * a proposed decision and a posted message (F-027 AST-6, #68 closeout, founder direction 2026-10-29). Each function runs inside
 * the Undo's transaction, locks the object, and removes it only if the assistant made it and nobody has used it since. No person
 * has a delete for any of them: this is reachable only through the Undo of a change-log row.
 *
 * "Used" means a trace of anyone else: an edit, a decision, a reply or later activity in the thread (a message the assistant itself
 * took back is none), or a citation (an object link, a message reference, a thought started from it). The reason comes back in
 * plain words for the run's message. Maps are never copied (only a direct message's map is copied into a project), so copies are not checked.
 * The caller holds the project's task-graph lock first (a map's own row before that, see `lockMap`), and every work path that cites one of
 * these re-checks its targets after taking the same lock; a message reference, written without it, holds the cited message `FOR SHARE`
 * (`lockCitable`). So a citation is either committed before the checks below or finds the object gone.
 * A message keeps its row as a tombstone (its place in the conversation, its sequence and the ids events carry stay); a map, a
 * result and a decision leave with the objects that only they owned (their links and the notices about them).
 */

/** The marker a removed message carries instead of its text. */
export const REMOVED_MESSAGE_BODY = '[Removed with Undo]';

export type Removal =
  | { ok: true; snapshot: Record<string, unknown> }
  /** `used`: someone used it since, `reason` says how; `gone`: it is not there any more; `foreign`: the assistant did not make it. */
  | { ok: false; why: 'used' | 'gone' | 'foreign'; reason: string };

const used = (reason: string): Removal => ({ ok: false, why: 'used', reason });
const gone = (): Removal => ({ ok: false, why: 'gone', reason: 'Already gone' });
const foreign = (): Removal => ({ ok: false, why: 'foreign', reason: 'This one can’t be undone' });

export const REMOVAL_REASONS = {
  replies: 'Replies since. Open it',
  cited: 'Used since. Open it',
  changed: 'Changed since. Open it',
  decided: 'Decided since. Open it',
  renamed: 'Renamed since. Open it',
  filled: 'It has thoughts now. Open it',
  open: 'Someone has it open. Open it',
  taskChanged: 'The task changed since. Open it',
} as const;

const first = async <T>(db: DbExecutor, query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] as T | undefined) ?? null;
const yes = async (db: DbExecutor, query: ReturnType<typeof sql>) => !!(await first<{ found: boolean }>(db, query))?.found;
/** A foreign key that a table of another feature holds on the object: the object is in use there. */
const inUse = (error: unknown) => {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === '23503' || code?.cause?.code === '23503';
};

export function assistantRemovalRows(db: DbExecutor) {
  /** Something other than the object's own creation points at it: an object link, a message reference or a thought started from it. */
  const cited = (id: string, kind: 'message' | 'other') => yes(db, sql`SELECT (
    EXISTS (SELECT 1 FROM project_object_links WHERE to_id = ${id})
    OR EXISTS (SELECT 1 FROM message_references WHERE target_id = ${id})
    ${kind === 'message' ? sql`OR EXISTS (SELECT 1 FROM sketch_thoughts WHERE source_project_message_id = ${id})` : sql``}
  ) AS found`);
  /** The notices that carried the object's title or text to people: they go with it. */
  const forgetNotices = (projectId: string, id: string) =>
    db.execute(sql`DELETE FROM notifications WHERE source_type = 'project' AND source_id = ${projectId} AND url LIKE ${`%${id}%`}`);

  /** Takes a message back to its tombstone. `messageId` locks the row and its conversation, then looks for use. */
  async function tombstone(messageId: string, agentId: string | null): Promise<Removal & { projectId?: string }> {
    const message = await first<{ id: string; projectId: string; conversationId: string; sequence: number; authorAgentId: string | null; files: number;
      removedAt: Date | null; length: number; hash: string; kind: string }>(db, sql`
      SELECT id, project_id AS "projectId", conversation_id AS "conversationId", sequence, author_agent_id AS "authorAgentId", attachment_count AS files,
        removed_at AS "removedAt", length(body) AS length, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS hash, contribution_kind AS kind
      FROM project_messages WHERE id = ${messageId} FOR UPDATE`);
    if (!message) return gone();
    if (message.removedAt) return { ok: false, why: 'gone', reason: 'Already removed' };
    // A reply is posted under the conversation's lock; holding it here orders this Undo against a reply that arrives now.
    const conversation = await first<{ space: string }>(db, sql`SELECT space FROM project_conversations WHERE id = ${message.conversationId} FOR UPDATE`);
    if (agentId !== null && (message.authorAgentId !== agentId || message.files > 0)) return foreign();
    if (conversation?.space === 'agents') return foreign();
    if (await yes(db, sql`SELECT EXISTS (SELECT 1 FROM project_messages WHERE conversation_id = ${message.conversationId} AND sequence > ${message.sequence} AND removed_at IS NULL) AS found`))
      return used(REMOVAL_REASONS.replies);
    if (await cited(message.id, 'message')) return used(REMOVAL_REASONS.cited);
    await db.execute(sql`DELETE FROM message_references WHERE project_message_id = ${message.id}`);
    await db.execute(sql`UPDATE project_messages SET body = ${REMOVED_MESSAGE_BODY}, removed_at = now(),
      contribution_kind = 'text', result_id = NULL, source_material_id = NULL, source_material_version = NULL WHERE id = ${message.id}`);
    await forgetNotices(message.projectId, message.id);
    return { ok: true, projectId: message.projectId, snapshot: { conversationId: message.conversationId, sequence: message.sequence, bodyHash: message.hash, bodyLength: message.length } };
  }

  return {
    /**
     * A map's row, `FOR NO KEY UPDATE`, taken before anything else: the strength and the order every writer of a map's thoughts and links
     * uses (the row, then the project graph), so the Undo of a map queues behind them and never crosses them. It does not wait for key-shares.
     */
    async lockMap(mapId: string): Promise<void> {
      await db.execute(sql`SELECT id FROM sketches WHERE id = ${mapId} FOR NO KEY UPDATE`);
    },

    /** Whether a posted message is the assistant's own, in a people's conversation: only then does its change offer an Undo. */
    async messageIsUndoable(messageId: string, agentId: string): Promise<boolean> {
      return yes(db, sql`SELECT EXISTS (SELECT 1 FROM project_messages m JOIN project_conversations c ON c.id = m.conversation_id
        WHERE m.id = ${messageId} AND m.author_agent_id = ${agentId} AND m.attachment_count = 0 AND c.space = 'people') AS found`);
    },

    async removeMessage(input: { messageId: string; agentId: string }): Promise<Removal> {
      return tombstone(input.messageId, input.agentId);
    },

    /** A map the assistant created: empty, not renamed, not cited, and not open in a live session (the server checks that). */
    async removeMap(input: { mapId: string; agentId: string; title: string }): Promise<Removal> {
      const map = await first<{ id: string; scope: string; title: string; agentId: string | null; projectId: string | null }>(db, sql`
        SELECT id, scope, title, created_by_agent_id AS "agentId", project_id AS "projectId" FROM sketches WHERE id = ${input.mapId} FOR UPDATE`);
      if (!map) return gone();
      if (map.scope !== 'project' || map.agentId !== input.agentId || !map.projectId) return foreign();
      if (map.title !== input.title) return used(REMOVAL_REASONS.renamed);
      if (await yes(db, sql`SELECT (EXISTS (SELECT 1 FROM sketch_thoughts WHERE sketch_id = ${map.id}) OR EXISTS (SELECT 1 FROM sketch_links WHERE sketch_id = ${map.id})) AS found`))
        return used(REMOVAL_REASONS.filled);
      if (await cited(map.id, 'other')) return used(REMOVAL_REASONS.cited);
      try {
        await db.execute(sql`DELETE FROM sketches WHERE id = ${map.id}`);
      } catch (error) { if (inUse(error)) return used(REMOVAL_REASONS.cited); throw error; }
      await forgetNotices(map.projectId, map.id);
      return { ok: true, snapshot: { projectId: map.projectId } };
    },

    /** A decision the assistant proposed: still proposed, not edited since, not cited, not parking a task, not superseded or superseding. */
    async removeDecision(input: { decisionId: string; agentId: string; version: number | null }): Promise<Removal> {
      const decision = await first<{ id: string; projectId: string; status: string; version: number; byKind: string; byId: string }>(db, sql`
        SELECT id, project_id AS "projectId", status, version, proposed_by_kind AS "byKind", proposed_by_id AS "byId" FROM project_decisions WHERE id = ${input.decisionId} FOR UPDATE`);
      if (!decision) return gone();
      if (decision.byKind !== 'agent' || decision.byId !== input.agentId) return foreign();
      if (decision.status !== 'proposed') return used(REMOVAL_REASONS.decided);
      if (input.version !== null && decision.version !== input.version) return used(REMOVAL_REASONS.changed);
      if (await cited(decision.id, 'other')) return used(REMOVAL_REASONS.cited);
      if (await yes(db, sql`SELECT (EXISTS (SELECT 1 FROM project_work_items WHERE parked_by_decision_id = ${decision.id})
        OR EXISTS (SELECT 1 FROM project_decisions o WHERE o.id <> ${decision.id} AND (o.supersedes_id = ${decision.id} OR o.superseded_by_id = ${decision.id}))) AS found`))
        return used(REMOVAL_REASONS.cited);
      try {
        await db.execute(sql`DELETE FROM project_object_links WHERE from_id = ${decision.id}`);
        await db.execute(sql`DELETE FROM project_decisions WHERE id = ${decision.id}`);
      } catch (error) { if (inUse(error)) return used(REMOVAL_REASONS.cited); throw error; }
      await forgetNotices(decision.projectId, decision.id);
      return { ok: true, snapshot: { projectId: decision.projectId, version: decision.version } };
    },

    /**
     * A result the assistant recorded: not cited by anything, and the messages that told each task about it (its contribution to the
     * task's discussion) unanswered, uncited and last in their threads. Those messages become tombstones; the task it finished is the
     * server's to put back, in the same transaction.
     */
    async removeResult(input: { resultId: string; agentId: string }): Promise<Removal> {
      const result = await first<{ id: string; projectId: string; byKind: string; byId: string }>(db, sql`
        SELECT id, project_id AS "projectId", created_by_kind AS "byKind", created_by_id AS "byId" FROM project_results WHERE id = ${input.resultId} FOR UPDATE`);
      if (!result) return gone();
      if (result.byKind !== 'agent' || result.byId !== input.agentId) return foreign();
      if (await cited(result.id, 'other')) return used(REMOVAL_REASONS.cited);
      const contributions = (await db.execute(sql`SELECT id FROM project_messages WHERE result_id = ${result.id} ORDER BY id FOR UPDATE`)).rows as { id: string }[];
      for (const message of contributions) {
        const taken = await tombstone(message.id, null);
        if (!taken.ok) return taken.why === 'used' ? taken : used(REMOVAL_REASONS.changed);
      }
      try {
        await db.execute(sql`DELETE FROM project_object_links WHERE from_id = ${result.id}`);
        await db.execute(sql`DELETE FROM project_results WHERE id = ${result.id}`);
      } catch (error) { if (inUse(error)) return used(REMOVAL_REASONS.cited); throw error; }
      await forgetNotices(result.projectId, result.id);
      return { ok: true, snapshot: { projectId: result.projectId, messages: contributions.length } };
    },
  };
}
