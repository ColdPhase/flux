import type { Workspace } from './access.js';

/**
 * Encrypted workspaces (F-030, #655; docs/product/encrypted-workspaces.md). Wire types of the keys,
 * the unlock lifecycle and the encryption state of a workspace. Every command here needs a live
 * session, passes the origin check, answers `Cache-Control: no-store` and never uses the
 * Idempotency-Key store (its request hash would be a fast hash of a password).
 */

/** `POST`: creates an encrypted workspace. Until S3 it exists only with `FLUX_FIXTURE_TOKEN` set. */
export const ENCRYPTED_WORKSPACES_PATH = '/api/v1/encrypted-workspaces';
export const workspaceUnlockPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/unlock`;
export const workspaceLockPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/lock`;
export const workspaceUnlockGrantsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/unlock-password-grants`;
export const workspaceUnlockPasswordPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/unlock-password`;
export const workspaceRecoveryCodePath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/recovery-code`;

/**
 * `Workspace.encryption`: null for a plain workspace. `myPassword` and `canUnlock` are filled for owners and
 * admins; members and guests get `false`. `rotation` is null unless a key rotation is pending or running (S2c).
 */
export interface WorkspaceEncryption {
  state: 'locked' | 'unlocked';
  unlockedAt: string | null;
  unlockedBy: { id: string; name: string } | null;
  /** The caller has an unlock password here. */
  myPassword: boolean;
  /** The caller may unlock now: an owner or admin with a password, or with the recovery code while one exists. */
  canUnlock: boolean;
  /**
   * When a holder's permission for the caller to set a first unlock password ends; null when there is none, the caller
   * already has a password, or the caller is not an owner or admin. The recovery code is the other way to a first password.
   */
  passwordGrantUntil: string | null;
  /** The workspace has a recovery code. */
  recoveryCode: boolean;
  /**
   * A pending or running rotation (S2c): `percent` of the estimated sealed values done in this pass, `paused` while the
   * space is locked (or pending until its next unlock), `startedAt` when the current pass target was made (null while pending).
   */
  rotation: null | {
    percent: number; paused: boolean; startedAt: string | null;
    /** It cannot finish (an old value that does not open, a copy outside the registry, or write load); holders are told. */
    stalled: boolean;
    /** Who the new key opens for ("The new key opens for Ada and Cy."): owners and admins see it, others get []. */
    openFor: { userId: string | null; name: string; kind: 'password' | 'recovery' }[];
    /** Why ("after Ben left"); null for guests. `holder_deleted`: an unlock password deleted by an account deletion. */
    reason: { kind: 'removed' | 'demoted' | 'holder_deleted'; userId: string | null; name: string | null } | null;
  };
  /** When the key last changed by a rotation; null while the creation key is current. */
  keyChangedAt: string | null;
}

export interface CreateEncryptedWorkspaceCommand {
  name: string;
  /** The client's id for retries: the same person and id again answers the same workspace without the code. */
  creationId: string;
  /** The creator's unlock password. */
  password: string;
}

/** `recoveryCode` is returned exactly once, on the first answer; a retry gets null. */
export interface CreateEncryptedWorkspaceResult {
  workspace: Workspace;
  recoveryCode: string | null;
}

/** Exactly one of the two. */
export interface UnlockWorkspaceCommand { password?: string; recoveryCode?: string }
export interface EncryptionStateResult { encryption: WorkspaceEncryption }

/** A holder lets an owner or admin without a password set one, with the holder's own password. Valid one hour. */
export interface GrantUnlockPasswordCommand { userId: string; password: string }
export interface GrantUnlockPasswordResult { expiresAt: string }

/**
 * Sets or changes the caller's unlock password. Changing needs `currentPassword` or `recoveryCode`; a first
 * password needs a valid grant or `recoveryCode`.
 */
export interface SetUnlockPasswordCommand { currentPassword?: string; recoveryCode?: string; newPassword: string }

/** Owner only: replaces the recovery code; the old one stops working. */
export interface NewRecoveryCodeCommand { password: string }
export interface NewRecoveryCodeResult { recoveryCode: string }

/** The refusal of every content read or write of a sealed workspace while it is locked. */
export const WORKSPACE_LOCKED = 'WORKSPACE_LOCKED';
export const ENCRYPTION_ERROR_CODES = [
  'WORKSPACE_LOCKED', 'UNLOCK_INCORRECT', 'UNLOCK_RATE_LIMITED', 'UNLOCK_BUSY', 'NO_UNLOCK_PASSWORD', 'KEYRING_UNAVAILABLE',
  'SWAP_UNSAFE', 'PASSWORD_TOO_WEAK', 'LAST_UNLOCK_PASSWORD', 'ALREADY_HAS_PASSWORD', 'UNLOCK_PASSWORD_GRANT_REQUIRED',
  'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED', 'WORKSPACE_ENCRYPTED_AI_OFF', 'ENCRYPTION_TAMPERED', 'WORKSPACE_NOT_ENCRYPTED', 'WORKSPACE_ENCRYPTED_UNSUPPORTED',
] as const;
export type EncryptionErrorCode = typeof ENCRYPTION_ERROR_CODES[number];

/** Own unlock passwords: at least this many characters after NFC normalisation... */
export const UNLOCK_PASSWORD_MIN_LENGTH = 20;
/** ...and a strength estimate of at least 10^17 guesses (zxcvbn-ts `guessesLog10`). */
export const UNLOCK_PASSWORD_MIN_GUESSES_LOG10 = 17;
/** Failed password or code checks per person and workspace, across every checking route, in the window. */
export const UNLOCK_ATTEMPT_LIMIT = 5;
export const UNLOCK_ATTEMPT_WINDOW_SECONDS = 15 * 60;
/** How long a holder's grant lets an owner or admin set a first password. */
export const UNLOCK_GRANT_SECONDS = 60 * 60;

/** Events: ids only, for the workspace's people (never delivered to an agent). */
export const WORKSPACE_UNLOCKED_EVENT = 'workspace.unlocked.v1';
export const WORKSPACE_LOCKED_EVENT = 'workspace.locked.v1';
export const WORKSPACE_UNLOCK_PASSWORD_GRANTED_EVENT = 'workspace.unlock_password_granted.v1';
export const WORKSPACE_UNLOCK_PASSWORD_SET_EVENT = 'workspace.unlock_password_set.v1';
/** A holder, wrap or key version failed verification: the workspace stays locked (F-030, Authenticating holders and wraps). */
export const WORKSPACE_ENCRYPTION_TAMPERED_EVENT = 'workspace.encryption_tampered.v1';
/** S2c: a rotation started (`{ version, holders }`, ids only: who received the new key) and finished (`{ version }`). */
export const WORKSPACE_KEY_ROTATION_STARTED_EVENT = 'workspace.key_rotation_started.v1';
export const WORKSPACE_KEY_ROTATED_EVENT = 'workspace.key_rotated.v1';
export const WORKSPACE_ENCRYPTION_EVENTS = [WORKSPACE_UNLOCKED_EVENT, WORKSPACE_LOCKED_EVENT, WORKSPACE_UNLOCK_PASSWORD_GRANTED_EVENT,
  WORKSPACE_UNLOCK_PASSWORD_SET_EVENT, WORKSPACE_ENCRYPTION_TAMPERED_EVENT, WORKSPACE_KEY_ROTATION_STARTED_EVENT, WORKSPACE_KEY_ROTATED_EVENT] as const;
/** `{ reason }` of `workspace.locked.v1`. */
export type WorkspaceLockReason = 'person' | 'restart';

/** Sent with every unlock; replays the work that waited while the workspace was locked (S2a). */
export const WORKSPACE_ENCRYPTION_RESUME_JOB = 'workspace-encryption.resume.v1';
/** Hourly: deletes the search change log of encrypted workspaces older than 24 hours (S2b). */
export const SEARCH_CHANGES_CLEANUP_JOB = 'search-changes.cleanup.v1';
export interface WorkspaceEncryptionResumeJob { workspaceId: string }

/**
 * Cross-workspace reads that can carry a sealed workspace's content. S1 (no content sealed yet, creation fixture-only)
 * refuses them with 423 for a member of a locked sealed workspace; S2a makes them skip it and answer `lockedWorkspaces`.
 * The event stream stays open (its events carry ids only).
 */
export const CROSS_WORKSPACE_READ_ROUTES: readonly string[] = [
  'GET /api/v1/search', 'GET /api/v1/inbox', 'GET /api/v1/needs-you', 'GET /api/v1/return',
];

/**
 * Routes that keep working while a sealed workspace is locked: workspace metadata only, each with its reason.
 * Keyed by `METHOD path` exactly as registered. Every other route answers 423 for a locked workspace's objects because
 * its repositories fail closed (S2a-2c-4); `tests/app/encryption-locked-routes.test.ts` walks every route (AC-6).
 */
export const LOCKED_ALLOWED_ROUTES: Readonly<Record<string, string>> = {
  'GET /api/v1/workspaces/:workspaceId': 'The workspace\'s name, role and encryption state, so the locked panel can be drawn',
  'GET /api/v1/workspaces/:workspaceId/members': 'Members and roles are metadata',
  'POST /api/v1/workspaces/:workspaceId/members': 'Membership is metadata',
  'PATCH /api/v1/workspaces/:workspaceId/members/:userId': 'Roles are metadata; a demotion removes the person\'s unlock password',
  'DELETE /api/v1/workspaces/:workspaceId/members/:userId': 'Leaving and removal are metadata',
  'PUT /api/v1/workspaces/:workspaceId/ai-policy': 'Answers 409 WORKSPACE_ENCRYPTED_AI_OFF for a sealed workspace',
  'POST /api/v1/workspaces/:workspaceId/unlock': 'Unlocking',
  'POST /api/v1/workspaces/:workspaceId/lock': 'Locking',
  'POST /api/v1/workspaces/:workspaceId/unlock-password-grants': 'Answers 423 itself: a grant is useful only while unlocked',
  'PUT /api/v1/workspaces/:workspaceId/unlock-password': 'Answers 423 itself unless the recovery code unlocks the key',
  'POST /api/v1/workspaces/:workspaceId/recovery-code': 'Answers 423 itself',
  // S2a-2c-4 (AC-6 walk): routes that read or change only content-free rows of a locked workspace.
  'GET /api/v1/inbox/:id': 'An encrypted workspace\'s notification is content-free (a template title, no body, an id-only link; 0124)',
  'POST /api/v1/inbox/:id/read': 'Read state of a content-free notification',
  'POST /api/v1/needs-you/:key': 'Snoozing an item: its key is ids only',
  'DELETE /api/v1/needs-you/:key': 'Dismissing an item: its key is ids only',
  'GET /api/v1/workspaces/:workspaceId/agents': 'Always empty: an encrypted workspace has no agents (F-029)',
};

const AI_ONLY = 'AI work: F-029 forces it off in an encrypted workspace before any write, so no stored response can concern one';
/**
 * The Idempotency-Key operations that store a response with no workspace (F-030 Idempotency store, S2a-2). Every other
 * command declares an object scope that the runner resolves to its workspace, so an encrypted workspace's stored responses
 * are sealed. Migration 0121 seeds `idempotency_account_operations` from this list (the registry test compares the two),
 * and a database guard refuses an unscoped row whose operation is not here.
 */
export const IDEMPOTENCY_ACCOUNT_OPERATIONS: Readonly<Record<string, string>> = {
  'POST /api/v1/workspaces': 'Creates the workspace: there is none yet, and its name is visible metadata',
  'POST /api/v1/personal-assistant': `The person's own assistant settings. ${AI_ONLY}`,
  'PATCH /api/v1/personal-assistant': `The person's own assistant settings. ${AI_ONLY}`,
  'PUT /api/v1/personal-assistant/model': `The person's own assistant model. ${AI_ONLY}`,
  'PUT /api/v1/personal-assistant/agents': `The person's own assistant agents. ${AI_ONLY}`,
  'POST /api/v1/personal-assistant/pause': `The person's own assistant. ${AI_ONLY}`,
  'POST /api/v1/personal-assistant/resume': `The person's own assistant. ${AI_ONLY}`,
  'POST /api/v1/conversations/:conversationId/assistant-runs': AI_ONLY,
  'POST /api/v1/assistant-runs/:runId/stop': AI_ONLY,
  'POST /api/v1/assistant-runs/:runId/retry': AI_ONLY,
  'POST /api/v1/agent-questions/:questionId/answer': AI_ONLY,
  'POST /api/v1/assistant-proposals/:proposalId/accept': AI_ONLY,
  'POST /api/v1/assistant-proposals/:proposalId/dismiss': AI_ONLY,
};

