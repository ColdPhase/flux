import { pgTable, text, timestamp, uuid, integer, jsonb, boolean, index, uniqueIndex, primaryKey, foreignKey, unique, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
}, (table) => [index('push_subscriptions_user_id_idx').on(table.userId)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  url: text('url'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('notifications_user_created_idx').on(table.userId, table.createdAt.desc())]);
