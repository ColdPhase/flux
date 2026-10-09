import { eq, ne, sql } from 'drizzle-orm';
import type { InspectedComparisonSource } from '@flux/contracts';
import { pgTable, text, timestamp, date, uuid, integer, smallint, jsonb, boolean, bigserial, bigint, index, uniqueIndex, primaryKey, foreignKey, unique, check, type AnyPgColumn, type PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { AGENT_OPERATIONS, AGENT_PEER_REQUEST_CLASSES, type AgentJsonValue, type AgentPostcondition, type CoWorkSourceRef } from '@flux/contracts';
import { AI_PROVIDER_KINDS, BACKGROUND_CONSENT_VERSIONS, type AiProviderKind, type PersonalRunConsentVersion } from '@flux/contracts';

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

/** How a session signed in (migration 0066, #310): password or provider id, the IdP's `sid`, and when it vouched. */
export const authSessionIdentities = pgTable('auth_session_identities', {
  sessionId: text('session_id').primaryKey().references(() => authSessions.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  idpSid: text('idp_sid'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The standing check of a person's account at the identity provider (migration 0070, #311). The sealed
 * offline refresh token lives only here; backups keep this table's definition but not its rows.
 */
export const authIdpStanding = pgTable('auth_idp_standing', {
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  state: text('state').notNull().default('ok'),
  reason: text('reason'),
  refreshTokenEnc: text('refresh_token_enc'),
  /** The provider session (`sid`) the stored token was issued for (migration 0077, #314). */
  refreshTokenSid: text('refresh_token_sid'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  lastOutcome: text('last_outcome'),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  leaseId: text('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.userId, table.providerId] })]);

/** Seen back-channel logout token ids (migration 0073, #314): a `jti` is accepted once per provider until it expires. */
export const authLogoutTokens = pgTable('auth_logout_tokens', {
  providerId: text('provider_id').notNull(),
  jti: text('jti').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.providerId, table.jti] }), index('auth_logout_tokens_expires_idx').on(table.expiresAt)]);

// Better Auth MCP/OAuth provider models (migration 0009).
export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    userId: text("user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [index("oauthClient_userId_idx").on(table.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => authSessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
    authTime: timestamp("auth_time", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => authSessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(
      table.authorizationCodeId,
    ),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});


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
  sourceType: text('source_type').$type<'workspace' | 'project' | 'draft' | 'dm'>().notNull(),
  sourceId: uuid('source_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  url: text('url'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Migration 0015 (#116): why it exists, the event it came from, and whether the inbox lists it.
  reason: text('reason').$type<'mention' | 'question' | 'reply' | 'dm' | 'assigned' | 'review' | 'invitation'>(),
  eventId: uuid('event_id'),
  inInbox: boolean('in_inbox').notNull().default(true),
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
  createdBy: text('created_by'),
  createdByAgentId: uuid('created_by_agent_id'),
  nextSequence: integer('next_sequence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.createdByAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  check('project_conversation_exact_actor', sql`num_nonnulls(${table.createdBy}, ${table.createdByAgentId}) = 1`),
]);

export const projectMaterials = pgTable('project_materials', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  /** Exactly one actor (migration 0043, #152): a person, or the agent that started a doc under a standing grant. */
  createdBy: text('created_by'),
  createdByAgentId: uuid('created_by_agent_id'),
  /** 'doc' for project docs (#112, migration 0013); docs have no client mutation id. */
  kind: text('kind', { enum: ['material', 'doc'] }).notNull().default('material'),
  clientMutationId: uuid('client_mutation_id'),
  requestFingerprint: text('request_fingerprint'),
  currentVersion: integer('current_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  unique().on(table.projectId, table.createdBy, table.clientMutationId),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.createdByAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  check('project_material_exact_actor', sql`num_nonnulls(${table.createdBy}, ${table.createdByAgentId}) = 1`),
  check('project_material_agent_doc', sql`${table.createdByAgentId} IS NULL OR ${table.kind} = 'doc'`),
]);

export const projectMaterialVersions = pgTable('project_material_versions', {
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  materialId: uuid('material_id').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  url: text('url'),
  /** Exactly one actor (migration 0043, #152): a person, or the agent that wrote a doc version under a standing grant. */
  authorId: text('author_id'),
  authorAgentId: uuid('author_agent_id'),
  clientMutationId: uuid('client_mutation_id'),
  requestFingerprint: text('request_fingerprint'),
  sourceDraftId: uuid('source_draft_id'),
  sourceDraftVersion: integer('source_draft_version'),
  /** Doc versions only (#112): draft or published, and why this version was made. */
  state: text('state', { enum: ['draft', 'published'] }),
  reason: text('reason').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.materialId, table.version] }),
  unique().on(table.workspaceId, table.projectId, table.materialId, table.version),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.materialId], foreignColumns: [projectMaterials.workspaceId, projectMaterials.projectId, projectMaterials.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.authorAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  check('project_material_version_exact_actor', sql`num_nonnulls(${table.authorId}, ${table.authorAgentId}) = 1`),
  // Only doc versions carry a state; a plain #36 material version stays person-written.
  check('project_material_version_agent_doc', sql`${table.authorAgentId} IS NULL OR ${table.state} IS NOT NULL`),
]);

export const projectMessages = pgTable('project_messages', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  authorId: text('author_id'),
  authorAgentId: uuid('author_agent_id'),
  clientMessageId: uuid('client_message_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  sequence: integer('sequence').notNull(),
  body: text('body').notNull(),
  sourceMaterialId: uuid('source_material_id'),
  sourceMaterialVersion: integer('source_material_version'),
  /** Plain text unless an explicit native effect (#154, migration 0040) says otherwise. */
  contributionKind: text('contribution_kind', { enum: ['text', 'blocker', 'result', 'handoff'] }).notNull().default('text'),
  resultId: uuid('result_id'),
  /** How many published files belong to this message (#154, migration 0045); text or at least one file. */
  attachmentCount: smallint('attachment_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.conversationId, table.sequence),
  unique('project_messages_file_identity').on(table.workspaceId, table.projectId, table.id),
  unique('project_messages_root_identity').on(table.conversationId, table.id, table.sequence),
  unique().on(table.projectId, table.authorId, table.clientMessageId),
  unique().on(table.projectId, table.authorAgentId, table.clientMessageId),
  foreignKey({ columns: [table.workspaceId, table.authorAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  check('project_message_exact_actor', sql`num_nonnulls(${table.authorId}, ${table.authorAgentId}) = 1`),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.conversationId], foreignColumns: [projectConversations.workspaceId, projectConversations.projectId, projectConversations.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sourceMaterialId, table.sourceMaterialVersion], foreignColumns: [projectMaterialVersions.workspaceId, projectMaterialVersions.projectId, projectMaterialVersions.materialId, projectMaterialVersions.version] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.resultId], foreignColumns: [projectResults.workspaceId, projectResults.projectId, projectResults.id] }),
  check('project_message_contribution_kind', sql`${table.contributionKind} IN ('text', 'blocker', 'result', 'handoff')`),
  check('project_message_result_reference', sql`(${table.contributionKind} = 'result') = (${table.resultId} IS NOT NULL)`),
  check('project_message_attachment_count', sql`${table.attachmentCount} BETWEEN 0 AND 10`),
  check('project_message_body_or_attachments', sql`length(btrim(${table.body})) <= 100000 AND (length(btrim(${table.body})) >= 1 OR ${table.attachmentCount} > 0)`),
]);

/**
 * A stored file (#154, migration 0045): staged privately by its uploader, then published once as an
 * attachment of exactly one message. Its bytes are in the files volume under this server-selected id.
 */
export const fileGarbage = pgTable('file_garbage', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectFiles = pgTable('project_files', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  uploaderId: text('uploader_id').references(() => authUsers.id),
  uploaderAgentId: uuid('uploader_agent_id'),
  uploadId: uuid('upload_id').notNull(),
  replayOf: uuid('replay_of'),
  name: text('name').notNull(),
  state: text('state', { enum: ['receiving', 'ready'] }).notNull(),
  reservedBytes: integer('reserved_bytes').notNull(),
  size: integer('size'),
  sha256: text('sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  messageId: uuid('message_id'),
  position: smallint('position'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** #252: the map thought this file is the image of (no foreign key, like a placement); null unless published there. */
  thoughtId: uuid('thought_id'),
}, (table) => [
  unique().on(table.messageId, table.position),
  uniqueIndex('project_files_thought_idx').on(table.thoughtId).where(sql`${table.thoughtId} IS NOT NULL`),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.messageId], foreignColumns: [projectMessages.workspaceId, projectMessages.projectId, projectMessages.id] }),
  uniqueIndex('project_files_human_upload_idx').on(table.projectId, table.uploaderId, table.uploadId).where(sql`${table.uploaderId} IS NOT NULL`),
  uniqueIndex('project_files_agent_upload_idx').on(table.projectId, table.uploaderAgentId, table.uploadId).where(sql`${table.uploaderAgentId} IS NOT NULL`),
  index('project_files_expiry_idx').on(table.expiresAt).where(sql`${table.publishedAt} IS NULL`),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.uploaderAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  check('project_file_exact_uploader', sql`num_nonnulls(${table.uploaderId}, ${table.uploaderAgentId}) = 1`),
]);

// One person's selected agent, scopes and project ceiling for an external MCP client (#52).
export const agentConnections = pgTable('agent_connections', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull(),
  name: text('name').notNull().default('External connection'),
  clientDesignation: text('client_designation', { enum: ['claude_code', 'codex', 'other'] }).notNull().default('other'),
  computeSource: text('compute_source', { enum: ['user_operated_claude_code', 'user_operated_external_client'] }).notNull().default('user_operated_external_client'),
  scopes: text('scopes', { enum: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] }).array().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.id),
  index('agent_connections_owner_idx').on(table.ownerUserId, table.createdAt, table.id),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }),
]);