/** An encrypted workspace that is locked here, as cross-workspace reads name it (F-030 `lockedWorkspaces`). */
export interface LockedWorkspaceRef { id: string; name: string }

/**
 * F-030 event data (S2a-2c-3, migration 0125): in an encrypted workspace every string in an event's `data` is a UUID,
 * an ISO timestamp, a sealed envelope, an existing account id or principal key, or one of these registered values
 * (kinds, states, roles, reasons and operations the record sites write). Migration 0125 seeds `event_data_tokens` with
 * exactly this list, and `tests/app/encryption-registry.test.ts` compares the two. No free word passes.
 */
export const EVENT_DATA_TOKENS = [
  'about', 'accepted', 'admin', 'affects', 'agent', 'assigned', 'blocked', 'contributor', 'conversation', 'copied_from_dm',
  'copied_to_project', 'creation_reverted', 'decision', 'denied', 'dm', 'doc', 'done', 'group', 'guest', 'human', 'in_progress',
  'invitation', 'left', 'link_added', 'link_removed', 'link_updated', 'map', 'material', 'member', 'mention', 'mentions', 'message',
  'not_pursued', 'open', 'owner', 'pair', 'password', 'person', 'private', 'project', 'proposed', 'question', 'recovery', 'rejoined',
  'related', 'renamed', 'reply', 'restart', 'restricted', 'result', 'review', 'self', 'sketch', 'source', 'still_applies',
  'superseded', 'thought', 'thought_added', 'thought_removed', 'thought_updated', 'thoughts_moved', 'viewer', 'wiki', 'work',
  'workspace',
] as const;

