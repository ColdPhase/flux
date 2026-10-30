/**
 * The registry of encrypted workspaces (F-030, #655, S2a; docs/product/encrypted-workspaces.md#inventory). Every table
 * of the `public` schema has a class, and every text or jsonb column of a content table is either sealed (an envelope,
 * `SEALED_COLUMNS`) or visible metadata with a reason (`VISIBLE_COLUMNS`). `tests/app/encryption-registry.test.ts`
 * reads the live catalog after all migrations and fails on anything unlisted (default-deny), on a sealed table without
 * its plaintext backstop, and on a backstop whose column list differs from this file.
 */

/**
 * - `content`: workspace content; its text/jsonb columns are classified below.
 * - `account`: user, session, OAuth, push and preference data (not a workspace's content).
 * - `system`: schema version, queues, cursors, rate limits and the key tables of F-030 (wraps and MACs, no content).
 * - `ai`: empty for a sealed workspace (F-029 forced off; `a_sealed_workspace_no_ai` backstops each with a workspace path).
 * - `refused`: a feature not offered in a sealed workspace (GitHub, F-030 Inventory); `a_sealed_workspace_refused`
 *   backstops each table with a workspace path, so the table never holds a row of one.
 */
export type TableClass = 'content' | 'account' | 'system' | 'ai' | 'refused';

const ai = [
  'agent_command_receipts', 'agent_connection_mcp_policies', 'agent_connection_mcp_projects', 'agent_connection_projects', 'agent_connections',
  'agent_oauth_bindings', 'agent_oauth_flows', 'agent_oauth_selections', 'agent_playbook_acknowledgments', 'agent_project_policies',
  'agent_proposals', 'agent_questions', 'agent_runtime_auth_admission', 'agent_runtime_auth_operations', 'agent_runtime_bindings',
  'agent_runtime_client_history', 'agent_runtime_connections', 'agent_runtime_console_nonces', 'agent_runtime_operator_statements',
  'agent_runtime_sessions', 'agent_runtime_slots', 'agent_standing_grants', 'agent_stops', 'agent_thread_artifact_boundaries',
  'agent_thread_artifact_mutations', 'agent_thread_artifact_resets', 'agent_thread_guard_events', 'agents', 'assistant_background_notes',
  'assistant_changes', 'assistant_job_runs', 'assistant_jobs', 'assistant_join_question_identity_snapshots', 'assistant_join_requests',
  'assistant_morning_summaries', 'assistant_proposals', 'assistant_reaction_events', 'assistant_reaction_notes', 'assistant_reactions',
  'assistant_settings', 'background_compute_connections', 'cowork_checkpoints', 'cowork_connection_slots', 'cowork_delivery_intents',
  'cowork_request_lineages', 'cowork_requests', 'cowork_review_policies', 'cowork_review_verdicts', 'cowork_units', 'personal_run_agents',
  'personal_run_enablements', 'personal_runs', 'proactive_comparison_cursor', 'proactive_comparison_insufficient_outcomes',
  'proactive_comparison_outbox', 'proactive_comparison_project_changes', 'proactive_comparison_proposals', 'proactive_comparison_rules',
] as const;
const account = [
  'auth_accounts', 'auth_email_claims', 'auth_identity_audit', 'auth_idp_standing', 'auth_link_intents', 'auth_logout_tokens',
  'auth_session_identities', 'auth_sessions', 'auth_users', 'auth_verifications', 'oauth_access_token', 'oauth_client', 'oauth_client_assertion',
  'oauth_client_resource', 'oauth_consent', 'oauth_grant_authentication', 'oauth_refresh_token', 'oauth_resource', 'jwks', 'push_subscriptions',
  'notification_addresses', 'notification_address_tokens', 'notification_preferences', 'notification_verification_sends', 'github_credentials',
  'github_oauth_flows',
] as const;
const system = [
  'flux_schema_version', 'outbox', 'file_garbage', 'notification_cursor', 'password_attempts', 'samples', 'sample_results', 'live_access_fences',
  'live_webhook_events', 'sealed_job_waits', 'workspace_keys', 'workspace_holders', 'workspace_dek_wraps', 'workspace_key_versions',
  'workspace_unlocks', 'workspace_removed_holders', 'workspace_removals', 'workspace_rotation_progress', 'workspace_wrap_grants', 'idempotency_account_operations',
] as const;
const refused = [
  'github_bindings', 'github_bridge_outbox', 'github_deliveries', 'github_processing', 'github_rule_defaults', 'github_task_links',
  'github_task_rule_changes', 'github_task_rules',
] as const;
const content = [
  'workspaces', 'workspace_members', 'workspace_ai_policies', 'projects', 'project_grants', 'project_goals', 'project_conversations',
  'project_messages', 'message_references', 'project_message_observations', 'dm_message_observations', 'return_points', 'dms', 'dm_participants', 'dm_messages',
  'project_materials', 'project_material_versions', 'project_work_items', 'project_task_activity', 'project_task_updates', 'project_task_notices',
  'project_task_plan_intents', 'project_task_dependencies', 'project_task_discussions', 'task_creation_undo_receipts', 'native_command_receipts',
  'project_decisions', 'project_results', 'project_object_links', 'drafts', 'draft_versions', 'draft_results', 'sketches', 'sketch_thoughts',
  'sketch_links', 'project_files', 'doc_live_heads', 'doc_live_archives', 'doc_live_updates', 'doc_live_snapshots', 'doc_live_presence',
  'doc_live_replicas', 'map_live_presence', 'map_live_gestures', 'map_live_heads', 'map_live_journal', 'map_live_object_versions', 'map_live_undone',
  'live_editing_intents', 'notifications', 'notification_generation_failures', 'notification_emails', 'notification_mutes', 'needs_you_states',
  'events', 'event_audience', 'idempotency_keys', 'search_documents', 'search_changes', 'live_sessions', 'live_presentations', 'live_invitations',
  'live_admissions',
] as const;