export const agentConnectionProjects = pgTable('agent_connection_projects', {
  workspaceId: uuid('workspace_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  projectId: uuid('project_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectionId, table.projectId] }),
  unique().on(table.workspaceId, table.connectionId, table.projectId),
  foreignKey({ columns: [table.workspaceId, table.connectionId], foreignColumns: [agentConnections.workspaceId, agentConnections.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

// A single immutable OAuth choice per browser session prevents concurrent consent tabs
// from silently changing which agent and project ceiling receives a token.
export const agentOauthSelections = pgTable('agent_oauth_selections', {
  sessionId: text('session_id').primaryKey().references(() => authSessions.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => agentConnections.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Provider references persist independently of short-lived browser flow choices. */
export const agentOauthBindings = pgTable('agent_oauth_bindings', {
  id: uuid('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  connectionId: uuid('connection_id').notNull().references(() => agentConnections.id),
  clientId: text('client_id').notNull(),
  generation: integer('generation').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.ownerUserId, table.connectionId, table.clientId)]);

export const agentOauthFlows = pgTable('agent_oauth_flows', {
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  sessionId: text('session_id').notNull().references(() => authSessions.id, { onDelete: 'cascade' }),
  fingerprint: text('fingerprint').notNull(),
  bindingId: uuid('binding_id').notNull().references(() => agentOauthBindings.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.ownerUserId, table.sessionId, table.fingerprint] })]);

/** Server-issued runtime identity, bound to one actual OAuth binding/generation. */
export const agentRuntimeSessions = pgTable('agent_runtime_sessions', {
  id: uuid('id').primaryKey(),
  bindingId: uuid('binding_id').notNull().references(() => agentOauthBindings.id),
  bindingGeneration: integer('binding_generation').notNull(),
  clientSessionId: uuid('client_session_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  agentId: uuid('agent_id').notNull(),
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  unique().on(table.bindingId, table.clientSessionId),
  unique().on(table.connectionId, table.id),
  foreignKey({ columns: [table.workspaceId, table.connectionId], foreignColumns: [agentConnections.workspaceId, agentConnections.id] }),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }),
]);

/** Explicit owner action ceilings; project contributor rights do not create these grants. */
export const agentStandingGrants = pgTable('agent_standing_grants', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  clientCommandId: uuid('client_command_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  operation: text('operation', { enum: AGENT_OPERATIONS }).notNull(),
  peerRequestClass: text('peer_request_class', { enum: AGENT_PEER_REQUEST_CLASSES }).notNull(),
  objectId: uuid('object_id'),
  maximumUses: integer('maximum_uses').notNull(),
  used: integer('used').notNull().default(0),
  generation: integer('generation').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.connectionId, table.id),
  unique().on(table.connectionId, table.clientCommandId),
  foreignKey({ columns: [table.workspaceId, table.connectionId, table.projectId], foreignColumns: [agentConnectionProjects.workspaceId, agentConnectionProjects.connectionId, agentConnectionProjects.projectId] }),
]);

/** One canonical durable command ledger, shared with coordination. No TTL replay cache. */
export const agentCommandReceipts = pgTable('agent_command_receipts', {
  connectionId: uuid('connection_id').notNull(),
  clientCommandId: uuid('client_command_id').notNull(),
  runtimeSessionId: uuid('runtime_session_id').notNull(),
  grantId: uuid('grant_id').notNull(),
  grantGeneration: integer('grant_generation').notNull(),
  bindingId: uuid('binding_id').notNull().references(() => agentOauthBindings.id),
  bindingGeneration: integer('binding_generation').notNull(),
  fingerprint: text('fingerprint').notNull(),
  operation: text('operation', { enum: AGENT_OPERATIONS }).notNull(),
  projectId: uuid('project_id').notNull(),
  value: jsonb('value').$type<AgentJsonValue>().notNull(),
  postconditions: jsonb('postconditions').$type<AgentPostcondition[]>().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.connectionId, table.clientCommandId] }),
  foreignKey({ columns: [table.connectionId, table.runtimeSessionId], foreignColumns: [agentRuntimeSessions.connectionId, agentRuntimeSessions.id] }),
  foreignKey({ columns: [table.connectionId, table.grantId], foreignColumns: [agentStandingGrants.connectionId, agentStandingGrants.id] }),
]);

