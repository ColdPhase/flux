import { messagePreview } from '@flux/contracts';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { agentThreadGuardRows, fileRows, schema, taskDiscussionRows, taskUseRows, workRows } from '@flux/db';
import type {
  Conversation, ConversationMessage, ConversationRootWindow, ConversationSummary, Material, MaterialOrDoc,
  AgentProjectOwner, AuthenticatedAgentRuntime, MaterialVersion, Page, PageQuery, TaskAgentThread,
} from '@flux/contracts';
import {
  ConflictError, conversationUseCases, enforce, evaluateDraft, evaluateProject, InvalidInputError, NotFoundError,
  lockAttachments, messageContribution, positiveVersion, uuid, type FileStorage,
  parsePage, recordEvent, ServiceUnavailableError, type Database, type Principal, type Transaction,
} from '@flux/core';
import type { AgentThreadWindow, AgentThreadPost, ConversationPort } from '@flux/core';
import { eventPorts } from '../events.js';
import { projectAuthorOwners } from './author-owners.js';
import type { TransactionEventSession } from '../work/transaction-events.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;
type ConversationRow = typeof schema.projectConversations.$inferSelect;
type MessageRow = typeof schema.projectMessages.$inferSelect;
type MaterialRow = typeof schema.projectMaterials.$inferSelect;
type VersionRow = typeof schema.projectMaterialVersions.$inferSelect;
type Actor = { kind: 'human' | 'agent'; id: string };
type MessageEventKind = 'project.conversation_created.v1' | 'project.message_sent.v1' | 'project.agent_thread_message_sent.v1';
/** Where a committed start or reply records its one event. */
export interface ConversationEventLog {
  record(principal: Principal, workspaceId: string, kind: MessageEventKind, projectId: string,
    data: { conversationId: string; messageId: string }): Promise<void>;
}
export interface ConversationStoreOptions {
  storage?: FileStorage;
  /** A composing caller's event collector (one final batch); by default each command records its event inline. */
  events?: ConversationEventLog;
  /**
   * Accept an agent principal as the real author of a start or reply. Only the #152 standing-grant composition
   * sets it; the person-facing routes keep requiring a signed-in person. Materials stay person-written.
   */
  agentAuthors?: boolean;
}

