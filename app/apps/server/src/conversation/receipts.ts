import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { RECEIPT_LIMITS, type MessageReceiptsResult, type ObserveMessagesResult } from '@flux/contracts';
import { schema, accessPorts, accessReader } from '@flux/db';
import { enforce, evaluateProject, InvalidInputError, listProjectPeople, NotFoundError, RuleViolationError, uuid, type Database, type Principal } from '@flux/core';

// Viewing receipts of the project's conversation (#534). A person observes messages of a project they can read
// now; "Seen by" for one of their own author runs names the people who can read the project NOW and observed every
// message of it. The observation row says nothing about access: the audience is read again for each answer, so a
// grant removed later takes the person out of every answer, whatever they once saw.
//
// Only the people space (the stream of roots and their threads) takes part. A run is checked against the stored
// messages: one author, one level (the roots, or the replies of one conversation), nothing skipped between its ends.

const missing = () => new NotFoundError('Message', 'MESSAGE_NOT_FOUND');

function ids(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new InvalidInputError(`${label} must list 1 to ${max} message ids`);
  const list = value.map((item) => uuid(item, label));
  if (new Set(list).size !== list.length) throw new InvalidInputError(`${label} must not repeat a message`);
  return list;
}

async function facts(tx: Pick<Database, 'select'>, projectId: string, list: string[]) {
  if (!list.length) return [];
  const m = schema.projectMessages;
  const c = schema.projectConversations;
  return tx.select({ id: m.id, authorId: m.authorId, sequence: m.sequence, conversationId: m.conversationId, conversationAt: c.createdAt }).from(m)
    .innerJoin(c, eq(c.id, m.conversationId))
    .where(and(eq(m.projectId, projectId), eq(c.projectId, projectId), eq(c.space, 'people'), inArray(m.id, list)));
}

export function projectReceipts(db: Database) {
  return {
    async observe(principal: Principal, projectId: string, input: { messageIds?: unknown }): Promise<ObserveMessagesResult> {
      if (principal.kind !== 'human') throw missing();
      const list = ids(input?.messageIds, RECEIPT_LIMITS.messagesPerCall, 'messageIds');
      uuid(projectId, 'projectId');
      return db.transaction(async (tx) => {
        // Locked like any change: a grant revoked meanwhile either commits first and is seen, or waits.
        const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, accessReader(tx), { lock: true }), 'project');
        const found = await facts(tx, projectId, list);
        if (found.length !== list.length) throw missing();
        const others = found.filter((row) => row.authorId !== principal.id).map((row) => row.id);
        if (!others.length) return { observed: 0 };
        const written = await tx.insert(schema.projectMessageObservations)
          .values(others.map((messageId) => ({ workspaceId: project!.workspaceId, projectId, messageId, viewerId: principal.id }))).onConflictDoNothing()
          .returning({ id: schema.projectMessageObservations.messageId });
        return { observed: written.length };
      });
    },

    async receipts(principal: Principal, projectId: string, input: { runs?: unknown }): Promise<MessageReceiptsResult> {
      if (principal.kind !== 'human') throw missing();
      if (!Array.isArray(input?.runs) || !input.runs.length || input.runs.length > RECEIPT_LIMITS.runsPerCall) throw new InvalidInputError(`runs must list 1 to ${RECEIPT_LIMITS.runsPerCall} runs`);
      const runs = input.runs.map((run) => ids(run, RECEIPT_LIMITS.messagesPerCall, 'each run'));
      if (runs.reduce((sum, run) => sum + run.length, 0) > RECEIPT_LIMITS.messagesPerQuery) throw new InvalidInputError('Too many messages in one request');
      uuid(projectId, 'projectId');
      return db.transaction(async (tx) => {
        enforce(await evaluateProject(principal, 'project.read', projectId, accessReader(tx)), 'project');
        const known = new Map((await facts(tx, projectId, [...new Set(runs.flat())])).map((row) => [row.id, row]));
        // The people who can read the project now, never anyone from a historical roster.
        const readers = new Map((await listProjectPeople(principal, projectId, tx as unknown as Database, accessPorts)).filter((p) => p.kind === 'human').map((p) => [p.id, p.name]));
        const m = schema.projectMessages;
        const c = schema.projectConversations;
        const result: MessageReceiptsResult['runs'] = [];
        for (const run of runs) {
          const rows = run.map((id) => known.get(id));
          if (rows.some((row) => !row)) throw missing();
          const list = rows as NonNullable<(typeof rows)[number]>[];
          const root = list[0]!.sequence === 1;
          const invalid = () => new RuleViolationError('A run is your own consecutive messages of one place', 'RECEIPT_RUN_INVALID');
          if (list.some((row) => row.authorId !== principal.id || (row.sequence === 1) !== root || (!root && row.conversationId !== list[0]!.conversationId))) throw invalid();
          let between: { id: string }[];
          if (root) {
            // The stream orders roots by (conversation created_at, id): a run holds every root between its ends.
            const ordered = [...list].sort((a, b) => a.conversationAt.getTime() - b.conversationAt.getTime() || a.conversationId.localeCompare(b.conversationId));
            const first = ordered[0]!, last = ordered.at(-1)!;
            between = await tx.select({ id: m.id }).from(m).innerJoin(c, eq(c.id, m.conversationId))
              .where(and(eq(m.projectId, projectId), eq(c.projectId, projectId), eq(c.space, 'people'), eq(m.sequence, 1),
                // Compared in SQL so the ends keep PostgreSQL's microsecond precision.
                sql`(${c.createdAt}, ${c.id}) >= (SELECT f.created_at, f.id FROM project_conversations f WHERE f.id = ${first.conversationId})`,
                sql`(${c.createdAt}, ${c.id}) <= (SELECT l.created_at, l.id FROM project_conversations l WHERE l.id = ${last.conversationId})`));
          } else {
            const from = Math.min(...list.map((row) => row.sequence)), to = Math.max(...list.map((row) => row.sequence));
            between = await tx.select({ id: m.id }).from(m).where(and(eq(m.conversationId, list[0]!.conversationId), sql`${m.sequence} BETWEEN ${from} AND ${to}`)).orderBy(asc(m.sequence));
          }
          if (between.length !== run.length || between.some((row) => !known.has(row.id))) throw new RuleViolationError('A run must list every message between its first and last', 'RECEIPT_RUN_INVALID');
          const o = schema.projectMessageObservations;
          const seen = await tx.select({ viewerId: o.viewerId }).from(o).where(and(eq(o.projectId, projectId), inArray(o.messageId, run), sql`${o.viewerId} <> ${principal.id}`))
            .groupBy(o.viewerId).having(sql`count(distinct ${o.messageId}) = ${run.length}`);
          const seenBy = seen.filter((row) => readers.has(row.viewerId)).map((row) => ({ id: row.viewerId, name: readers.get(row.viewerId)! }))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
          result.push({ messageIds: run, seenBy });
        }
        return { runs: result };
      });
    },
  };
}