// The co-work playbook a client reports having loaded for one runtime session (migration 0041, #160).
// Compatibility evidence only; it authorizes nothing.
export const agentPlaybookAcknowledgments = pgTable('agent_playbook_acknowledgments', {
  runtimeSessionId: uuid('runtime_session_id').primaryKey().references(() => agentRuntimeSessions.id, { onDelete: 'cascade' }),
  bundleId: text('bundle_id').notNull(),
  version: text('version').notNull(),
  digest: text('digest').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
});

// The approved project policy for connected agents (migration 0044, #160 / CW-1): every published
// revision, kept unchanged. Policy narrows work inside owner grants; it never grants anything.
export const agentProjectPolicies = pgTable('agent_project_policies', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  scope: text('scope').notNull(),
  priorities: text('priorities').notNull(),
  reviewCriteria: text('review_criteria').notNull(),
  allowedWork: text('allowed_work').notNull(),
  digest: text('digest').notNull(),
  publishedByUserId: text('published_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.projectId, table.revision] })]);

// Sketches: thoughts on a map and the links between them (migration 0007, issue #69).
export const sketches = pgTable('sketches', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['project', 'private', 'dm'] }).notNull(),
  projectId: uuid('project_id'),
  // A DM sketch's direct message (migration 0025, #96): composite FK to dms(workspace_id, id).
  dmId: uuid('dm_id'),
  copiedFromSketchId: uuid('copied_from_sketch_id'),
  copiedByUserId: text('copied_by_user_id').references(() => authUsers.id),
  copiedAt: timestamp('copied_at', { withTimezone: true }),
  title: text('title').notNull(),
  createdByUserId: text('created_by_user_id').references(() => authUsers.id),
  createdByAgentId: uuid('created_by_agent_id'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.createdByAgentId], foreignColumns: [agents.workspaceId, agents.id] }),
  index('sketches_workspace_idx').on(table.workspaceId, table.updatedAt.desc(), table.id),
]);

export const sketchThoughts = pgTable('sketch_thoughts', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  sketchId: uuid('sketch_id').notNull(),
  text: text('text').notNull(),
  x: integer('x').notNull(),
  y: integer('y').notNull(),
  width: integer('width').notNull().default(184),
  height: integer('height').notNull().default(72),
  shape: text('shape', { enum: ['card', 'pill', 'circle'] }).notNull().default('card'),
  placementType: text('placement_type', { enum: ['draft'] }),
  placementId: uuid('placement_id'),
  // The message a thought was started from (migration 0025, #96).
  sourceAuthorId: text('source_author_id').references(() => authUsers.id),
  sourceAuthorName: text('source_author_name'),
  sourceSentAt: timestamp('source_sent_at', { withTimezone: true }),
  sourceDmId: uuid('source_dm_id'),
  sourceMessageId: uuid('source_message_id'),
  createdByUserId: text('created_by_user_id').references(() => authUsers.id),
  createdByAgentId: uuid('created_by_agent_id'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.sketchId, table.id),
  foreignKey({ columns: [table.workspaceId, table.sketchId], foreignColumns: [sketches.workspaceId, sketches.id] }).onDelete('cascade'),
  index('sketch_thoughts_sketch_idx').on(table.sketchId, table.createdAt, table.id),
]);

export const sketchLinks = pgTable('sketch_links', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  sketchId: uuid('sketch_id').notNull(),
  fromId: uuid('from_id').notNull(),
  toId: uuid('to_id').notNull(),
  label: text('label'),
  createdByUserId: text('created_by_user_id').references(() => authUsers.id),
  createdByAgentId: uuid('created_by_agent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.sketchId], foreignColumns: [sketches.workspaceId, sketches.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.sketchId, table.fromId], foreignColumns: [sketchThoughts.sketchId, sketchThoughts.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.sketchId, table.toId], foreignColumns: [sketchThoughts.sketchId, sketchThoughts.id] }).onDelete('cascade'),
]);

