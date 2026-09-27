import { pgTable, text, timestamp, uuid, integer, jsonb, boolean, bigserial, bigint, index, uniqueIndex, primaryKey, foreignKey, unique, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const samples = pgTable('samples', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  createdBy: text('created_by').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  objectId: uuid('object_id').notNull(),
  actorId: text('actor_id').notNull(),
  data: jsonb('data').notNull(),
  // Added in migration 0003; null for pre-tenant fixture events.
  workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, { onDelete: 'cascade' }),
  // Added in migration 0004. Assigned by a trigger in commit order; the stream cursor.
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull().references(() => events.id),
  state: text('state').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sampleResults = pgTable('sample_results', {
  sampleId: uuid('sample_id').primaryKey().references(() => samples.id),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  workerId: text('worker_id').notNull(),
});

// Better Auth core models (migration 0002). Better Auth owns login and session
// lifecycle only; Flux grants live in Flux tables. Keys match Better Auth field names.
export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('auth_sessions_user_id_idx').on(table.userId)]);

export const authAccounts = pgTable('auth_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('auth_accounts_user_id_idx').on(table.userId),
  uniqueIndex('auth_accounts_provider_account_idx').on(table.providerId, table.accountId),
]);

export const authVerifications = pgTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('auth_verifications_identifier_idx').on(table.identifier)]);

// Workspaces, membership, projects, grants, agents and drafts (migration 0003). The SQL
// migration is authoritative; composite foreign keys reject cross-workspace links.
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull().references(() => authUsers.id),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member', 'guest'] }).notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index('workspace_members_user_idx').on(table.userId),
]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  visibility: text('visibility', { enum: ['workspace', 'restricted'] }).notNull().default('workspace'),
  createdBy: text('created_by').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workspaceId, table.id)]);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Null means the agent is owned by the workspace rather than a person. */
  ownerUserId: text('owner_user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workspaceId, table.id)]);

export const projectGrants = pgTable('project_grants', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  userId: text('user_id'),
  agentId: uuid('agent_id'),
  role: text('role', { enum: ['contributor', 'viewer', 'denied'] }).notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }).onDelete('cascade'),
]);

export const drafts = pgTable('drafts', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id'),
  ownerUserId: text('owner_user_id').references(() => authUsers.id),
  ownerAgentId: uuid('owner_agent_id'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  visibility: text('visibility', { enum: ['private', 'project', 'workspace'] }).notNull().default('private'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }),
  foreignKey({ columns: [table.workspaceId, table.ownerAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  index('drafts_workspace_idx').on(table.workspaceId, table.createdAt, table.id),
]);

// Web Push subscriptions per user and device, and the in-app inbox (migration 0005, issue #41).
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  // The session that subscribed; ending that session deletes the subscription (cascade).
  sessionId: text('session_id').notNull().references(() => authSessions.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  expirationTime: timestamp('expiration_time', { withTimezone: true }),
  deviceLabel: text('device_label'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastFailureStatus: integer('last_failure_status'),
}, (table) => [
  index('push_subscriptions_user_id_idx').on(table.userId),
  index('push_subscriptions_session_id_idx').on(table.sessionId),
]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  // The object the notification is about; its `<type>.read` decides who may see the row.
  sourceType: text('source_type').$type<'workspace' | 'project' | 'draft'>().notNull(),
  sourceId: uuid('source_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  url: text('url'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('notifications_user_created_idx').on(table.userId, table.createdAt.desc()),
  index('notifications_source_idx').on(table.sourceType, table.sourceId),
]);
// Per-recipient stream index (migration 0004), written by recordEvent.
export const eventAudience = pgTable('event_audience', {
  recipient: text('recipient').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.recipient, table.seq] }), index('event_audience_event_idx').on(table.eventId)]);

// Worker job results and idempotency keys (migration 0004).
export const draftResults = pgTable('draft_results', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  principalKind: text('principal_kind', { enum: ['human', 'agent'] }).notNull(),
  principalId: text('principal_id').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'denied'] }).notNull().default('queued'),
  deniedAtStage: text('denied_at_stage', { enum: ['before_read', 'before_commit'] }),
  jobId: text('job_id'),
  draftVersion: integer('draft_version'),
  wordCount: integer('word_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [index('draft_results_draft_idx').on(table.draftId, table.createdAt)]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey(),
  principal: text('principal').notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: jsonb('response_body'),
  responseEtag: text('response_etag'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [index('idempotency_keys_expiry_idx').on(table.expiresAt)]);

// Conversation and immutable material snapshots (migration 0006).
export const projectConversations = pgTable('project_conversations', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  createdBy: text('created_by').notNull(),
  nextSequence: integer('next_sequence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

export const projectMaterials = pgTable('project_materials', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  createdBy: text('created_by').notNull(),
  clientMutationId: uuid('client_mutation_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  currentVersion: integer('current_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  unique().on(table.projectId, table.createdBy, table.clientMutationId),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

export const projectMaterialVersions = pgTable('project_material_versions', {
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  materialId: uuid('material_id').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  url: text('url'),
  authorId: text('author_id').notNull(),
  clientMutationId: uuid('client_mutation_id'),
  requestFingerprint: text('request_fingerprint'),
  sourceDraftId: uuid('source_draft_id'),
  sourceDraftVersion: integer('source_draft_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.materialId, table.version] }),
  unique().on(table.workspaceId, table.projectId, table.materialId, table.version),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.materialId], foreignColumns: [projectMaterials.workspaceId, projectMaterials.projectId, projectMaterials.id] }).onDelete('cascade'),
]);

export const projectMessages = pgTable('project_messages', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  authorId: text('author_id').notNull(),
  clientMessageId: uuid('client_message_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  sequence: integer('sequence').notNull(),
  body: text('body').notNull(),
  sourceMaterialId: uuid('source_material_id'),
  sourceMaterialVersion: integer('source_material_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.conversationId, table.sequence),
  unique().on(table.projectId, table.authorId, table.clientMessageId),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.conversationId], foreignColumns: [projectConversations.workspaceId, projectConversations.projectId, projectConversations.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sourceMaterialId, table.sourceMaterialVersion], foreignColumns: [projectMaterialVersions.workspaceId, projectMaterialVersions.projectId, projectMaterialVersions.materialId, projectMaterialVersions.version] }),
]);