export const TABLE_CLASSES: Readonly<Record<string, TableClass>> = Object.freeze(Object.fromEntries([
  ...ai.map((t) => [t, 'ai'] as const), ...account.map((t) => [t, 'account'] as const), ...system.map((t) => [t, 'system'] as const),
  ...refused.map((t) => [t, 'refused'] as const), ...content.map((t) => [t, 'content'] as const),
]));

/** `text`: the envelope string. `json`: a jsonb column holding `{"$sealed": envelope}` of the value's JSON. `digest`: a sealed SHA-256 hex. */
export type SealedKind = 'text' | 'json' | 'digest';

export interface SealedColumn {
  readonly kind: SealedKind;
  /** The registry field in the AAD; `table.column` unless SQL copies the value (only `doc_live.*`). */
  readonly field: string;
}

/** How the backstop finds a row's workspace: its own column, or through a parent table. */
export type WorkspacePath = 'workspace_id' | { readonly column: string; readonly table: string; readonly key: string };

export interface SealedTable {
  /** The row's identity in the AAD: its primary-key columns, in order. */
  readonly identity: readonly string[];
  readonly workspace: WorkspacePath;
  readonly columns: Readonly<Record<string, SealedColumn>>;
  /**
   * The slice whose repositories seal this table. Every sealed table has its plaintext backstop from S2a-1 on, so a
   * table whose repository does not seal yet refuses a sealed workspace's writes (fail closed) instead of storing text.
   */
  readonly sealedBy: 'S2a-1' | 'S2a-2' | 'S2b';
}

const text = (field: string): SealedColumn => ({ kind: 'text', field });
const json = (field: string): SealedColumn => ({ kind: 'json', field });
const digest = (field: string): SealedColumn => ({ kind: 'digest', field });
function table(name: string, identity: string[], columns: Record<string, SealedKind>, sealedBy: SealedTable['sealedBy'],
  workspace: WorkspacePath = 'workspace_id', fields: Record<string, string> = {}): [string, SealedTable] {
  const make = { text, json, digest };
  return [name, { identity, workspace, sealedBy,
    columns: Object.fromEntries(Object.entries(columns).map(([column, kind]) => [column, make[kind](fields[column] ?? `${name}.${column}`)])) }];
}
const viaDoc = { column: 'doc_id', table: 'project_materials', key: 'id' } as const;
const viaSketch = { column: 'sketch_id', table: 'sketches', key: 'id' } as const;