// Work items, decisions, results and their links (migration 0008, #101).
export const projectDecisions = pgTable('project_decisions', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  rationale: text('rationale').notNull().default(''),
  status: text('status', { enum: ['proposed', 'accepted', 'superseded'] }).notNull().default('proposed'),
  proposedByKind: text('proposed_by_kind', { enum: ['human', 'agent'] }).notNull(),
  proposedById: text('proposed_by_id').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  supersedesId: uuid('supersedes_id'),
  supersededById: uuid('superseded_by_id'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

export const projectWorkItems = pgTable('project_work_items', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  /**
   * The task's number in its project, shown as "#12" (#276, migration 0055). A trigger takes it from the
   * project's own sequence on every insert and refuses changes; the default only lets inserts leave it out.
   */
  number: integer('number').notNull().default(0),
  title: text('title').notNull(),
  outcome: text('outcome').notNull().default(''),
  status: text('status', { enum: ['open', 'in_progress', 'blocked', 'done', 'not_pursued'] }).notNull().default('open'),
  blocker: text('blocker'),
  ownerUserId: text('owner_user_id'),
  ownerAgentId: uuid('owner_agent_id'),
  parkedByDecisionId: uuid('parked_by_decision_id'),
  parkedAt: timestamp('parked_at', { withTimezone: true }),
  createdByKind: text('created_by_kind', { enum: ['human', 'agent'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  clientCommandId: uuid('client_command_id'),
  requestFingerprint: text('request_fingerprint'),
  /** Bounded array of distinct trimmed statements (#152, migration 0039); `[]` for tasks without any. */
  criteria: jsonb('criteria').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  uniqueIndex('project_work_creation_command_idx').on(table.projectId, table.createdByKind, table.createdById, table.clientCommandId),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

/** Direct same-project prerequisites of a task (#152, migration 0039); the task may start once all are done. */
export const projectTaskDependencies = pgTable('project_task_dependencies', {
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(),
  prerequisiteId: uuid('prerequisite_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.taskId, table.prerequisiteId] }),
  check('project_task_dependency_not_self', sql`${table.taskId} <> ${table.prerequisiteId}`),
  index('project_task_dependencies_task_idx').on(table.taskId, table.prerequisiteId),
  index('project_task_dependencies_prerequisite_idx').on(table.prerequisiteId, table.taskId),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.prerequisiteId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
]);

/**
 * Immutable native plan correlation (#152, migration 0039): one exact plan revision and key produced one task,
 * with the normalized creation fingerprint and the task's original version. Not an agent receipt or grant.
 */
export const projectTaskPlanIntents = pgTable('project_task_plan_intents', {
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  materialId: uuid('material_id').notNull(),
  materialVersion: integer('material_version').notNull(),
  intentKey: text('intent_key').notNull(),
  taskId: uuid('task_id').notNull().unique(),
  creationFingerprint: text('creation_fingerprint').notNull(),
  taskVersion: integer('task_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.materialId, table.materialVersion, table.intentKey] }),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.materialId, table.materialVersion], foreignColumns: [projectMaterialVersions.workspaceId, projectMaterialVersions.projectId, projectMaterialVersions.materialId, projectMaterialVersions.version] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }),
]);

// Durable compact creation notices, never synthetic conversation roots (#154, migration 0033).
export const projectTaskNotices = pgTable('project_task_notices', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  workId: uuid('work_id').notNull(),
  kind: text('kind', { enum: ['task.created'] }).notNull(),
  createdByKind: text('created_by_kind', { enum: ['human', 'agent'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  sources: jsonb('sources').$type<import('@flux/contracts').ObjectRef[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [
  unique().on(table.workId, table.kind),
  index('project_task_notices_project_idx').on(table.projectId, table.createdAt, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.workId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
]);

/** A task never manufactures a conversation. Its first genuine message binds the root. */
export const projectTaskDiscussions = pgTable('project_task_discussions', {
  workId: uuid('work_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  conversationId: uuid('conversation_id').notNull().unique(),
  rootMessageId: uuid('root_message_id').notNull().unique(),
  rootSequence: integer('root_sequence').notNull().default(1),
}, (table) => [
  check('project_task_discussion_root_sequence', sql`${table.rootSequence} = 1`),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.workId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.conversationId], foreignColumns: [projectConversations.workspaceId, projectConversations.projectId, projectConversations.id] }),
  foreignKey({ columns: [table.conversationId, table.rootMessageId, table.rootSequence], foreignColumns: [projectMessages.conversationId, projectMessages.id, projectMessages.sequence] }),
]);

export const projectResults = pgTable('project_results', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  finding: text('finding', { enum: ['positive', 'negative'] }).notNull(),
  evidence: text('evidence').notNull().default(''),
  createdByKind: text('created_by_kind', { enum: ['human', 'agent'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);

/**
 * One receipt per real actor, project, operation and client command UUID (#154, migration 0040). It keeps the
 * produced object, the produced task version and the contribution messages for an exact replay; it is not the
 * #152 connection-command ledger and never debits a grant.
 */
export const nativeCommandReceipts = pgTable('native_command_receipts', {
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  actorKind: text('actor_kind', { enum: ['human', 'agent'] }).notNull(),
  actorId: text('actor_id').notNull(),
  operation: text('operation', { enum: ['work.update', 'result.create'] }).notNull(),
  clientCommandId: uuid('client_command_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  workId: uuid('work_id'),
  workVersion: integer('work_version'),
  resultId: uuid('result_id'),
  messageIds: uuid('message_ids').array().notNull().default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.actorKind, table.actorId, table.operation, table.clientCommandId] }),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.workId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.resultId], foreignColumns: [projectResults.workspaceId, projectResults.projectId, projectResults.id] }).onDelete('cascade'),
]);

export const projectObjectLinks = pgTable('project_object_links', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  role: text('role', { enum: ['source', 'affects', 'still_applies', 'about', 'related', 'mentions'] }).notNull(),
  fromType: text('from_type', { enum: ['work', 'decision', 'result', 'doc'] }).notNull(),
  fromId: uuid('from_id').notNull(),
  toType: text('to_type', { enum: ['message', 'thought', 'material', 'work', 'decision', 'result', 'doc', 'sketch'] }).notNull(),
  toId: uuid('to_id').notNull(),
  toVersion: integer('to_version'),
  createdByKind: text('created_by_kind', { enum: ['human', 'agent'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('project_object_links_to_idx').on(table.toId),
  index('project_object_links_from_idx').on(table.fromId),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
]);
// A project-visible agent suggestion citing one immutable, current source revision (#52).
// Its separate identity prevents a tool call from publishing a material as accepted truth.
export const agentProposals = pgTable('agent_proposals', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  computeSource: text('compute_source', { enum: ['user_operated_claude_code', 'user_operated_external_client'] }).notNull(),
  agentGrantId: uuid('agent_grant_id').notNull(),
  agentGrantRole: text('agent_grant_role', { enum: ['contributor'] }).notNull(),
  sourceMaterialId: uuid('source_material_id').notNull(),
  sourceMaterialVersion: integer('source_material_version').notNull(),
  clientCommandId: uuid('client_command_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  fact: text('fact').notNull(),
  interpretation: text('interpretation').notNull(),
  suggestedAction: text('suggested_action').notNull(),
  status: text('status', { enum: ['proposed', 'dismissed'] }).notNull().default('proposed'),
  dismissedBy: text('dismissed_by').references(() => authUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.agentId, table.projectId, table.clientCommandId),
  index('agent_proposals_project_idx').on(table.projectId, table.createdAt, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sourceMaterialId, table.sourceMaterialVersion], foreignColumns: [projectMaterialVersions.workspaceId, projectMaterialVersions.projectId, projectMaterialVersions.materialId, projectMaterialVersions.version] }),
]);

export const backgroundComputeConnections = pgTable('background_compute_connections', {
  id: uuid('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  // F-020 (#179, migration 0042): any supported provider and a bounded model id.
  provider: text('provider', { enum: AI_PROVIDER_KINDS }).notNull(),
  model: text('model').notNull(),
  /** `openai_compatible` only. */
  baseUrl: text('base_url'),
  /** The owner's label, e.g. "Work OpenRouter" (PROV-1: an owner may keep several connections). */
  name: text('name').notNull(),
  /** The one connection background comparisons use; at most one active per owner. */
  usedForBackground: boolean('used_for_background').notNull().default(false),
  /** Micro-dollars per 1M tokens; all null when no price is known. */
  inputPriceMicrosPerMTok: integer('input_price_micros_per_mtok'),
  outputPriceMicrosPerMTok: integer('output_price_micros_per_mtok'),
  priceSource: text('price_source', { enum: ['table', 'owner'] }),
  priceCheckedOn: date('price_checked_on', { mode: 'string' }),
  payerOrganization: text('payer_organization').notNull(),
  providerWorkspace: text('provider_workspace').notNull(),
  encryptedKey: text('encrypted_key'),
  keyLastFour: text('key_last_four').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(),
  maxRunsPerDay: integer('max_runs_per_day').notNull(),
  periodDays: integer('period_days').notNull(),
  periodBudgetCents: integer('period_budget_cents').notNull(),
  perRunCents: integer('per_run_cents').notNull(),
  consentVersion: text('consent_version', { enum: BACKGROUND_CONSENT_VERSIONS }).notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('background_compute_connections_background_owner_idx').on(table.ownerUserId).where(sql`${table.usedForBackground}`),
  index('background_compute_connections_owner_idx').on(table.ownerUserId, table.createdAt, table.id),
]);

export const proactiveComparisonRules = pgTable('proactive_comparison_rules', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull(),
  triggerKind: text('trigger_kind', { enum: ['human_negative_result'] }).notNull().default('human_negative_result'),
  purpose: text('purpose', { enum: ['camera_sensor_comparison'] }).notNull().default('camera_sensor_comparison'),
  dataScope: text('data_scope', { enum: ['current_project_published'] }).notNull().default('current_project_published'),
  permittedEffect: text('permitted_effect', { enum: ['quiet_project_proposal'] }).notNull().default('quiet_project_proposal'),
  maxRunsPerDay: integer('max_runs_per_day').notNull(),
  periodBudgetCents: integer('period_budget_cents').notNull(),
  perRunCents: integer('per_run_cents').notNull(),
  status: text('status', { enum: ['enabled', 'paused', 'revoked'] }).notNull().default('paused'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('proactive_comparison_rules_active_owner_project_idx').on(table.ownerUserId, table.projectId, table.purpose)
    .where(ne(table.status, 'revoked')),
  index('proactive_comparison_rules_owner_idx').on(table.ownerUserId, table.projectId),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }),
]);

// Durable project-bound live sessions and identifier-only presentation trace (#61).
// Access belongs to the existing project policy; media room IDs do not encode titles or users.
export const liveSessions = pgTable('live_sessions', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  conversationId: uuid('conversation_id'),
  workId: uuid('work_id'),
  sketchId: uuid('sketch_id'),
  docId: uuid('doc_id'),
  createdBy: text('created_by').notNull().references(() => authUsers.id),
  clientSessionId: uuid('client_session_id').notNull(),
  state: text('state', { enum: ['available', 'rotating', 'ending', 'ended'] }).notNull().default('available'),
  generation: integer('generation').notNull().default(1),
  roomId: text('room_id').notNull().unique(),
  emptySince: timestamp('empty_since', { withTimezone: true }),
  lastGrantAt: timestamp('last_grant_at', { withTimezone: true }),
  connectedOnce: boolean('connected_once').notNull().default(false),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.createdBy, table.clientSessionId),
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.conversationId], foreignColumns: [projectConversations.workspaceId, projectConversations.projectId, projectConversations.id] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.workId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sketchId], foreignColumns: [sketches.workspaceId, sketches.projectId, sketches.id] }),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.docId], foreignColumns: [projectMaterials.workspaceId, projectMaterials.projectId, projectMaterials.id] }),
  index('live_sessions_project_idx').on(table.projectId, table.createdAt.desc(), table.id.desc()),
  index('live_sessions_lifecycle_idx').on(table.state, table.updatedAt, table.id),
]);

