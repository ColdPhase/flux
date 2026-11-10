import { messagePreview } from '@flux/contracts';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { queryPrepared } from '../prepared.js';
import { openAliased, openRows } from '../sealing.js';

/**
 * Drizzle rows for the return view (issue #106). They satisfy the `ReturnRepository` port of
 * `packages/core/src/returns/ports.ts` structurally (this package does not depend on core) and
 * make no access decisions: the core use case authorizes every event before it asks for the
 * objects the event names, and project lists take the policy's `visibleFilter` from the caller.
 */

type Place = { key: string; type: 'home' | 'project' | 'conversation'; projectId: string | null; conversationId: string | null };
const rp = schema.returnPoints;

const pointColumns = { seq: rp.seq, savedAt: rp.savedAt, previousSeq: rp.previousSeq, previousSavedAt: rp.previousSavedAt };

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

const actorKey = (kind: string, id: string) => `${kind}:${id}`;
const actor = (human: string | null, agent: string | null) => human !== null
  ? { kind: 'human' as const, id: human } : { kind: 'agent' as const, id: agent! };

function excerpt(body: string) {
  const line = body.trim().split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** A current version's title and reason, read under the material's id and version (F-030), opened. */
async function openVersionTextWith<T extends { id: string; workspaceId: string; version: number; title: string; reason?: string | null }>(db: DbExecutor, rows: T[]): Promise<T[]> {
  const opened = await openRows(db, 'project_material_versions', rows.map((row) => ({ materialId: row.id, workspaceId: row.workspaceId, version: row.version, title: row.title,
    ...(row.reason !== undefined ? { reason: row.reason } : {}) })));
  return rows.map((row, index) => ({ ...row, title: opened[index]!.title, ...(row.reason !== undefined ? { reason: opened[index]!.reason } : {}) }));
}

/** Structurally core's `AudiencePlace` and `AudienceKinds` (returns/ports.ts); @flux/db does not import @flux/core. */
type AudiencePlace = { projectId: string } | { conversationId: string };
type AudienceKinds = { kinds: string[]; automation: string };
type AudienceRow = { id: string; seq: number | string; kind: string; workspaceId: string | null; objectId: string; actorId: string; data: Record<string, unknown>; createdAt: Date };
const AUDIENCE_COLUMNS = `SELECT e.id, a.seq, e.kind, e.workspace_id AS "workspaceId", e.object_id AS "objectId", e.actor_id AS "actorId", e.data, e.created_at AS "createdAt"
  FROM event_audience a JOIN events e ON e.id = a.event_id WHERE a.recipient = $1 AND a.seq > $2`;
// The rows of a summary's tasks and messages, read as they come (#1178). `due_on` as text, as Drizzle's string mode gives it.
type SummaryWorkRow = { id: string; workspaceId: string; projectId: string; title: string; creationRevertedAt: Date | null; status: string; blocker: string | null;
  ownerUserId: string | null; ownerAgentId: string | null; createdByKind: string; createdById: string; createdAt: Date; dueOn: string | null };
const SUMMARY_WORK = `SELECT id, workspace_id AS "workspaceId", project_id AS "projectId", title, creation_reverted_at AS "creationRevertedAt", status, blocker,
  owner_user_id AS "ownerUserId", owner_agent_id AS "ownerAgentId", created_by_kind AS "createdByKind", created_by_id AS "createdById", created_at AS "createdAt",
  due_on::text AS "dueOn" FROM project_work_items WHERE id = ANY($1::uuid[])`;
type SummaryMessageRow = { id: string; workspaceId: string; projectId: string; conversationId: string; authorId: string | null; authorAgentId: string | null;
  body: string; attachmentCount: number; sequence: number; createdAt: Date; via: string | null };
const SUMMARY_MESSAGES = `SELECT id, workspace_id AS "workspaceId", project_id AS "projectId", conversation_id AS "conversationId", author_id AS "authorId",
  author_agent_id AS "authorAgentId", body, attachment_count AS "attachmentCount", sequence, created_at AS "createdAt", via
  FROM project_messages WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`;

// A space's rows: its own events (their object is the space) and its sketches'; a conversation's: its messages.
const OF_PROJECT = ` AND (e.object_id = $P::uuid OR (e.kind LIKE 'sketch.%' AND EXISTS (SELECT 1 FROM sketches s WHERE s.id = e.object_id AND s.project_id = $P::uuid)))`;
const OF_CONVERSATION = ` AND e.kind IN ('project.conversation_created.v1', 'project.message_sent.v1') AND lower(e.data->>'conversationId') = $P`;

export function returnRows(db: DbExecutor) {
  const openVersionText = <T extends { id: string; workspaceId: string; version: number; title: string; reason?: string | null }>(rows: T[]) => openVersionTextWith(db, rows);
  return {
    async points(userId: string, keys: string[]) {
      if (!keys.length) return new Map();
      const rows = await db.select({ key: rp.placeKey, ...pointColumns }).from(rp).where(and(eq(rp.userId, userId), inArray(rp.placeKey, keys)));
      return new Map(rows.map(({ key, ...point }) => [key, point]));
    },

    /** Forward only: an older or equal position leaves the point (and its previous one) as it is. */
    async advance(userId: string, place: Place, seq: number) {
      const [row] = await db.insert(rp).values({
        userId, placeKey: place.key, placeType: place.type, projectId: place.projectId, conversationId: place.conversationId, seq,
      }).onConflictDoUpdate({
        target: [rp.userId, rp.placeKey],
        set: { seq, savedAt: sql`now()`, previousSeq: sql`${rp.seq}`, previousSavedAt: sql`${rp.savedAt}` },
        setWhere: sql`${rp.seq} < ${seq}`,
      }).returning(pointColumns);
      if (row) return row;
      const [current] = await db.select(pointColumns).from(rp).where(and(eq(rp.userId, userId), eq(rp.placeKey, place.key)));
      return current!;
    },

    async restore(userId: string, key: string) {
      const [row] = await db.update(rp).set({ seq: sql`${rp.previousSeq}`, savedAt: sql`${rp.previousSavedAt}`, previousSeq: null, previousSavedAt: null })
        .where(and(eq(rp.userId, userId), eq(rp.placeKey, key), sql`${rp.previousSeq} IS NOT NULL`)).returning(pointColumns);
      if (row) return row;
      // A point first saved in the visit being undone had no previous one: the place is unviewed again.
      await db.delete(rp).where(and(eq(rp.userId, userId), eq(rp.placeKey, key), sql`${rp.previousSeq} IS NULL`));
      return null;
    },

    /**
     * The recipient's own audience rows after `afterSeq`, newest first, by primary key. A constant prepared statement, its rows read as
     * they come (#1178): "Since you left" reads up to 400 of them on every Home and space it opens, and Drizzle's mapping of each cell
     * was most of what that read cost.
     */
    async audienceAfter(recipient: string, afterSeq: number, limit: number, beforeSeq: number | null = null, place: AudiencePlace | null = null,
      of: AudienceKinds | null = null) {
      const values: unknown[] = [recipient, afterSeq, limit];
      const next = (value: unknown) => { values.push(value); return `$${values.length}`; };
      let text = AUDIENCE_COLUMNS;
      if (beforeSeq !== null) text += ` AND a.seq < ${next(beforeSeq)}`;
      if (place) text += ('projectId' in place ? OF_PROJECT : OF_CONVERSATION).replaceAll('$P', next('projectId' in place ? place.projectId : place.conversationId));
      if (of) text += ` AND e.workspace_id IS NOT NULL AND e.kind = ANY(${next(of.kinds)}::text[]) AND (e.actor_id <> $1 OR e.data->>'automation' = ${next(of.automation)})`;
      const { rows } = await queryPrepared<AudienceRow>(db, `${text} ORDER BY a.seq DESC LIMIT $3`, values);
      return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
    },

    async audienceSeq(recipient: string, eventId: string) {
      const [row] = await db.select({ seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(and(eq(schema.eventAudience.recipient, recipient), eq(schema.eventAudience.eventId, eventId)));
      return row?.seq ?? null;
    },

    async lastEvent(recipient: string) {
      const [row] = await db.select({ id: schema.eventAudience.eventId, seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(eq(schema.eventAudience.recipient, recipient)).orderBy(desc(schema.eventAudience.seq)).limit(1);
      return row ?? null;
    },

    /** Ids of the workspace's projects that pass `visible` (the policy's list condition). */
    async projectIdsWhere(workspaceId: string, visible: SQL) {
      const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), visible));
      return new Set(rows.map((row) => row.id));
    },

    /** The project of a conversation, whoever may read it; callers must authorize before using it. */
    async conversationProject(id: string) {
      const [row] = await db.select({ projectId: schema.projectConversations.projectId }).from(schema.projectConversations).where(eq(schema.projectConversations.id, id));
      return row?.projectId ?? null;
    },

    async projects(ids: string[]) {
      if (!ids.length) return new Map();
      const rows = await openRows(db, 'projects', await db.select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId, name: schema.projects.name })
        .from(schema.projects).where(inArray(schema.projects.id, ids)));
      return byId(rows.map(({ id, name }) => ({ id, name })));
    },

    async work(ids: string[]) {
      if (!ids.length) return new Map();
      // Only the columns the summary says something with, as a constant prepared statement (#1178): a summary reads up to a few hundred.
      const rows = await openRows(db, 'project_work_items', (await queryPrepared<SummaryWorkRow>(db, SUMMARY_WORK, [ids])).rows);
      return byId(rows.map((row) => ({
        id: row.id, projectId: row.projectId, title: row.creationRevertedAt ? `${row.title} · creation undone` : row.title, status: row.status, blocker: row.blocker,
        ownerKey: row.ownerUserId ? actorKey('human', row.ownerUserId) : row.ownerAgentId ? actorKey('agent', row.ownerAgentId) : null,
        createdByKey: actorKey(row.createdByKind, row.createdById), createdAt: row.createdAt,
        dueOn: row.dueOn ?? null,
      })));
    },

    async decisions(ids: string[]) {
      if (!ids.length) return new Map();
      const d = schema.projectDecisions;
      const rows = await openRows(db, 'project_decisions', await db.select({ id: d.id, workspaceId: d.workspaceId, projectId: d.projectId, title: d.title,
        rationale: d.rationale, status: d.status, proposedByKind: d.proposedByKind, proposedById: d.proposedById, supersedesId: d.supersedesId,
        supersededById: d.supersededById }).from(d).where(inArray(d.id, ids)));
      return byId(rows.map((row) => ({
        id: row.id, projectId: row.projectId, title: row.title, rationale: row.rationale, status: row.status,
        proposedByKey: actorKey(row.proposedByKind, row.proposedById), supersedesId: row.supersedesId, supersededById: row.supersededById,
      })));
    },

    async messages(ids: string[]) {
      if (!ids.length) return new Map();
      const rows = await openRows(db, 'project_messages', (await queryPrepared<SummaryMessageRow>(db, SUMMARY_MESSAGES, [ids])).rows);
      return byId(rows.map(({ authorId, authorAgentId, id, projectId, conversationId, body, attachmentCount, sequence, createdAt, via }) =>
        ({ id, projectId, conversationId, body, attachmentCount, sequence, createdAt, via, author: actor(authorId, authorAgentId) })));
    },

    async conversations(ids: string[]) {
      if (!ids.length) return new Map();
      const c = schema.projectConversations;
      const m = schema.projectMessages;
      const read = await db.select({ id: c.id, workspaceId: c.workspaceId, projectId: c.projectId, createdBy: c.createdBy, createdByAgentId: c.createdByAgentId, openingId: m.id, opening: m.body, attachmentCount: m.attachmentCount }).from(c)
        .leftJoin(m, and(eq(m.conversationId, c.id), eq(m.sequence, 1))).where(inArray(c.id, ids));
      const rows = await openAliased(db, read, { table: 'project_messages', column: 'body', key: 'opening', workspace: (row) => row.workspaceId,
        identity: (row) => (row.openingId ? [row.openingId] : null) });
      return byId(rows.map(({ createdBy, createdByAgentId, id, projectId, opening, attachmentCount }) => ({ id, projectId, attachmentCount,
        createdBy: actor(createdBy, createdByAgentId), opening: excerpt(messagePreview(opening ?? '', attachmentCount ?? 0)) })));
    },

    async lastPosts(userId: string, conversationIds: string[]) {
      if (!conversationIds.length) return new Map();
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.conversationId, at: sql<Date>`max(${m.createdAt})`.mapWith((value) => new Date(value as string)) })
        .from(m).where(and(eq(m.authorId, userId), inArray(m.conversationId, conversationIds))).groupBy(m.conversationId);
      return new Map(rows.map((row) => [row.id, row.at]));
    },

    async materials(ids: string[]) {
      if (!ids.length) return new Map();
      const pm = schema.projectMaterials;
      const v = schema.projectMaterialVersions;
      const read = await db.select({ id: pm.id, workspaceId: pm.workspaceId, projectId: pm.projectId, title: v.title, version: pm.currentVersion }).from(pm)
        .innerJoin(v, and(eq(v.materialId, pm.id), eq(v.version, pm.currentVersion))).where(inArray(pm.id, ids));
      const rows = await openVersionText(read);
      return byId(rows.map(({ id, projectId, title, version }) => ({ id, projectId, title, version })));
    },

    /** Project docs (#112): materials of kind 'doc' with their current version's title and reason. */
    async docs(ids: string[]) {
      if (!ids.length) return new Map();
      const pm = schema.projectMaterials;
      const v = schema.projectMaterialVersions;
      const read = await db.select({ id: pm.id, workspaceId: pm.workspaceId, projectId: pm.projectId, title: v.title, version: pm.currentVersion, reason: v.reason }).from(pm)
        .innerJoin(v, and(eq(v.materialId, pm.id), eq(v.version, pm.currentVersion))).where(and(inArray(pm.id, ids), eq(pm.kind, 'doc')));
      const rows = await openVersionText(read);
      return byId(rows.map(({ id, projectId, title, version, reason }) => ({ id, projectId, title, version, reason })));
    },

    async sketches(ids: string[]) {
      if (!ids.length) return new Map();
      const s = schema.sketches;
      return byId(await openRows(db, 'sketches', await db.select({ id: s.id, workspaceId: s.workspaceId, projectId: s.projectId, title: s.title }).from(s).where(inArray(s.id, ids))));
    },

    async names(keys: string[]) {
      const humans = keys.filter((item) => item.startsWith('human:')).map((item) => item.slice(6));
      const agents = keys.filter((item) => item.startsWith('agent:')).map((item) => item.slice(6)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const names = new Map<string, string>();
      if (humans.length) for (const row of await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, humans))) names.set(`human:${row.id}`, row.name);
      if (agents.length) for (const row of await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents))) names.set(`agent:${row.id}`, row.name);
      return names;
    },
  };
}