function human(principal: Principal): string {
  if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

function authorOf(principal: Principal, agentAuthors: boolean): Actor {
  if (principal.kind === 'agent' && agentAuthors) return { kind: 'agent', id: uuid(principal.id, 'agentId').toLowerCase() };
  return { kind: 'human', id: human(principal) };
}

function creator(row: ConversationRow, names: Map<string, string>) {
  return row.createdBy !== null ? { createdBy: row.createdBy } : { createdBy: null,
    createdByActor: { kind: 'agent' as const, id: row.createdByAgentId!, name: names.get(`agent:${row.createdByAgentId}`) ?? 'Agent' } };
}
function message(row: MessageRow & { files?: import('@flux/contracts').MessageFile[] }, names: Map<string, string> = new Map(), owners: ReadonlyMap<string, AgentProjectOwner> = new Map()): ConversationMessage {
  const contribution = messageContribution(row.contributionKind, row.resultId);
  return { id: row.id, conversationId: row.conversationId, ...(row.authorId !== null ? { authorId: row.authorId } : { authorId: null,
    author: { kind: 'agent' as const, id: row.authorAgentId!, name: names.get(`agent:${row.authorAgentId}`) ?? 'Agent',
      ...(owners.has(row.authorAgentId!) ? { projectOwner: owners.get(row.authorAgentId!)! } : {}) } }), body: row.body,
    source: row.sourceMaterialId && row.sourceMaterialVersion ? { materialId: row.sourceMaterialId, version: row.sourceMaterialVersion } : null,
    sequence: row.sequence, createdAt: row.createdAt.toISOString(), ...(contribution ? { contribution } : {}), ...(row.files?.length ? { files: row.files } : {}) };
}


function versionFields(row: VersionRow, principal: Principal) {
  return { materialId: row.materialId, version: row.version, title: row.title, body: row.body, url: row.url,
    sourceDraft: principal.kind === 'human' && row.authorId !== null && principal.id === row.authorId && row.sourceDraftId && row.sourceDraftVersion
      ? { id: row.sourceDraftId, version: row.sourceDraftVersion } : null,
    createdAt: row.createdAt.toISOString() };
}

/** The actual author: a person, or the agent that wrote a doc version under a standing grant (#152). */
function version(row: VersionRow, principal: Principal, names: Map<string, string> = new Map()): MaterialVersion {
  if (row.authorId !== null) return { ...versionFields(row, principal), authorId: row.authorId };
  return { ...versionFields(row, principal), authorId: null,
    author: { kind: 'agent', id: row.authorAgentId!, name: names.get(`agent:${row.authorAgentId}`) ?? 'Agent' } };
}

const materialFields = (row: MaterialRow) => ({ kind: row.kind, projectId: row.projectId, workspaceId: row.workspaceId,
  audience: { kind: 'project' as const, projectId: row.projectId },
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

/** A plain #36 material: always person-written (the database refuses an agent author outside docs). */
function material(row: MaterialRow, current: VersionRow, principal: Principal): Material {
  if (current.authorId === null) throw new Error('A project material version must have a human author');
  return { ...versionFields(current, principal), authorId: current.authorId, ...materialFields(row) };
}

function materialOrDoc(row: MaterialRow, current: VersionRow, principal: Principal, names: Map<string, string>): MaterialOrDoc {
  return { ...version(current, principal, names), ...materialFields(row) };
}

const versionAuthors = (db: Executor, rows: VersionRow[]) => workRows(db).names(rows.filter((row) => row.authorAgentId !== null)
  .map((row) => ({ kind: 'agent' as const, id: row.authorAgentId! })));

async function requireProject(principal: Principal, projectId: string, db: Executor, write = false, lock = false) {
  uuid(projectId, 'projectId');
  const checked = enforce(await evaluateProject(principal, write ? 'project.write' : 'project.read', projectId, db, { lock }), 'project');
  return checked.project!;
}

async function locateConversation(principal: Principal, conversationId: string, db: Executor, write = false, lock = false): Promise<ConversationRow> {
  uuid(conversationId, 'conversationId');
  const [row] = await db.select().from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
  if (!row) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
  await requireProject(principal, row.projectId, db, write, lock);
  if (write && row.space === 'agents' && principal.kind === 'agent') {
    // Existing people-space v1 replies stay unchanged. No new-space writer is enabled before AC-7.
    throw new ServiceUnavailableError('Agent-thread posting is not available to agents yet', 'AGENT_EXECUTION_UNAVAILABLE');
  }
  return row;
}

async function locateThreadTask(principal: Principal, taskId: string, db: Executor, write = false, lock = false) {
  const [task] = await db.select().from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, taskId));
  if (!task) throw new NotFoundError('Task', 'WORK_NOT_FOUND');
  try { await requireProject(principal, task.projectId, db, write, lock); }
  catch (error) {
    // Task-only routes must not distinguish an invisible task from an absent one.
    if (error instanceof NotFoundError) throw new NotFoundError('Task', 'WORK_NOT_FOUND');
    throw error;
  }
  return task;
}

async function locateMaterial(principal: Principal, materialId: string, db: Executor, write = false, lock = false): Promise<MaterialRow> {
  uuid(materialId, 'materialId');
  const [row] = await db.select().from(schema.projectMaterials).where(eq(schema.projectMaterials.id, materialId));
  if (!row) throw new NotFoundError('Material', 'MATERIAL_NOT_FOUND');
  await requireProject(principal, row.projectId, db, write, lock);
  return row;
}

async function currentVersion(row: MaterialRow, db: Executor): Promise<VersionRow> {
  const [current] = await db.select().from(schema.projectMaterialVersions).where(and(
    eq(schema.projectMaterialVersions.materialId, row.id), eq(schema.projectMaterialVersions.version, row.currentVersion)));
  if (!current) throw new Error('Material current version missing');
  return current;
}

/**
 * The first and the last message of each conversation, in one statement however many a page has
 * (#298): two index probes per conversation instead of two queries, which used to take every
 * pooled connection at once for a page of 100.
 */
async function conversationEnds(ids: string[], db: Executor) {
  const ends = new Map<string, { firstBody: string; firstAttachments: number; lastBody: string; lastAttachments: number; lastAt: Date }>();
  if (!ids.length) return ends;
  const wanted = sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `);
  const result = await db.execute<{ id: string; first_body: string; first_attachments: number; last_body: string; last_attachments: number; last_at: Date | string }>(sql`
    SELECT c.id, f.body AS first_body, f.attachment_count AS first_attachments, l.body AS last_body, l.attachment_count AS last_attachments, l.created_at AS last_at
    FROM (VALUES ${wanted}) AS c(id)
    JOIN LATERAL (SELECT m.body, m.attachment_count FROM project_messages m WHERE m.conversation_id = c.id ORDER BY m.sequence ASC LIMIT 1) f ON true
    JOIN LATERAL (SELECT m.body, m.attachment_count, m.created_at FROM project_messages m WHERE m.conversation_id = c.id ORDER BY m.sequence DESC LIMIT 1) l ON true`);
  for (const row of result.rows) {
    ends.set(row.id, { firstBody: row.first_body, firstAttachments: Number(row.first_attachments), lastBody: row.last_body,
      lastAttachments: Number(row.last_attachments), lastAt: new Date(row.last_at) });
  }
  return ends;
}

/** The current version of each row, in one statement however many rows a page has (#298). */
async function currentVersions(rows: MaterialRow[], db: Executor): Promise<VersionRow[]> {
  if (!rows.length) return [];
  const v = schema.projectMaterialVersions;
  const wanted = sql.join(rows.map((row) => sql`(${row.id}::uuid, ${row.currentVersion}::int)`), sql`, `);
  const found = await db.select().from(v).where(sql`(${v.materialId}, ${v.version}) IN (${wanted})`);
  const byMaterial = new Map(found.map((version) => [version.materialId, version]));
  return rows.map((row) => {
    const current = byMaterial.get(row.id);
    if (!current || current.version !== row.currentVersion) throw new Error('Material current version missing');
    return current;
  });
}

async function sourceExists(projectId: string, source: { materialId: string; version: number } | null, db: Executor) {
  if (!source) return;
  const [row] = await db.select({ materialId: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
    .where(and(eq(schema.projectMaterialVersions.projectId, projectId),
      eq(schema.projectMaterialVersions.materialId, source.materialId), eq(schema.projectMaterialVersions.version, source.version)));
  if (!row) throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
}

async function existingMessage(projectId: string, author: Actor, clientMessageId: string, db: Executor) {
  const [row] = await db.select().from(schema.projectMessages).where(and(
    eq(schema.projectMessages.projectId, projectId),
    author.kind === 'human' ? eq(schema.projectMessages.authorId, author.id) : eq(schema.projectMessages.authorAgentId, author.id),
    eq(schema.projectMessages.clientMessageId, clientMessageId)));
  return row;
}

async function lockIdempotency(tx: Tx, projectId: string, author: Actor, clientId: string) {
  // Serializes same-key first sends before a thread is created. The uniqueness constraint
  // remains the final guard; hash collisions only serialize unrelated sends. Same namespace
  // as task contributions (`taskDiscussionRows.lockCommand`).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${projectId.toLowerCase()}:${author.kind}:${author.id}:${clientId.toLowerCase()}`}))`);
}

async function sendInTransaction(tx: Tx, conversation: ConversationRow, author: Actor, input: Parameters<ConversationPort['sendMessage']>[2], files?: import('@flux/contracts').MessageFile[]): Promise<{ message: ConversationMessage; inserted: boolean }> {
  const names = author.kind === 'agent' ? await workRows(tx).names([author]) : new Map<string, string>();
  const existing = await existingMessage(conversation.projectId, author, input.clientMessageId, tx);
  if (existing) {
    if (existing.requestFingerprint !== input.fingerprint || existing.conversationId !== conversation.id)
      throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
    return { message: message({ ...existing, files: (await fileRows(tx).messageFiles([existing.id])).get(existing.id) }, names), inserted: false };
  }
  await sourceExists(conversation.projectId, input.source, tx);
  const inserted = await taskDiscussionRows(tx).append(conversation, author, { ...input, files });
  return { message: message(inserted, names), inserted: true };
}

export function conversationStore(db: Database, options: ConversationStoreOptions = {}) {
  const agentAuthors = options.agentAuthors === true;
  const attachments = async (tx: Tx, projectId: string, author: Actor, ids: readonly string[]) => {
    if (!ids.length) return [];
    if (!options.storage) throw new InvalidInputError('Files are unavailable from this entry point', 'AGENT_FILES_UNAVAILABLE');
    return (await lockAttachments(fileRows(tx), options.storage, projectId.toLowerCase(), author, ids, () => new Date()))
      .map((row) => ({ id: row.id, name: row.name, size: row.size! }));
  };
  const eventLog = (tx: Tx): ConversationEventLog => options.events ?? { record: async (principal, workspaceId, kind, projectId, data) => {
    await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data);
  } };
  return {
    async getAgentThread(principal: Principal, taskId: string, window: AgentThreadWindow): Promise<TaskAgentThread> {
      // Access, task, count, page and all author/file reads are one coherent observation.
      // The existing v1 conversation entry keeps its behavior; only this new GET supplies a snapshot.
      return db.transaction(async (tx) => {
        const task = await locateThreadTask(principal, taskId, tx);
        const write = await evaluateProject(principal, 'project.write', task.projectId, tx);
        const [thread] = await tx.select({ id: schema.projectConversations.id }).from(schema.projectConversations)
          .where(and(eq(schema.projectConversations.workId, task.id), eq(schema.projectConversations.space, 'agents')));
        const [count] = thread ? await tx.select({ total: sql<number>`count(*)::int` }).from(schema.projectMessages)
          .where(eq(schema.projectMessages.conversationId, thread.id)) : [];
        const canWrite = principal.kind === 'human' && write.allowed && task.creationRevertedAt === null;
        return { task: { id: task.id, projectId: task.projectId, number: task.number, title: task.title },
          conversation: thread ? await conversationStore(tx, options).getConversation(principal, thread.id, window) : null,
          messageCount: count?.total ?? 0, canWrite, postingAvailable: canWrite };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },
    async postAgentThread(principal: Principal, taskId: string, input: AgentThreadPost): Promise<ConversationMessage> {
      return db.transaction(async (tx) => {
        const task = await locateThreadTask(principal, taskId, tx, true, true);
        if (input.projectId !== null && input.projectId !== task.projectId)
          throw new InvalidInputError('The task does not belong to this project');
        if (principal.kind !== 'human')
          throw new ServiceUnavailableError('Agent-thread posting is not available to agents yet', 'AGENT_EXECUTION_UNAVAILABLE');
        const author = authorOf(principal, false);
        await lockIdempotency(tx, task.projectId, author, input.clientMessageId);
        const existing = await existingMessage(task.projectId, author, input.clientMessageId, tx);
        // File/material locks and source discovery precede the graph/task fence, as in #394.
        const files = existing ? undefined : await attachments(tx, task.projectId, author, input.attachmentIds);
        await sourceExists(task.projectId, input.source, tx);
        const sourceRefs = input.source ? [{ type: 'material', id: input.source.materialId }] : [];
        const sourceTasks = await workRows(tx).taskUseTargets(sourceRefs);
        const targets = [...new Set([task.id, ...sourceTasks])].sort();
        // The actual shared #394 fence owns graph/task order and refuses undone targets.
        const fence = await taskUseRows(tx).prepare(targets);
        const retainedTargets = [...new Set([task.id, ...await workRows(tx).taskUseTargets(sourceRefs)])].sort();
        if (JSON.stringify(retainedTargets) !== JSON.stringify(targets))
          throw new ConflictError('Task references changed; retry from current details', 'TASK_TARGET_SET_CHANGED');
        let [thread] = await tx.select().from(schema.projectConversations)
          .where(and(eq(schema.projectConversations.workId, task.id), eq(schema.projectConversations.space, 'agents')));
        if (!thread) {
          [thread] = await tx.insert(schema.projectConversations).values({ id: randomUUID(),
            workspaceId: task.workspaceId, projectId: task.projectId, space: 'agents', workId: task.id,
            createdBy: author.id, createdByAgentId: null }).returning();
        }
        const sent = await sendInTransaction(tx, thread!, author, input, files);
        if (sent.inserted) {
          await fence.mark();
          await eventLog(tx).record(principal, task.workspaceId, 'project.agent_thread_message_sent.v1', task.projectId,
            { conversationId: thread!.id, messageId: sent.message.id });
        }
        return sent.message;
      });
    },
    async listConversations(principal: Principal, projectId: string, query: PageQuery = {}): Promise<Page<ConversationSummary>> {
      const page = parsePage(query);
      await requireProject(principal, projectId, db);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projectConversations)
        .where(and(eq(schema.projectConversations.projectId, projectId), eq(schema.projectConversations.space, 'people')));
      const rows = await db.select().from(schema.projectConversations).where(and(eq(schema.projectConversations.projectId, projectId), eq(schema.projectConversations.space, 'people')))
        .orderBy(desc(schema.projectConversations.createdAt), desc(schema.projectConversations.id))
        .limit(page.limit).offset(page.offset);
      const names = await workRows(db).names(rows.filter((row) => row.createdByAgentId !== null)
        .map((row) => ({ kind: 'agent' as const, id: row.createdByAgentId! })));
      const ends = await conversationEnds(rows.map((row) => row.id), db);
      const items = rows.map((row) => {
        const end = ends.get(row.id);
        return { id: row.id, projectId: row.projectId, ...creator(row, names), createdAt: row.createdAt.toISOString(),
          firstMessageBody: messagePreview(end?.firstBody ?? '', end?.firstAttachments ?? 0), lastMessageAt: end?.lastAt?.toISOString() ?? row.createdAt.toISOString(),
          lastMessageBody: messagePreview(end?.lastBody ?? '', end?.lastAttachments ?? 0) };
      });
      return { items, total: count?.total ?? 0, ...page };
    },

    /**
     * The project's one stream (UI116-1, 2026-10-02): each stored conversation's opening message,
     * newest first by (created_at, id) and returned oldest first, with its thread's size. Current
     * project access, the cursor, the counts and the page come from one snapshot (a read-only
     * repeatable-read transaction), so a grant revoked meanwhile cannot leave a partly authorized
     * window behind; every root of the project shares the project audience, so nothing is filtered
     * after the page is cut. No row locks (#298): share-locking the access rows made every read of
     * the stream write WAL and wait for its flush at commit.
     */
    async listRoots(principal: Principal, projectId: string, window: Parameters<ConversationPort['listRoots']>[2]): Promise<ConversationRootWindow> {
      return db.transaction(async (tx) => {
        const authorizedProject = await requireProject(principal, projectId, tx);
        const conversations = schema.projectConversations;
        let before: SQL | undefined;
        if (window.before !== null) {
          const [cursor] = await tx.select({ id: conversations.id }).from(conversations)
            .where(and(eq(conversations.id, window.before), eq(conversations.projectId, projectId), eq(conversations.space, 'people')));
          if (!cursor) throw new InvalidInputError('before must be a conversation of this project');
          // Compared in SQL so the cursor keeps PostgreSQL's microsecond precision.
          before = sql`(${conversations.createdAt}, ${conversations.id}) < (SELECT c.created_at, c.id FROM project_conversations c WHERE c.id = ${window.before})`;
        }
        const discussions = schema.projectTaskDiscussions;
        const rows = await tx.select({
          root: schema.projectMessages,
          replyCount: sql<number>`(SELECT count(*)::int FROM project_messages r WHERE r.conversation_id = ${conversations.id} AND r.sequence > 1)`,
          lastReplyAt: sql<string | null>`(SELECT max(r.created_at) FROM project_messages r WHERE r.conversation_id = ${conversations.id} AND r.sequence > 1)`,
          taskId: discussions.workId,
          taskTitle: schema.projectWorkItems.title,
          taskNumber: schema.projectWorkItems.number,
        }).from(conversations)
          .innerJoin(schema.projectMessages, and(eq(schema.projectMessages.conversationId, conversations.id), eq(schema.projectMessages.sequence, 1)))
          // A task's discussion is a conversation of the same project, so it shares the audience checked above.
          .leftJoin(discussions, eq(discussions.conversationId, conversations.id))
          .leftJoin(schema.projectWorkItems, and(eq(schema.projectWorkItems.id, discussions.workId), eq(schema.projectWorkItems.projectId, projectId)))
          .where(and(eq(conversations.projectId, projectId), eq(conversations.space, 'people'), before))
          .orderBy(desc(conversations.createdAt), desc(conversations.id))
          .limit(window.limit + 1);
        const hasMoreBefore = rows.length > window.limit;
        const page = rows.slice(0, window.limit).reverse();
        const names = await workRows(tx).names(page.filter((row) => row.root.authorAgentId !== null)
          .map((row) => ({ kind: 'agent' as const, id: row.root.authorAgentId! })));
        const files = await fileRows(tx).messageFiles(page.map((row) => row.root.id));
        const owners = await projectAuthorOwners(tx, projectId, authorizedProject.workspaceId, page.flatMap((row) => row.root.authorAgentId ? [row.root.authorAgentId] : []));
        const roots = page.map((row) => ({ conversationId: row.root.conversationId, message: message({ ...row.root, files: files.get(row.root.id) }, names, owners), replyCount: Number(row.replyCount),
          lastReplyAt: row.lastReplyAt === null ? null : new Date(row.lastReplyAt).toISOString(),
          ...(row.taskId !== null && row.taskTitle !== null && row.taskNumber !== null ? { task: { workId: row.taskId, title: row.taskTitle, number: row.taskNumber } } : {}) }));
        return { projectId, roots, rootPage: { hasMoreBefore, nextBefore: hasMoreBefore ? roots[0]!.conversationId : null, limit: window.limit } };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async getConversation(principal: Principal, conversationId: string, window: Parameters<ConversationPort['getConversation']>[2]): Promise<Conversation> {
      const row = await locateConversation(principal, conversationId, db);
      const rows = await db.select().from(schema.projectMessages)
        .where(and(eq(schema.projectMessages.conversationId, row.id),
          window.beforeSequence === null ? undefined : lt(schema.projectMessages.sequence, window.beforeSequence)))
        .orderBy(desc(schema.projectMessages.sequence)).limit(window.limit + 1);
      const hasMoreBefore = rows.length > window.limit;
      const names = await workRows(db).names([row.createdByAgentId, ...rows.map((item) => item.authorAgentId)]
        .filter((actorId): actorId is string => actorId !== null).map((actorId) => ({ kind: 'agent' as const, id: actorId })));
      const files = await fileRows(db).messageFiles(rows.map((item) => item.id));
      const selected = rows.slice(0, window.limit).reverse();
      const owners = await projectAuthorOwners(db, row.projectId, row.workspaceId, selected.flatMap((item) => item.authorAgentId ? [item.authorAgentId] : []));
      const messages = selected.map((item) => message({ ...item, files: files.get(item.id) }, names, owners));
      const openingInWindow = messages.find((item) => item.sequence === 1);
      const [opening] = openingInWindow ? [] : await db.select({ body: schema.projectMessages.body, attachmentCount: schema.projectMessages.attachmentCount }).from(schema.projectMessages)
        .where(eq(schema.projectMessages.conversationId, row.id)).orderBy(asc(schema.projectMessages.sequence)).limit(1);
      const [task] = await db.select({ workId: schema.projectTaskDiscussions.workId, title: schema.projectWorkItems.title }).from(schema.projectTaskDiscussions)
        .innerJoin(schema.projectWorkItems, and(eq(schema.projectWorkItems.id, schema.projectTaskDiscussions.workId),
          eq(schema.projectWorkItems.projectId, row.projectId), eq(schema.projectWorkItems.workspaceId, row.workspaceId)))
        .innerJoin(schema.projectMessages, and(eq(schema.projectMessages.id, schema.projectTaskDiscussions.rootMessageId),
          eq(schema.projectMessages.conversationId, row.id), eq(schema.projectMessages.projectId, row.projectId),
          eq(schema.projectMessages.workspaceId, row.workspaceId), eq(schema.projectMessages.sequence, 1)))
        .where(and(eq(schema.projectTaskDiscussions.conversationId, row.id), eq(schema.projectTaskDiscussions.projectId, row.projectId),
          eq(schema.projectTaskDiscussions.workspaceId, row.workspaceId)));
      return { id: row.id, projectId: row.projectId, workspaceId: row.workspaceId,
        audience: { kind: 'project', projectId: row.projectId }, ...creator(row, names),
        ...(task ? { task } : {}),
        createdAt: row.createdAt.toISOString(), firstMessageBody: messagePreview(openingInWindow?.body ?? opening?.body ?? '', openingInWindow?.files?.length ?? opening?.attachmentCount ?? 0), messages,
        messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? messages[0]!.sequence : null, limit: window.limit } };
    },

    async createConversation(principal: Principal, projectId: string, input: Parameters<ConversationPort['createConversation']>[2]): Promise<Conversation> {
      const author = authorOf(principal, agentAuthors);
      return db.transaction(async (tx) => {
        const project = await requireProject(principal, projectId, tx, true, true);
        await lockIdempotency(tx, projectId, author, input.clientMessageId);
        const names = author.kind === 'agent' ? await workRows(tx).names([author]) : new Map<string, string>();
        const existing = await existingMessage(projectId, author, input.clientMessageId, tx);
        if (existing) {
          if (existing.requestFingerprint !== input.fingerprint || existing.sequence !== 1)
            throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
          const row = await locateConversation(principal, existing.conversationId, tx);
          return { id: row.id, projectId: row.projectId, workspaceId: row.workspaceId,
            audience: { kind: 'project' as const, projectId: row.projectId }, ...creator(row, names),
            createdAt: row.createdAt.toISOString(), firstMessageBody: messagePreview(existing.body, existing.attachmentCount), messages: [message({ ...existing, files: (await fileRows(tx).messageFiles([existing.id])).get(existing.id) }, names)],
            messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } };
        }
        await sourceExists(projectId, input.source, tx);
        const files = await attachments(tx, projectId, author, input.attachmentIds);
        const [row] = await tx.insert(schema.projectConversations).values({
          id: randomUUID(), workspaceId: project.workspaceId, projectId,
          createdBy: author.kind === 'human' ? author.id : null, createdByAgentId: author.kind === 'agent' ? author.id : null,
        }).returning();
        const first = await sendInTransaction(tx, row!, author, input, files);
        if (first.inserted) await eventLog(tx).record(principal, project.workspaceId, 'project.conversation_created.v1', projectId, { conversationId: row!.id, messageId: first.message.id });
        return { id: row!.id, projectId, workspaceId: project.workspaceId,
          audience: { kind: 'project' as const, projectId }, ...creator(row!, names),
          createdAt: row!.createdAt.toISOString(), firstMessageBody: messagePreview(first.message.body, first.message.files?.length), messages: [first.message],
          messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } };
      });
    },

    async sendMessage(principal: Principal, conversationId: string, input: Parameters<ConversationPort['sendMessage']>[2]): Promise<ConversationMessage> {
      const author = authorOf(principal, agentAuthors);
      return db.transaction(async (tx) => {
        const row = await locateConversation(principal, conversationId, tx, true, true);
        await lockIdempotency(tx, row.projectId, author, input.clientMessageId);
        const existing = await existingMessage(row.projectId, author, input.clientMessageId, tx);
        const files = existing ? undefined : await attachments(tx, row.projectId, author, input.attachmentIds);
        // A reply to a task's bound conversation enters the task order (access, command identity, task row,
        // conversation sequence), exactly like a contribution; it never takes the conversation first.
        await taskDiscussionRows(tx).lockBoundTask(row.id);
        const sent = await sendInTransaction(tx, row, author, input, files);
        if (sent.message.sequence === 1)
          throw new ConflictError('This clientMessageId was used to start the conversation', 'IDEMPOTENCY_CONFLICT');
        if (sent.inserted) await eventLog(tx).record(principal, row.workspaceId,
          row.space === 'agents' ? 'project.agent_thread_message_sent.v1' : 'project.message_sent.v1', row.projectId,
          { conversationId: row.id, messageId: sent.message.id });
        return sent.message;
      });
    },

    async listMaterials(principal: Principal, projectId: string, query: PageQuery = {}): Promise<Page<Material>> {
      const page = parsePage(query);
      await requireProject(principal, projectId, db);
      // Docs (#112) are materials of kind 'doc' with their own list; citations of them still resolve below.
      const materials = and(eq(schema.projectMaterials.projectId, projectId), eq(schema.projectMaterials.kind, 'material'));
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projectMaterials).where(materials);
      const rows = await db.select().from(schema.projectMaterials).where(materials)
        .orderBy(desc(schema.projectMaterials.createdAt), desc(schema.projectMaterials.id)).limit(page.limit).offset(page.offset);
      const versions = await currentVersions(rows, db);
      const items = rows.map((row, index) => material(row, versions[index]!, principal));
      return { items, total: count?.total ?? 0, ...page };
    },

    /** Metadata for the MCP source picker; bodies and private draft provenance stay out of the list. */
    async listSourceMaterials(principal: Principal, projectId: string, query: PageQuery = {}) {
      const page = parsePage(query);
      return db.transaction(async (tx) => {
        // Hold the access rows through the count and page, so a racing grant revoke
        // cannot leave a partly authorized listing behind.
        await requireProject(principal, projectId, tx, false, true);
        const where = eq(schema.projectMaterials.projectId, projectId);
        const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(schema.projectMaterials).where(where);
        const rows = await tx.select({
          materialId: schema.projectMaterials.id,
          kind: schema.projectMaterials.kind,
          version: schema.projectMaterials.currentVersion,
          title: schema.projectMaterialVersions.title,
          updatedAt: schema.projectMaterials.updatedAt,
        }).from(schema.projectMaterials).innerJoin(schema.projectMaterialVersions, and(
          eq(schema.projectMaterialVersions.materialId, schema.projectMaterials.id),
          eq(schema.projectMaterialVersions.version, schema.projectMaterials.currentVersion),
        )).where(where).orderBy(desc(schema.projectMaterials.updatedAt), desc(schema.projectMaterials.id))
          .limit(page.limit).offset(page.offset);
        return { items: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
          total: count?.total ?? 0, ...page };
      });
    },

    async getMaterial(principal: Principal, materialId: string): Promise<MaterialOrDoc> {
      const row = await locateMaterial(principal, materialId, db);
      const current = await currentVersion(row, db);
      return materialOrDoc(row, current, principal, await versionAuthors(db, [current]));
    },

    async getMaterialVersion(principal: Principal, materialId: string, versionNumber: number): Promise<MaterialVersion> {
      const row = await locateMaterial(principal, materialId, db);
      const requested = positiveVersion(versionNumber, 'version');
      const [snapshot] = await db.select().from(schema.projectMaterialVersions).where(and(
        eq(schema.projectMaterialVersions.materialId, row.id), eq(schema.projectMaterialVersions.version, requested)));
      if (!snapshot) throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
      return version(snapshot, principal, await versionAuthors(db, [snapshot]));
    },

    async createMaterial(principal: Principal, projectId: string, input: Parameters<ConversationPort['createMaterial']>[2]): Promise<Material> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const project = await requireProject(principal, projectId, tx, true, true);
        await lockIdempotency(tx, projectId, { kind: 'human', id: authorId }, input.clientMutationId);
        const [existing] = await tx.select().from(schema.projectMaterials).where(and(
          eq(schema.projectMaterials.projectId, projectId), eq(schema.projectMaterials.createdBy, authorId),
          eq(schema.projectMaterials.clientMutationId, input.clientMutationId)));
        if (existing) {
          if (existing.requestFingerprint !== input.fingerprint) throw new ConflictError('This clientMutationId was used for another material', 'IDEMPOTENCY_CONFLICT');
          return material(existing, await currentVersion(existing, tx), principal);
        }
        if (input.sourceDraftId && input.sourceDraftVersion) {
          const source = enforce(await evaluateDraft(principal, 'draft.read', input.sourceDraftId, tx, { lock: true }), 'draft').draft!;
          if (source.ownerUserId !== authorId || source.workspaceId !== project.workspaceId)
            throw new NotFoundError('Draft', 'DRAFT_NOT_FOUND');
          const snapshot = await tx.execute(sql`SELECT 1 FROM draft_versions WHERE draft_id = ${input.sourceDraftId}
            AND version = ${input.sourceDraftVersion}`);
          if (!snapshot.rows.length) throw new NotFoundError('Draft version', 'DRAFT_VERSION_NOT_FOUND');
        }
        const id = randomUUID();
        const [created] = await tx.insert(schema.projectMaterials).values({
          id, workspaceId: project.workspaceId, projectId, createdBy: authorId,
          clientMutationId: input.clientMutationId, requestFingerprint: input.fingerprint,
        }).onConflictDoNothing().returning();
        if (!created) {
          const [raced] = await tx.select().from(schema.projectMaterials).where(and(
            eq(schema.projectMaterials.projectId, projectId), eq(schema.projectMaterials.createdBy, authorId),
            eq(schema.projectMaterials.clientMutationId, input.clientMutationId)));
          if (!raced || raced.requestFingerprint !== input.fingerprint) throw new ConflictError('This clientMutationId was used for another material', 'IDEMPOTENCY_CONFLICT');
          return material(raced, await currentVersion(raced, tx), principal);
        }
        const [first] = await tx.insert(schema.projectMaterialVersions).values({
          workspaceId: project.workspaceId, projectId, materialId: id, version: 1,
          title: input.title, body: input.body, url: input.url, authorId,
          sourceDraftId: input.sourceDraftId, sourceDraftVersion: input.sourceDraftVersion,
        }).returning();
        await recordEvent(eventPorts(tx), principal, project.workspaceId, 'project.material_created.v1', projectId, { materialId: id, version: 1 });
        return material(created, first!, principal);
      });
    },

    async updateMaterial(principal: Principal, materialId: string, input: Parameters<ConversationPort['updateMaterial']>[2]): Promise<Material> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const row = await locateMaterial(principal, materialId, tx, true, true);
        if (row.kind === 'doc') throw new ConflictError('Docs are edited through the doc API with If-Match', 'USE_DOC_API');
        const [locked] = await tx.select().from(schema.projectMaterials).where(eq(schema.projectMaterials.id, row.id)).for('update');
        const [priorEdit] = await tx.select().from(schema.projectMaterialVersions).where(and(
          eq(schema.projectMaterialVersions.materialId, row.id), eq(schema.projectMaterialVersions.authorId, authorId),
          eq(schema.projectMaterialVersions.clientMutationId, input.clientMutationId)));
        if (priorEdit) {
          if (priorEdit.requestFingerprint !== input.fingerprint)
            throw new ConflictError('This clientMutationId was used for another edit', 'IDEMPOTENCY_CONFLICT');
          // Return the original committed revision even if later edits have advanced the material.
          return material({ ...locked!, updatedAt: priorEdit.createdAt }, priorEdit, principal);
        }
        if (!locked || locked.currentVersion !== input.expectedVersion)
          throw new ConflictError('Material changed; refresh before editing', 'STALE_MATERIAL');
        const previous = await currentVersion(locked, tx);
        const next = { title: input.title ?? previous.title, body: input.body ?? previous.body, url: input.url === undefined ? previous.url : input.url };
        if (!next.body.trim() && !next.url) throw new InvalidInputError('Material needs text or a link');
        const [updated] = await tx.update(schema.projectMaterials).set({ currentVersion: locked.currentVersion + 1, updatedAt: new Date() })
          .where(eq(schema.projectMaterials.id, row.id)).returning();
        const [snapshot] = await tx.insert(schema.projectMaterialVersions).values({
          workspaceId: row.workspaceId, projectId: row.projectId, materialId: row.id,
          version: updated!.currentVersion, ...next, authorId,
          clientMutationId: input.clientMutationId, requestFingerprint: input.fingerprint,
        }).returning();
        await recordEvent(eventPorts(tx), principal, row.workspaceId, 'project.material_updated.v1', row.projectId, { materialId: row.id, version: updated!.currentVersion });
        return material(updated!, snapshot!, principal);
      });
    },
  };
}

/** CLOSED private composition only; the verified native executor owns runtime/grant/receipt and final events.
 * No route calls this adapter. All upstream authorization/command/source locks precede the shared task fence.
 */
export async function guardedAgentThreadInEventSession(tx: Transaction, session: TransactionEventSession,
  runtime: AuthenticatedAgentRuntime, command: { clientCommandId: string; grantId: string }, taskId: string, input: AgentThreadPost) {
  return session.run(async () => {
    const principal: Principal = { kind: 'agent', id: runtime.agentId };
    const task = await locateThreadTask(principal, taskId, tx, true, true);
    if (task.workspaceId !== runtime.workspaceId || input.projectId !== task.projectId)
      throw new InvalidInputError('The task does not belong to this project');
    const author: Actor = { kind: 'agent', id: runtime.agentId };
    await lockIdempotency(tx, task.projectId, author, input.clientMessageId);
    if (await existingMessage(task.projectId, author, input.clientMessageId, tx))
      throw new ConflictError('A native message requires its original command receipt', 'IDEMPOTENCY_CONFLICT');
    await sourceExists(task.projectId, input.source, tx);
    const sourceRefs = input.source ? [{ type: 'material', id: input.source.materialId }] : [];
    const targets = [...new Set([task.id, ...await workRows(tx).taskUseTargets(sourceRefs)])].sort();
    const fence = await taskUseRows(tx).prepare(targets);
    const retainedTargets = [...new Set([task.id, ...await workRows(tx).taskUseTargets(sourceRefs)])].sort();
    if (JSON.stringify(retainedTargets) !== JSON.stringify(targets))
      throw new ConflictError('Task references changed; retry from current details', 'TASK_TARGET_SET_CHANGED');
    let thread = await agentThreadGuardRows(tx).thread(task.id, task);
    if (!thread) {
      const [created] = await tx.insert(schema.projectConversations).values({ id: randomUUID(), workspaceId: task.workspaceId,
        projectId: task.projectId, space: 'agents', workId: task.id, createdBy: null, createdByAgentId: runtime.agentId }).returning();
      thread = created!;
    }
    const messageId = randomUUID();
    await agentThreadGuardRows(tx).debit(fence, task, thread.id, messageId, runtime, command);
    const stored = await taskDiscussionRows(tx).append(thread, author, input, messageId);
    await fence.mark();
    await session.record(principal, task.workspaceId, 'project.agent_thread_message_sent.v1', task.projectId,
      { conversationId: thread.id, messageId: stored.id });
    return message(stored, await workRows(tx).names([author]));
  });
}

/**
 * The canonical project start and reply commands inside a #152 standing-grant execution: the caller's open
 * transaction, its single final event batch and the agent as the real author. Same normalization, access,
 * idempotency, task-thread ordering and audience as the person-facing routes; never a direct message.
 */
export function nativeConversationsInEventSession(tx: Transaction, session: TransactionEventSession) {
  const commands = conversationUseCases(conversationStore(tx, { events: session, agentAuthors: true }));
  return {
    createConversation: (...args: Parameters<typeof commands.createConversation>) => session.run(() => commands.createConversation(...args)),
    sendMessage: (...args: Parameters<typeof commands.sendMessage>) => session.run(() => commands.sendMessage(...args)),
  };
}