export const SEALED_COLUMNS: Readonly<Record<string, SealedTable>> = Object.freeze(Object.fromEntries([
  table('projects', ['id'], { name: 'text' }, 'S2a-1'),
  table('project_goals', ['id'], { title: 'text' }, 'S2a-1'),
  table('project_messages', ['id'], { body: 'text', request_fingerprint: 'digest' }, 'S2a-1'),
  table('dms', ['id'], { title: 'text' }, 'S2a-1'),
  table('dm_messages', ['id'], { body: 'text', request_fingerprint: 'digest' }, 'S2a-1'),
  table('project_decisions', ['id'], { title: 'text', rationale: 'text' }, 'S2a-1'),
  table('project_results', ['id'], { title: 'text', evidence: 'text' }, 'S2a-1'),
  table('drafts', ['id'], { title: 'text', body: 'text' }, 'S2a-1'),
  table('draft_versions', ['draft_id', 'version'], { title: 'text', body: 'text' }, 'S2a-1', { column: 'draft_id', table: 'drafts', key: 'id' }),
  table('idempotency_keys', ['principal', 'operation', 'key'], { response_body: 'json', request_hash: 'digest' }, 'S2a-1'),
  table('project_work_items', ['id'], { title: 'text', outcome: 'text', blocker: 'text', criteria: 'json', creation_baseline: 'json', request_fingerprint: 'digest' }, 'S2a-2'),
  table('project_task_activity', ['id'], { detail: 'json' }, 'S2a-2'),
  table('project_task_updates', ['id'], { reason: 'text' }, 'S2a-2'),
  table('project_task_plan_intents', ['project_id', 'material_id', 'material_version', 'intent_key'], { creation_fingerprint: 'digest' }, 'S2a-2'),
  table('task_creation_undo_receipts', ['project_id', 'actor_kind', 'actor_id', 'client_command_id'], { request_fingerprint: 'digest' }, 'S2a-2'),
  table('native_command_receipts', ['project_id', 'actor_kind', 'actor_id', 'operation', 'client_command_id'], { request_fingerprint: 'digest' }, 'S2a-2'),
  table('project_materials', ['id'], { request_fingerprint: 'digest' }, 'S2a-2'),
  table('project_material_versions', ['material_id', 'version'], { title: 'text', body: 'text', url: 'text', reason: 'text', request_fingerprint: 'digest' }, 'S2a-2'),
  table('sketches', ['id'], { title: 'text' }, 'S2a-2'),
  table('sketch_thoughts', ['id'], { text: 'text' }, 'S2a-2'),
  table('sketch_links', ['id'], { label: 'text' }, 'S2a-2'),
  table('project_files', ['id'], { name: 'text', sha256: 'digest' }, 'S2a-2'),
  table('doc_live_heads', ['doc_id', 'generation'], { body: 'text', codec_state: 'json', hash: 'digest' }, 'S2b', 'workspace_id',
    { body: 'doc_live.body', codec_state: 'doc_live.codec_state', hash: 'doc_live.hash' }),
  table('doc_live_archives', ['doc_id', 'generation'], { body: 'text', codec_state: 'json', hash: 'digest' }, 'S2b', viaDoc,
    { body: 'doc_live.body', codec_state: 'doc_live.codec_state', hash: 'doc_live.hash' }),
  table('doc_live_updates', ['doc_id', 'generation', 'sequence'], { bytes: 'text', ledger: 'json', fingerprint: 'digest' }, 'S2b', viaDoc),
  table('doc_live_snapshots', ['doc_id', 'version'], { hash: 'digest' }, 'S2b'),
  table('live_editing_intents', ['actor_id', 'command_id'], { receipt: 'json', fingerprint: 'digest' }, 'S2b'),
  table('map_live_journal', ['sketch_id', 'generation', 'sequence'], { change: 'json', fingerprint: 'digest' }, 'S2b', viaSketch),
]));