/** Durable admission fence for access changes that also retire LiveKit rooms. */
export const liveAccessFences = pgTable('live_access_fences', {
  scopeKey: text('scope_key').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const livePresentations = pgTable('live_presentations', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  generation: integer('generation').notNull(),
  createdBy: text('created_by').notNull().references(() => authUsers.id),
  clientEventId: uuid('client_event_id').notNull(),
  refType: text('ref_type', { enum: ['message', 'material', 'work', 'result', 'sketch'] }).notNull(),
  refId: uuid('ref_id').notNull(),
  refVersion: integer('ref_version').notNull(),
  selectedThoughtIds: uuid('selected_thought_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.sessionId, table.createdBy, table.clientEventId),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sessionId], foreignColumns: [liveSessions.workspaceId, liveSessions.projectId, liveSessions.id] }).onDelete('cascade'),
  index('live_presentations_session_idx').on(table.sessionId, table.createdAt, table.id),
]);

/** Identifier-only session invitations. Replies select a navigation choice. */
export const liveInvitations = pgTable('live_invitations', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  inviterId: text('inviter_id').notNull().references(() => authUsers.id),
  recipientId: text('recipient_id').notNull().references(() => authUsers.id),
  response: text('response', { enum: ['pending', 'later', 'text'] }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
}, (table) => [
  unique().on(table.sessionId, table.recipientId),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.sessionId],
    foreignColumns: [liveSessions.workspaceId, liveSessions.projectId, liveSessions.id] }).onDelete('cascade'),
  index('live_invitations_recipient_idx').on(table.recipientId, table.createdAt.desc(), table.id.desc()),
]);
/**
 * A media admission bound to the auth session that requested it (#128). The id is the
 * LiveKit participant metadata; a trigger revokes rows when their session row is deleted.
 */
export const liveAdmissions = pgTable('live_admissions', {
  id: text('id').primaryKey(),
  liveSessionId: uuid('live_session_id').notNull().references(() => liveSessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  authSessionId: text('auth_session_id').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('live_admissions_session_idx').on(table.liveSessionId, table.userId, table.issuedAt.desc()),
]);
// Direct messages: private conversations between people of one workspace (migration 0010, issue #107).
export const dms = pgTable('dms', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['pair', 'group'] }).notNull(),
  pairKey: text('pair_key'),
  title: text('title'),
  createdBy: text('created_by').notNull().references(() => authUsers.id),
  version: integer('version').notNull().default(1),
  nextSequence: integer('next_sequence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
}, (table) => [
  unique().on(table.workspaceId, table.id),
  unique().on(table.workspaceId, table.pairKey),
]);

export const dmParticipants = pgTable('dm_participants', {
  workspaceId: uuid('workspace_id').notNull(),
  dmId: uuid('dm_id').notNull(),
  userId: text('user_id').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.dmId, table.userId] }),
  foreignKey({ columns: [table.workspaceId, table.dmId], foreignColumns: [dms.workspaceId, dms.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }).onDelete('cascade'),
  index('dm_participants_user_idx').on(table.workspaceId, table.userId, table.dmId),
]);

export const dmMessages = pgTable('dm_messages', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  dmId: uuid('dm_id').notNull(),
  authorId: text('author_id').notNull().references(() => authUsers.id),
  clientMessageId: uuid('client_message_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  sequence: integer('sequence').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.dmId, table.sequence),
  unique().on(table.dmId, table.authorId, table.clientMessageId),
  foreignKey({ columns: [table.workspaceId, table.dmId], foreignColumns: [dms.workspaceId, dms.id] }).onDelete('cascade'),
]);

