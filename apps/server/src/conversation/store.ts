import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type {
  Conversation, ConversationMessage, ConversationSummary, Material,
  MaterialVersion, Page, PageQuery,
} from '@flux/contracts';
import {
  ConflictError, enforce, evaluateDraft, evaluateProject, InvalidInputError, NotFoundError,
  positiveVersion, uuid,
  parsePage, type Database, type Principal,
} from '@flux/core';
import type { ConversationPort } from '@flux/core';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;
type ConversationRow = typeof schema.projectConversations.$inferSelect;
type MessageRow = typeof schema.projectMessages.$inferSelect;
type MaterialRow = typeof schema.projectMaterials.$inferSelect;
type VersionRow = typeof schema.projectMaterialVersions.$inferSelect;

function human(principal: Principal): string {
  if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

function message(row: MessageRow): ConversationMessage {
  return { id: row.id, conversationId: row.conversationId, authorId: row.authorId, body: row.body,
    source: row.sourceMaterialId && row.sourceMaterialVersion ? { materialId: row.sourceMaterialId, version: row.sourceMaterialVersion } : null,
    sequence: row.sequence, createdAt: row.createdAt.toISOString() };
}

function version(row: VersionRow, principal: Principal): MaterialVersion {
  return { materialId: row.materialId, version: row.version, title: row.title, body: row.body,
    url: row.url, authorId: row.authorId,
    sourceDraft: principal.kind === 'human' && principal.id === row.authorId && row.sourceDraftId && row.sourceDraftVersion
      ? { id: row.sourceDraftId, version: row.sourceDraftVersion } : null,
    createdAt: row.createdAt.toISOString() };
}

function material(row: MaterialRow, current: VersionRow, principal: Principal): Material {
  return { ...version(current, principal), projectId: row.projectId, workspaceId: row.workspaceId,
    audience: { kind: 'project', projectId: row.projectId },
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

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
  return row;
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

async function sourceExists(projectId: string, source: { materialId: string; version: number } | null, db: Executor) {
  if (!source) return;
  const [row] = await db.select({ materialId: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
    .where(and(eq(schema.projectMaterialVersions.projectId, projectId),
      eq(schema.projectMaterialVersions.materialId, source.materialId), eq(schema.projectMaterialVersions.version, source.version)));
  if (!row) throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
}

async function existingMessage(projectId: string, authorId: string, clientMessageId: string, db: Executor) {
  const [row] = await db.select().from(schema.projectMessages).where(and(
    eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.authorId, authorId),
    eq(schema.projectMessages.clientMessageId, clientMessageId)));
  return row;
}

async function lockIdempotency(tx: Tx, projectId: string, authorId: string, clientId: string) {
  // Serializes same-key first sends before a thread is created. The uniqueness constraint
  // remains the final guard; hash collisions only serialize unrelated sends.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${projectId}:${authorId}:${clientId}`}))`);
}

async function sendInTransaction(tx: Tx, conversation: ConversationRow, authorId: string, input: Parameters<ConversationPort['sendMessage']>[2]) {
  const existing = await existingMessage(conversation.projectId, authorId, input.clientMessageId, tx);
  if (existing) {
    if (existing.requestFingerprint !== input.fingerprint || existing.conversationId !== conversation.id)
      throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
    return message(existing);
  }
  await sourceExists(conversation.projectId, input.source, tx);
  const [updated] = await tx.update(schema.projectConversations)
    .set({ nextSequence: sql`${schema.projectConversations.nextSequence} + 1` })
    .where(eq(schema.projectConversations.id, conversation.id)).returning({ nextSequence: schema.projectConversations.nextSequence });
  const sequence = updated!.nextSequence - 1;
  const [inserted] = await tx.insert(schema.projectMessages).values({
    id: randomUUID(), workspaceId: conversation.workspaceId, projectId: conversation.projectId,
    conversationId: conversation.id, authorId, clientMessageId: input.clientMessageId,
    requestFingerprint: input.fingerprint, sequence, body: input.body,
    sourceMaterialId: input.source?.materialId ?? null, sourceMaterialVersion: input.source?.version ?? null,
  }).onConflictDoNothing().returning();
  if (inserted) return message(inserted);
  const raced = await existingMessage(conversation.projectId, authorId, input.clientMessageId, tx);
  if (!raced || raced.requestFingerprint !== input.fingerprint || raced.conversationId !== conversation.id)
    throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
  return message(raced);
}

export function conversationStore(db: Database) {
  return {
    async listConversations(principal: Principal, projectId: string, query: PageQuery = {}): Promise<Page<ConversationSummary>> {
      const page = parsePage(query);
      await requireProject(principal, projectId, db);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projectConversations)
        .where(eq(schema.projectConversations.projectId, projectId));
      const rows = await db.select().from(schema.projectConversations).where(eq(schema.projectConversations.projectId, projectId))
        .orderBy(desc(schema.projectConversations.createdAt), desc(schema.projectConversations.id))
        .limit(page.limit).offset(page.offset);
      const items = await Promise.all(rows.map(async (row) => {
        const [[first], [last]] = await Promise.all([
          db.select().from(schema.projectMessages).where(eq(schema.projectMessages.conversationId, row.id))
            .orderBy(asc(schema.projectMessages.sequence)).limit(1),
          db.select().from(schema.projectMessages).where(eq(schema.projectMessages.conversationId, row.id))
            .orderBy(desc(schema.projectMessages.sequence)).limit(1),
        ]);
        return { id: row.id, projectId: row.projectId, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
          firstMessageBody: first?.body ?? '', lastMessageAt: last?.createdAt.toISOString() ?? row.createdAt.toISOString(),
          lastMessageBody: last?.body ?? '' };
      }));
      return { items, total: count?.total ?? 0, ...page };
    },

    async getConversation(principal: Principal, conversationId: string, window: Parameters<ConversationPort['getConversation']>[2]): Promise<Conversation> {
      const row = await locateConversation(principal, conversationId, db);
      const rows = await db.select().from(schema.projectMessages)
        .where(and(eq(schema.projectMessages.conversationId, row.id),
          window.beforeSequence === null ? undefined : lt(schema.projectMessages.sequence, window.beforeSequence)))
        .orderBy(desc(schema.projectMessages.sequence)).limit(window.limit + 1);
      const hasMoreBefore = rows.length > window.limit;
      const messages = rows.slice(0, window.limit).reverse().map(message);
      const openingInWindow = messages.find((item) => item.sequence === 1);
      const [opening] = openingInWindow ? [] : await db.select({ body: schema.projectMessages.body }).from(schema.projectMessages)
        .where(eq(schema.projectMessages.conversationId, row.id)).orderBy(asc(schema.projectMessages.sequence)).limit(1);
      return { id: row.id, projectId: row.projectId, workspaceId: row.workspaceId,
        audience: { kind: 'project', projectId: row.projectId }, createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(), firstMessageBody: openingInWindow?.body ?? opening?.body ?? '', messages,
        messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? messages[0]!.sequence : null, limit: window.limit } };
    },

    async createConversation(principal: Principal, projectId: string, input: Parameters<ConversationPort['createConversation']>[2]): Promise<Conversation> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const project = await requireProject(principal, projectId, tx, true, true);
        await lockIdempotency(tx, projectId, authorId, input.clientMessageId);
        const existing = await existingMessage(projectId, authorId, input.clientMessageId, tx);
        if (existing) {
          if (existing.requestFingerprint !== input.fingerprint) throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
          const row = await locateConversation(principal, existing.conversationId, tx);
          return { id: row.id, projectId: row.projectId, workspaceId: row.workspaceId,
            audience: { kind: 'project' as const, projectId: row.projectId }, createdBy: row.createdBy,
            createdAt: row.createdAt.toISOString(), firstMessageBody: existing.body, messages: [message(existing)],
            messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } };
        }
        await sourceExists(projectId, input.source, tx);
        const [row] = await tx.insert(schema.projectConversations).values({
          id: randomUUID(), workspaceId: project.workspaceId, projectId, createdBy: authorId,
        }).returning();
        const first = await sendInTransaction(tx, row!, authorId, input);
        return { id: row!.id, projectId, workspaceId: project.workspaceId,
          audience: { kind: 'project' as const, projectId }, createdBy: authorId,
          createdAt: row!.createdAt.toISOString(), firstMessageBody: first.body, messages: [first],
          messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } };
      });
    },

    async sendMessage(principal: Principal, conversationId: string, input: Parameters<ConversationPort['sendMessage']>[2]): Promise<ConversationMessage> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const row = await locateConversation(principal, conversationId, tx, true, true);
        await lockIdempotency(tx, row.projectId, authorId, input.clientMessageId);
        return sendInTransaction(tx, row, authorId, input);
      });
    },

    async listMaterials(principal: Principal, projectId: string, query: PageQuery = {}): Promise<Page<Material>> {
      const page = parsePage(query);
      await requireProject(principal, projectId, db);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projectMaterials)
        .where(eq(schema.projectMaterials.projectId, projectId));
      const rows = await db.select().from(schema.projectMaterials).where(eq(schema.projectMaterials.projectId, projectId))
        .orderBy(desc(schema.projectMaterials.createdAt), desc(schema.projectMaterials.id)).limit(page.limit).offset(page.offset);
      const items = await Promise.all(rows.map(async (row) => material(row, await currentVersion(row, db), principal)));
      return { items, total: count?.total ?? 0, ...page };
    },

    async getMaterial(principal: Principal, materialId: string): Promise<Material> {
      const row = await locateMaterial(principal, materialId, db);
      return material(row, await currentVersion(row, db), principal);
    },

    async getMaterialVersion(principal: Principal, materialId: string, versionNumber: number): Promise<MaterialVersion> {
      const row = await locateMaterial(principal, materialId, db);
      const requested = positiveVersion(versionNumber, 'version');
      const [snapshot] = await db.select().from(schema.projectMaterialVersions).where(and(
        eq(schema.projectMaterialVersions.materialId, row.id), eq(schema.projectMaterialVersions.version, requested)));
      if (!snapshot) throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
      return version(snapshot, principal);
    },

    async createMaterial(principal: Principal, projectId: string, input: Parameters<ConversationPort['createMaterial']>[2]): Promise<Material> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const project = await requireProject(principal, projectId, tx, true, true);
        await lockIdempotency(tx, projectId, authorId, input.clientMutationId);
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
        return material(created, first!, principal);
      });
    },

    async updateMaterial(principal: Principal, materialId: string, input: Parameters<ConversationPort['updateMaterial']>[2]): Promise<Material> {
      const authorId = human(principal);
      return db.transaction(async (tx) => {
        const row = await locateMaterial(principal, materialId, tx, true, true);
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
        return material(updated!, snapshot!, principal);
      });
    },
  };
}