/** Every text or jsonb column of a content table that stays visible, with why it carries no content. */
export const VISIBLE_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  workspaces: { name: 'shown to members while locked ("Garden club is waiting to be unlocked")', created_by: 'a user id' },
  workspace_members: { user_id: 'a user id', role: 'an enum', created_by: 'a user id' },
  workspace_ai_policies: { state: 'an enum', changed_by: 'a user id' },
  projects: { visibility: 'an enum', created_by: 'a user id', views: 'enum values' },
  project_grants: { user_id: 'a user id', role: 'an enum', created_by: 'a user id' },
  project_goals: { set_by: 'a user id', reached_by: 'a user id' },
  project_conversations: { created_by: 'a user id', space: 'an enum' },
  project_messages: { author_id: 'a user id', contribution_kind: 'an enum' },
  message_references: { kind: 'an enum (thought or message)' },
  project_message_observations: { viewer_id: 'a user id' },
  dm_message_observations: { viewer_id: 'a user id' },
  return_points: { user_id: 'a user id', place_key: 'object ids and positions', place_type: 'an enum' },
  dms: { kind: 'an enum', pair_key: 'user ids', created_by: 'a user id' },
  dm_participants: { user_id: 'a user id' },
  dm_messages: { author_id: 'a user id' },
  project_materials: { created_by: 'a user id', kind: 'an enum' },
  project_material_versions: { author_id: 'a user id', state: 'an enum' },
  project_work_items: { status: 'an enum', owner_user_id: 'a user id', created_by_kind: 'an enum', created_by_id: 'a principal id',
    creation_origin: 'an enum', creation_reverted_by_kind: 'an enum', creation_reverted_by_id: 'a principal id', waiting_for_user_id: 'a user id' },
  project_task_activity: { kind: 'an enum (status, owner, due or title changed)', actor_kind: 'an enum', actor_id: 'a principal id' },
  project_task_updates: { kind: 'an enum', created_by_kind: 'an enum', created_by_id: 'a principal id', waiting_for_user_id: 'a user id' },
  project_task_notices: { kind: 'an enum', created_by_kind: 'an enum', created_by_id: 'a principal id', sources: 'object refs (types and ids)' },
  project_task_plan_intents: { intent_key: 'client-chosen opaque key; the web client sends random UUIDs (F-030 Client-chosen visible text)' },
  task_creation_undo_receipts: { actor_kind: 'an enum', actor_id: 'a principal id' },
  native_command_receipts: { actor_kind: 'an enum', actor_id: 'a principal id', operation: 'an operation name' },
  project_decisions: { status: 'an enum', proposed_by_kind: 'an enum', proposed_by_id: 'a principal id', decided_by: 'a user id' },
  project_results: { finding: 'an enum (positive or negative)', created_by_kind: 'an enum', created_by_id: 'a principal id' },
  project_object_links: { role: 'an enum', from_type: 'an enum', to_type: 'an enum', created_by_kind: 'an enum', created_by_id: 'a principal id' },
  drafts: { owner_user_id: 'a user id', visibility: 'an enum', created_by: 'a user id' },
  draft_versions: { visibility: 'an enum' },
  draft_results: { principal_kind: 'an enum', principal_id: 'a principal id', status: 'an enum', denied_at_stage: 'an enum', job_id: 'a queue id' },
  sketches: { scope: 'an enum', created_by_user_id: 'a user id', copied_by_user_id: 'a user id' },
  sketch_thoughts: { shape: 'an enum', placement_type: 'an enum', created_by_user_id: 'a user id', source_author_id: 'a user id',
    source_author_name: 'a person\'s name (account data)' },
  sketch_links: { created_by_user_id: 'a user id' },
  project_files: { uploader_id: 'a user id', state: 'an enum' },
  doc_live_presence: { actor_id: 'a principal id', session_id: 'a session id', cursor: 'Yjs relative positions in a 5–30 s lease, no text' },
  doc_live_replicas: { owner_kind: 'an enum', actor_id: 'a principal id' },
  doc_live_updates: { actor_id: 'a principal id' },
  doc_live_snapshots: { contributors: 'people ids' },
  map_live_presence: { actor_id: 'a principal id', session_id: 'a session id', selected: 'thought ids', cursor: 'coordinates in a lease' },
  map_live_gestures: { actor_id: 'a principal id', session_id: 'a session id', thoughts: 'thought ids', positions: 'coordinates in a lease' },
  map_live_journal: { actor_kind: 'an enum', actor_id: 'a principal id' },
  map_live_object_versions: { kind: 'an enum' },
  live_editing_intents: { actor_id: 'a principal id', kind: 'an enum', operation: 'an operation name' },
  notifications: { user_id: 'a user id', source_type: 'an enum', title: 'content-free for a sealed workspace (backstopped)',
    body: 'empty for a sealed workspace (backstopped)', url: 'ids', reason: 'an enum', delivery_kind: 'an enum', summary_sources: 'object refs' },
  notification_generation_failures: { last_error: 'an error class and code only for a sealed workspace (error paths, S2a-2)' },
  notification_emails: { user_id: 'a user id', address_kind: 'an enum', address: 'an account e-mail address', status: 'an enum',
    skip_reason: 'a code only for a sealed workspace (error paths, S2a-2)', unsubscribe_hash: 'a token hash', last_error: 'an error class and code only for a sealed workspace (error paths, S2a-2)' },
  notification_mutes: { user_id: 'a user id', source_type: 'an enum' },
  needs_you_states: { user_id: 'a user id', item_key: 'object ids', state: 'an enum' },
  events: { kind: 'an event kind', actor_id: 'a principal id', data: 'ids, versions and enums only (backstopped for a sealed workspace)' },
  event_audience: { recipient: 'a principal key' },
  idempotency_keys: { principal: 'a principal key', operation: 'an operation name', key: 'client-chosen; the web client sends random UUIDs',
    response_etag: 'a version tag' },
  search_documents: { doc_key: 'object ids', kind: 'an enum', audience_key: 'ids', object_id: 'an id', status: 'an enum',
    title: 'empty in a placeholder row of a sealed workspace', body: 'empty in a placeholder row of a sealed workspace', author_kind: 'an enum',
    author_id: 'a principal id', tsv: 'empty in a placeholder row of a sealed workspace',
    keys: 'hashed search keys, generated from title and body: empty in a placeholder row' },
  search_changes: { doc_key: 'object ids' },
  live_sessions: { created_by: 'a user id', state: 'an enum', room_id: 'a room id' },
  live_presentations: { created_by: 'a user id', ref_type: 'an enum' },
  live_invitations: { inviter_id: 'a user id', recipient_id: 'a user id', response: 'an enum' },
  live_admissions: { id: 'an id', user_id: 'a user id', auth_session_id: 'a session id' },
});

/** The table whose rows a sealed table's backstop and the seal resolve the workspace through. */
export function sealedTable(name: string): SealedTable | null {
  return SEALED_COLUMNS[name] ?? null;
}