// Return points: where each person last looked at a place (migration 0009, issue #106).
export const returnPoints = pgTable('return_points', {
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  placeKey: text('place_key').notNull(),
  placeType: text('place_type', { enum: ['home', 'project', 'conversation'] }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => projectConversations.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
  previousSeq: bigint('previous_seq', { mode: 'number' }),
  previousSavedAt: timestamp('previous_saved_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.userId, table.placeKey] })]);

// Notification generation, preferences, delivery addresses and the email outbox (migration 0015, #116).
export const notificationCursor = pgTable('notification_cursor', {
  id: text('id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
});

// An event candidate and any reserved possible charge remain separate from rule consent (#58).
export const proactiveComparisonCursor = pgTable('proactive_comparison_cursor', {
  id: integer('id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
});
export const proactiveComparisonProjectChanges = pgTable('proactive_comparison_project_changes', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  firstChangedAt: timestamp('first_changed_at', { withTimezone: true }).notNull(),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
}, (table) => [index('proactive_comparison_project_changes_due_idx').on(table.dueAt, table.projectId)]);

export const proactiveComparisonOutbox = pgTable('proactive_comparison_outbox', {
  id: uuid('id').primaryKey(),
  ruleId: uuid('rule_id').notNull().references(() => proactiveComparisonRules.id),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull(),
  resultId: uuid('result_id').notNull().references(() => projectResults.id),
  sourceFingerprint: text('source_fingerprint').notNull(),
  availableAfter: timestamp('available_after', { withTimezone: true }).notNull().defaultNow(),
  status: text('status', { enum: ['queued', 'reserved', 'not_run', 'unknown', 'completed'] }).notNull().default('queued'),
  connectionId: uuid('connection_id').references(() => backgroundComputeConnections.id),
  reservedCents: integer('reserved_cents').notNull().default(0),
  reservedAt: timestamp('reserved_at', { withTimezone: true }),
  dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true }),
  inspectedSources: jsonb('inspected_sources').$type<InspectedComparisonSource[]>(),
  proposalId: uuid('proposal_id'),
  insufficientOutcomeId: uuid('insufficient_outcome_id'),
  usageInputTokens: integer('usage_input_tokens'),
  usageOutputTokens: integer('usage_output_tokens'),
  usageEstimatedCents: integer('usage_estimated_cents'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.ruleId, table.resultId, table.sourceFingerprint),
  index('proactive_comparison_outbox_owner_time_idx').on(table.ownerUserId, table.reservedAt),
  uniqueIndex('proactive_comparison_outbox_owner_inflight_idx').on(table.ownerUserId).where(eq(table.status, 'reserved')),
  index('proactive_comparison_outbox_queued_idx').on(table.createdAt, table.id).where(eq(table.status, 'queued')),
  index('proactive_comparison_outbox_ready_idx').on(table.availableAfter, table.id).where(eq(table.status, 'queued')),
]);

export const proactiveComparisonProposals = pgTable('proactive_comparison_proposals', {
  id: uuid('id').primaryKey(),
  outboxId: uuid('outbox_id').notNull().unique().references(() => proactiveComparisonOutbox.id),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  resultId: uuid('result_id').notNull().references(() => projectResults.id),
  sourceFingerprint: text('source_fingerprint').notNull(),
  sources: jsonb('sources').$type<Array<{ type: 'result' | 'message' | 'material' | 'work' | 'thought'; id: string; version: number; conversationId?: string; sketchId?: string; title?: string }>>().notNull(),
  fact: text('fact').notNull(),
  interpretation: text('interpretation').notNull(),
  suggestedAction: text('suggested_action').notNull(),
  /** The connection's provider and model the proposal ran on (0042, F-020). */
  provider: text('provider', { enum: AI_PROVIDER_KINDS }).notNull(),
  model: text('model').notNull(),
  status: text('status', { enum: ['proposed', 'dismissed', 'used'] }).notNull().default('proposed'),
  version: integer('version').notNull().default(1),
  editedByUserId: text('edited_by_user_id').references(() => authUsers.id),
  usedWorkId: uuid('used_work_id').unique().references(() => projectWorkItems.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('proactive_comparison_proposals_project_idx').on(table.projectId, table.createdAt.desc(), table.id.desc())]);

export const proactiveComparisonInsufficientOutcomes = pgTable('proactive_comparison_insufficient_outcomes', {
  id: uuid('id').primaryKey(),
  outboxId: uuid('outbox_id').notNull().unique().references(() => proactiveComparisonOutbox.id),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  resultId: uuid('result_id').notNull().references(() => projectResults.id),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['open', 'dismissed'] }).notNull().default('open'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('proactive_comparison_insufficient_project_idx').on(table.projectId, table.createdAt.desc(), table.id.desc())]);

export const notificationGenerationFailures = pgTable('notification_generation_failures', {
  eventId: uuid('event_id').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deadAt: timestamp('dead_at', { withTimezone: true }),
});

export const notificationVerificationSends = pgTable('notification_verification_sends', {
  userId: text('user_id').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  sent: integer('sent').notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
});

export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  channels: jsonb('channels').$type<Record<string, Record<string, boolean>>>().notNull().default({}),
  emailDestination: text('email_destination').$type<'account' | 'extra' | 'both' | 'none'>().notNull().default('account'),
  quietEnabled: boolean('quiet_enabled').notNull().default(false),
  quietStart: integer('quiet_start').notNull().default(1320),
  quietEnd: integer('quiet_end').notNull().default(420),
  timeZone: text('time_zone').notNull().default('UTC'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationMutes = pgTable('notification_mutes', {
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').$type<'project' | 'dm'>().notNull(),
  sourceId: uuid('source_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.sourceType, table.sourceId] })]);

export const notificationAddresses = pgTable('notification_addresses', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => authUsers.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationAddressTokens = pgTable('notification_address_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  addressId: uuid('address_id').notNull().references(() => notificationAddresses.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationEmails = pgTable('notification_emails', {
  id: uuid('id').primaryKey(),
  notificationId: uuid('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  addressKind: text('address_kind').$type<'account' | 'extra'>().notNull(),
  address: text('address'),
  status: text('status').$type<'queued' | 'sending' | 'sent' | 'skipped'>().notNull().default('queued'),
  skipReason: text('skip_reason'),
  attempts: integer('attempts').notNull().default(0),
  unsubscribeHash: text('unsubscribe_hash').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
}, (table) => [unique().on(table.notificationId, table.addressKind)]);

// Owner-invoked personal assistant runs (migration 0024, #68, O-008). No key material is stored.
export const personalRunEnablements = pgTable('personal_run_enablements', {
  ownerUserId: text('owner_user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  // References #124's key connection once that table lands; a compared snapshot until then.
  connectionId: uuid('connection_id'),
  consentVersion: text('consent_version').$type<PersonalRunConsentVersion>().notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().defaultNow(),
  consentProvider: text('consent_provider').$type<AiProviderKind>().notNull(),
  consentModel: text('consent_model').notNull(),
  consentPayerOrganization: text('consent_payer_organization').notNull(),
  consentPayerWorkspace: text('consent_payer_workspace').notNull(),
  perRunCents: integer('per_run_cents').notNull().default(6),
  dailyCapCents: integer('daily_cap_cents').notNull().default(100),
  timeZone: text('time_zone').notNull().default('UTC'),
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const personalRunAgents = pgTable('personal_run_agents', {
  ownerUserId: text('owner_user_id').notNull().references(() => personalRunEnablements.ownerUserId, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.ownerUserId, table.workspaceId] }),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }).onDelete('cascade'),
]);

export const personalRuns = pgTable('personal_runs', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull(),
  connectionId: uuid('connection_id'),
  clientRunId: uuid('client_run_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  kind: text('kind', { enum: ['ask', 'summarize', 'map_thought'] }).notNull(),
  prompt: text('prompt').notNull(),
  targetSketchId: uuid('target_sketch_id'),
  targetThoughtId: uuid('target_thought_id'),
  continuesRunId: uuid('continues_run_id').references((): AnyPgColumn => personalRuns.id, { onDelete: 'set null' }),
  retryOfRunId: uuid('retry_of_run_id').references((): AnyPgColumn => personalRuns.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['queued', 'reading', 'dispatching', 'completed', 'truncated', 'stopped', 'denied', 'paused',
    'revoked', 'cap_reached', 'unavailable', 'input_too_large', 'provider_failed'] }).notNull().default('queued'),
  stoppedAtStage: text('stopped_at_stage', { enum: ['before_read', 'before_dispatch', 'before_commit'] }),
  stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
  costState: text('cost_state', { enum: ['reserved', 'released', 'observed', 'unknown'] }).notNull().default('reserved'),
  reservedMicros: integer('reserved_micros').notNull(),
  chargedMicros: integer('charged_micros').notNull().default(0),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  /** The connection's provider the run was sent to (0042, F-020). */
  provider: text('provider', { enum: AI_PROVIDER_KINDS }).notNull(),
  model: text('model').notNull(),
  answerBody: text('answer_body'),
  answerTruncated: boolean('answer_truncated').notNull().default(false),
  answerSources: jsonb('answer_sources').$type<unknown[]>().notNull().default([]),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.ownerUserId, table.clientRunId),
  unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.conversationId], foreignColumns: [projectConversations.workspaceId, projectConversations.projectId, projectConversations.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.agentId], foreignColumns: [agents.workspaceId, agents.id] }).onDelete('cascade'),
]);

export const assistantProposals = pgTable('assistant_proposals', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  runId: uuid('run_id').notNull().unique(),
  ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  fact: text('fact').notNull(),
  interpretation: text('interpretation').notNull(),
  changeType: text('change_type', { enum: ['result'] }).notNull(),
  resultTitle: text('result_title').notNull(),
  resultFinding: text('result_finding', { enum: ['positive', 'negative'] }).notNull(),
  resultEvidence: text('result_evidence').notNull().default(''),
  finishesWorkId: uuid('finishes_work_id'),
  status: text('status', { enum: ['proposed', 'accepted', 'dismissed'] }).notNull().default('proposed'),
  decidedBy: text('decided_by').references(() => authUsers.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  resultId: uuid('result_id'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('assistant_proposals_project_idx').on(table.projectId, table.createdAt, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.runId], foreignColumns: [personalRuns.workspaceId, personalRuns.projectId, personalRuns.id] }).onDelete('cascade'),
]);


// Durable co-work control metadata (#153, migration0035). Domain content stays native.
export const coworkConnectionSlots = pgTable('cowork_connection_slots', {
  connectionId: uuid('connection_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.connectionId], foreignColumns: [agentConnections.workspaceId, agentConnections.id] }).onDelete('cascade'),
]);

export const coworkUnits = pgTable('cowork_units', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('work_id').notNull(),
  runId: uuid('run_id').notNull(),
  lineageTaskId: uuid('lineage_work_id').notNull(),
  unitKey: text('unit_key').notNull(),
  role: text('role', { enum: ['execute', 'review', 'plan'] }).notNull(),
  assignmentConnectionId: uuid('assignment_connection_id').notNull(),
  state: text('state', { enum: ['pending', 'claimed', 'paused', 'completed', 'stopped'] }).notNull().default('pending'),
  generation: integer('generation').notNull().default(0),
  version: integer('version').notNull().default(1),
  leaseId: uuid('lease_id'),
  leaseSessionId: text('lease_session_id'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  checkpointId: uuid('checkpoint_id'),
  /** 0054: the exact native outcome reference of a completed unit; null otherwise. */
  outcomeRef: jsonb('outcome_ref').$type<CoWorkSourceRef>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  unique().on(table.workspaceId, table.projectId, table.id),
  unique().on(table.workspaceId, table.projectId, table.taskId, table.runId, table.unitKey),
  unique().on(table.workspaceId, table.projectId, table.taskId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.lineageTaskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.id, table.checkpointId], foreignColumns: [coworkCheckpoints.workspaceId, coworkCheckpoints.projectId, coworkCheckpoints.unitId, coworkCheckpoints.id] }),
  index('cowork_units_connection_idx').on(table.assignmentConnectionId, table.state, table.leaseExpiresAt),
  index('cowork_units_work_idx').on(table.workspaceId, table.projectId, table.taskId),
]);