/**
 * F-030 event data keys (#721 review P2-1, migration 0125): every object key in an encrypted workspace's event `data` is
 * one of these field names (the record sites' keys), a UUID or `$sealed`. Seeded into `event_data_keys`; the registry
 * test compares the two.
 */
export const EVENT_DATA_KEYS = [
  'access', 'actor', 'actorId', 'additionalProperties', 'agentId', 'agentIds', 'ai', 'assignedTo', 'at', 'audience',
  'author', 'automation', 'body', 'boundary', 'by', 'canCreateProject', 'caps', 'changed', 'changes',
  'clientCommandId', 'clientMessageId', 'code', 'columns', 'command', 'commandId', 'contentIdentity',
  'conversationId', 'createdAt', 'createdBy', 'data', 'decisionId', 'dm', 'dmId', 'docId', 'draft', 'draftId',
  'email', 'end', 'error', 'eventId', 'events', 'evidenceRef', 'expected', 'expiresAt', 'fence', 'file', 'fileId',
  'fingerprint', 'firstMessageBody', 'from', 'fromTitle', 'goal', 'goalId', 'grantId', 'hasMoreBefore', 'height', 'holders',
  'id', 'ids', 'inbox', 'index', 'input', 'intent', 'intents', 'interpretation', 'invitationId', 'items', 'keys',
  'kind', 'level', 'lifecycle', 'limit', 'link', 'linkId', 'linkIds', 'lock', 'materialId', 'maxLength', 'message',
  'messageId', 'messageIds', 'messagePage', 'messages', 'myName', 'name', 'nextBeforeSequence', 'noticeId',
  'objectId', 'observed', 'ok', 'op', 'operation', 'outcome', 'owner', 'ownerUserId', 'pairKey', 'participantIds',
  'password', 'postconditions', 'principal', 'project', 'projectId', 'prompt', 'proposalId', 'provider', 'query',
  'questionId', 'queue', 'reason', 'recipientId', 'recipients', 'record', 'recoveryCode', 'replayed', 'requestId',
  'requestedQuestion', 'required', 'resultId', 'results', 'resume', 'retained', 'retryDelay', 'retryLimit',
  'retryable', 'reviewerConnectionId', 'reviewerOwnerId', 'revision', 'role', 'rootId', 'rootMessageId', 'row',
  'runId', 'runToken', 'runtime', 'sampleId', 'scope', 'session', 'sessionId', 'sketch', 'sketchId', 'source',
  'sources', 'stage', 'state', 'status', 'step', 'stop', 'stopId', 'stopped', 'sweep', 'task', 'taskId', 'taskIds',
  'taskNoticeId', 'tell', 'text', 'thought', 'thoughtId', 'thoughtIds', 'thoughts', 'title', 'to', 'toTitle', 'tool',
  'tools', 'total', 'type', 'userId', 'value', 'verdict', 'version', 'view', 'visibility', 'waitingFor', 'width',
  'window', 'work', 'workId', 'workerId', 'workspace', 'workspaceId',
] as const;