export const coworkCheckpoints = pgTable('cowork_checkpoints', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  unitId: uuid('unit_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  runtimeSessionId: text('runtime_session_id').notNull(),
  generation: integer('generation').notNull(),
  progress: jsonb('progress').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  unique().on(table.workspaceId, table.projectId, table.unitId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.unitId], foreignColumns: [coworkUnits.workspaceId, coworkUnits.projectId, coworkUnits.id] }).onDelete('cascade'),
]);

export const coworkRequestLineages = pgTable('cowork_request_lineages', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  taskId: uuid('root_work_id').notNull(), runId: uuid('run_id').notNull(),
  maximumRequests: integer('maximum_requests').notNull(), maximumDepth: integer('maximum_depth').notNull(),
  maximumReviewRounds: integer('maximum_review_rounds').notNull(),
  createdRequests: integer('created_requests').notNull().default(0), reviewRequests: integer('review_requests').notNull().default(0),
}, (table) => [
  unique().on(table.workspaceId, table.projectId, table.taskId, table.runId), unique().on(table.workspaceId, table.projectId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
]);
export const coworkRequests = pgTable('cowork_requests', {
  id: uuid('id').primaryKey(), lineageId: uuid('lineage_id').notNull(), workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(), taskId: uuid('work_id').notNull(), unitId: uuid('unit_id').notNull(),
  senderConnectionId: uuid('sender_connection_id').notNull(), recipientConnectionId: uuid('recipient_connection_id').notNull(),
  senderOwnerId: text('sender_owner_id').notNull(), recipientOwnerId: text('recipient_owner_id').notNull(),
  intentKey: text('intent_key').notNull(), fingerprint: text('fingerprint').notNull(), parentRequestId: uuid('parent_request_id'),
  kind: text('kind', { enum: ['help', 'review', 'fix', 'handoff'] }).notNull(),
  target: jsonb('target').$type<CoWorkSourceRef>().notNull(), sourceRefs: jsonb('source_refs').$type<CoWorkSourceRef[]>().notNull(),
  criteriaRefs: jsonb('criteria_refs').$type<CoWorkSourceRef[]>().notNull(),
  depth: integer('depth').notNull(), reviewRound: integer('review_round').notNull(), priority: integer('priority').notNull(),
  peerUnblocking: boolean('peer_unblocking').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  state: text('state', { enum: ['queued', 'deferred', 'claimed', 'resolved', 'declined', 'superseded', 'expired', 'cancelled'] }).notNull().default('queued'),
  version: integer('version').notNull().default(1), reason: text('reason'), nextBoundary: text('next_boundary'),
  dependencyRef: jsonb('dependency_ref').$type<CoWorkSourceRef>(),
  claimedGeneration: integer('claimed_generation'), responseRef: jsonb('response_ref').$type<CoWorkSourceRef>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  unique().on(table.lineageId, table.intentKey), unique().on(table.lineageId, table.id),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.lineageId], foreignColumns: [coworkRequestLineages.workspaceId, coworkRequestLineages.projectId, coworkRequestLineages.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.projectId, table.taskId, table.unitId], foreignColumns: [coworkUnits.workspaceId, coworkUnits.projectId, coworkUnits.taskId, coworkUnits.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.lineageId, table.parentRequestId], foreignColumns: [coworkRequests.lineageId, coworkRequests.id] }),
  index('cowork_requests_recipient_idx').on(table.workspaceId, table.projectId, table.recipientConnectionId, table.createdAt, table.id),
]);
export const coworkDeliveryIntents = pgTable('cowork_delivery_intents', {
  id: uuid('id').primaryKey(), requestId: uuid('request_id').notNull().unique().references(() => coworkRequests.id, { onDelete: 'cascade' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
// Project GitHub App integration (#74). Credentials/inbox are internal; public
// facts require current Flux + GitHub repository proof, including history reads.
export const githubCredentials = pgTable('github_credentials', {
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  host: text('host').notNull().default('github.com'), generation: uuid('generation').notNull(),
  githubUserId: text('github_user_id').notNull(), appId: text('app_id').notNull(),
  encryptedTokens: text('encrypted_tokens'), expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
  state: text('state', { enum: ['active', 'refreshing', 'uncertain', 'revoked'] }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.host] })]);
export const githubOauthFlows = pgTable('github_oauth_flows', {
  stateHash: text('state_hash').primaryKey(), id: uuid('id').notNull(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => authSessions.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  purpose: text('purpose', { enum: ['authorize', 'install'] }).notNull(),
  encryptedVerifier: text('encrypted_verifier'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade')]);
export const githubBindings = pgTable('github_bindings', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  host: text('host').notNull().default('github.com'), installationId: text('installation_id').notNull(), repositoryId: text('repository_id').notNull(),
  owner: text('owner').notNull(), name: text('name').notNull(), private: boolean('private').notNull(), url: text('url').notNull(),
  authorUserId: text('author_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  authorGithubUserId: text('author_github_user_id').notNull(), appId: text('app_id').notNull(), authorizationGeneration: uuid('authorization_generation').notNull(),
  state: text('state', { enum: ['active', 'disconnected', 'revoked'] }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.workspaceId, t.projectId, t.id), unique().on(t.projectId, t.host, t.repositoryId),
  foreignKey({ columns: [t.workspaceId, t.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade')]);
export const githubTaskLinks = pgTable('github_task_links', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(), bindingId: uuid('binding_id').notNull(), pullId: text('pull_id').notNull(),
  role: text('role', { enum: ['required_output', 'related'] }).notNull(),
  facts: jsonb('facts').$type<import('@flux/contracts').GithubPullFacts>().notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  state: text('state', { enum: ['current', 'stale', 'unavailable'] }).notNull().default('current'),
}, (t) => [unique().on(t.taskId, t.bindingId, t.pullId, t.role),
  foreignKey({ columns: [t.workspaceId, t.projectId, t.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.workspaceId, t.projectId, t.bindingId], foreignColumns: [githubBindings.workspaceId, githubBindings.projectId, githubBindings.id] }).onDelete('cascade')]);
export const githubDeliveries = pgTable('github_deliveries', {
  id: text('id').primaryKey(), appId: text('app_id').notNull(), digest: text('digest').notNull(), event: text('event').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  installationId: text('installation_id'), repositoryId: text('repository_id'), providerObjectId: text('provider_object_id'),
  targetBindingId: uuid('target_binding_id').references(() => githubBindings.id, { onDelete: 'set null' }),
  origin: text('origin', { enum: ['webhook', 'reconcile'] }).notNull(), receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
export const githubProcessing = pgTable('github_processing', {
  deliveryId: text('delivery_id').notNull().references(() => githubDeliveries.id, { onDelete: 'cascade' }),
  bindingId: uuid('binding_id').notNull().references(() => githubBindings.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['pending', 'completed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  errorCode: text('error_code'),
}, (t) => [primaryKey({ columns: [t.deliveryId, t.bindingId] }), index('github_processing_due_idx').on(t.state, t.nextAttemptAt)]);
export const githubBridgeOutbox = pgTable('github_bridge_outbox', {
  id: uuid('id').primaryKey(), deliveryId: text('delivery_id').notNull(), bindingId: uuid('binding_id').notNull(),
  linkId: uuid('link_id').notNull().references(() => githubTaskLinks.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  headSha: text('head_sha').notNull(), event: text('event').notNull(), providerObjectId: text('provider_object_id'), correlationKey: text('correlation_key').notNull(),
  state: text('state').notNull().default('pending_audience_adapter'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.deliveryId, t.bindingId, t.linkId), unique().on(t.bindingId, t.linkId, t.correlationKey)]);
// "Let linked PRs move this task" (#74 G-1a, migration 0052): one rule per task, its automatic changes and the project default.
const WORK_STATUS = ['open', 'in_progress', 'blocked', 'done', 'not_pursued'] as const;
export const githubTaskRules = pgTable('github_task_rules', {
  taskId: uuid('task_id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  mode: text('mode', { enum: ['complete', 'ready'] }).notNull(),
  state: text('state', { enum: ['active', 'suspended', 'off'] }).notNull(),
  suspendedReason: text('suspended_reason', { enum: ['manual_change', 'author_access', 'repository_unavailable'] }),
  authorUserId: text('author_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  authorGithubUserId: text('author_github_user_id').notNull(), authorGeneration: uuid('author_generation').notNull(), appId: text('app_id').notNull(),
  expectedVersion: integer('expected_version').notNull(), expectedStatus: text('expected_status', { enum: WORK_STATUS }).notNull(),
  expectedBlocker: text('expected_blocker'), blockedBy: text('blocked_by', { enum: ['check', 'closed'] }),
  readyToClose: boolean('ready_to_close').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.projectId, t.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade')]);
export const githubTaskRuleChanges = pgTable('github_task_rule_changes', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(), taskId: uuid('task_id').notNull(),
  code: text('code', { enum: ['pull_open', 'pull_reopened', 'check_failed', 'checks_passed', 'pull_closed', 'merged_done', 'merged_ready', 'suspended_manual', 'suspended_access', 'suspended_repository'] }).notNull(),
  fromStatus: text('from_status', { enum: WORK_STATUS }).notNull(), toStatus: text('to_status', { enum: WORK_STATUS }).notNull(),
  blocker: text('blocker'), readyToClose: boolean('ready_to_close').notNull(),
  authorUserId: text('author_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  linkId: uuid('link_id'), pullNumber: integer('pull_number'), headSha: text('head_sha'), checkName: text('check_name'),
  deliveryId: text('delivery_id'), bindingId: uuid('binding_id').notNull(), origin: text('origin', { enum: ['webhook', 'reconcile', 'binding'] }).notNull(),
  taskVersion: integer('task_version').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.taskId, t.deliveryId, t.bindingId), index('github_task_rule_changes_task_idx').on(t.taskId, t.createdAt, t.id),
  foreignKey({ columns: [t.workspaceId, t.projectId, t.taskId], foreignColumns: [projectWorkItems.workspaceId, projectWorkItems.projectId, projectWorkItems.id] }).onDelete('cascade')]);
export const githubRuleDefaults = pgTable('github_rule_defaults', {
  projectId: uuid('project_id').primaryKey(), workspaceId: uuid('workspace_id').notNull(),
  mode: text('mode', { enum: ['complete', 'ready'] }),
  setByUserId: text('set_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete('cascade')]);
