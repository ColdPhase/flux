import { sql, type SQL } from 'drizzle-orm';
import type { CoWorkRequestKind, CoWorkRequestState, CoWorkRequestStatus, CoWorkReviewRule, CoWorkSourceRef } from '@flux/contracts';
import type { DbExecutor } from './push.js';

// The task's request cards, handoff packets, cancellation and the project's review rule (#153 AC-2/AC-4, #400 AC-4).
// Storage only: the server composition has already authorized the caller for the project. Nothing here claims, resolves,
// acknowledges or defers a request, writes a stream event or invokes a model, and no content of a source is copied:
// a reference becomes a bounded title only while it exists at the exact version the request named.

/** The bounded title of a message or thought; the rest of its text stays in its own record. */
const TITLE_LIMIT = 120;
const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
};

/** What a person may be told about one reference now. `title` is null whenever `available` is false. */
export interface CoWorkReferenceFact {
  ref: CoWorkSourceRef;
  available: boolean;
  title: string | null;
  /** For a message only: where to open it. */
  message: { conversationId: string; space: 'people' | 'agents'; taskId: string | null } | null;
}
export const referenceKey = (ref: CoWorkSourceRef) => ref.type === 'github_pr' ? `github_pr:${ref.linkId}:${ref.headSha}`
  : `${ref.type}:${ref.id}:${'version' in ref ? ref.version : ''}`;

/** One request as the task's people and its packet read it. Owners are internal: only their names and the cancel rule use them. */
export interface CoWorkCardRow {
  id: string;
  kind: CoWorkRequestKind;
  /** Expiry applied: a request past its expiry reads `expired`. */
  state: CoWorkRequestState;
  status: CoWorkRequestStatus;
  version: number;
  reason: string | null;
  nextBoundary: string | null;
  priority: number;
  peerUnblocking: boolean;
  target: CoWorkSourceRef;
  sourceRefs: CoWorkSourceRef[];
  criteriaRefs: CoWorkSourceRef[];
  responseRef: CoWorkSourceRef | null;
  unitId: string;
  taskId: string;
  senderConnectionId: string;
  senderName: string;
  senderOwnerId: string;
  senderOwnerName: string;
  recipientConnectionId: string;
  recipientName: string;
  recipientOwnerId: string;
  recipientOwnerName: string;
  cancelledById: string | null;
  cancelledByName: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface CoWorkCheckpointFact {
  summary: string;
  nextAction: string;
  blocker: string | null;
  sources: { materialId: string; version: number }[];
  createdAt: string;
}

const agentName = (connection: SQL) => sql`COALESCE((SELECT a.name FROM agent_connections c JOIN agents a ON a.id = c.agent_id
  WHERE c.id = ${connection}), 'An agent')`;
const userName = (user: SQL) => sql`COALESCE((SELECT u.name FROM auth_users u WHERE u.id = ${user}), 'Someone')`;

function card(row: Record<string, unknown>): CoWorkCardRow {
  return { id: String(row.id), kind: row.kind as CoWorkRequestKind, state: row.state as CoWorkRequestState, status: row.status as CoWorkRequestStatus,
    version: Number(row.version), reason: (row.reason as string | null) ?? null, nextBoundary: (row.next_boundary as string | null) ?? null,
    priority: Number(row.priority), peerUnblocking: row.peer_unblocking === true, target: row.target as CoWorkSourceRef,
    sourceRefs: row.source_refs as CoWorkSourceRef[], criteriaRefs: row.criteria_refs as CoWorkSourceRef[],
    responseRef: (row.response_ref as CoWorkSourceRef | null) ?? null, unitId: String(row.unit_id), taskId: String(row.work_id),
    senderConnectionId: String(row.sender_connection_id), senderName: String(row.sender_name), senderOwnerId: String(row.sender_owner_id),
    senderOwnerName: String(row.sender_owner_name), recipientConnectionId: String(row.recipient_connection_id),
    recipientName: String(row.recipient_name), recipientOwnerId: String(row.recipient_owner_id), recipientOwnerName: String(row.recipient_owner_name),
    cancelledById: (row.cancelled_by as string | null) ?? null, cancelledByName: (row.cancelled_by_name as string | null) ?? null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), expiresAt: String(row.expires_at) };
}

/** The effective state and honest status of a request, derived from stored facts and the clock (never a heartbeat). */
const effective = sql`CASE WHEN r.state IN ('queued', 'deferred', 'claimed') AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.state END`;
const status = sql`CASE WHEN r.state IN ('queued', 'deferred', 'claimed') AND r.expires_at <= clock_timestamp() THEN 'expired'
  WHEN r.state = 'claimed' AND EXISTS (SELECT 1 FROM cowork_units live WHERE live.id = r.unit_id AND live.state = 'claimed'
    AND live.generation = r.claimed_generation AND live.assignment_connection_id = r.recipient_connection_id
    AND live.lease_expires_at > clock_timestamp()) THEN 'working'
  WHEN r.state IN ('queued', 'deferred', 'claimed') AND NOT EXISTS (SELECT 1 FROM agent_connections c
    WHERE c.id = r.recipient_connection_id AND c.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_runtime_sessions s WHERE s.connection_id = c.id AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp())) THEN 'offline'
  WHEN r.state = 'claimed' THEN 'queued'
  ELSE r.state END`;
const columns = sql`r.id, r.kind, ${effective} AS state, ${status} AS status, r.version, r.reason, r.next_boundary, r.priority, r.peer_unblocking,
  r.target, r.source_refs, r.criteria_refs, r.response_ref, r.unit_id, r.work_id,
  r.sender_connection_id, ${agentName(sql`r.sender_connection_id`)} AS sender_name, r.sender_owner_id, ${userName(sql`r.sender_owner_id`)} AS sender_owner_name,
  r.recipient_connection_id, ${agentName(sql`r.recipient_connection_id`)} AS recipient_name, r.recipient_owner_id,
  ${userName(sql`r.recipient_owner_id`)} AS recipient_owner_name, r.cancelled_by,
  CASE WHEN r.cancelled_by IS NULL THEN NULL ELSE ${userName(sql`r.cancelled_by`)} END AS cancelled_by_name,
  r.created_at::text AS created_at, r.updated_at::text AS updated_at, r.expires_at::text AS expires_at`;

const ids = (values: string[]) => sql.join(values.map((id) => sql`${id}::uuid`), sql`, `);

export function coworkCardRows(tx: DbExecutor) {
  return {
    /** A task's requests, newest first, bounded; `requestId` narrows to one. */
    async requests(scope: { workspaceId: string; projectId: string; taskId: string }, options: { requestId?: string; limit?: number } = {}) {
      const result = await tx.execute<Record<string, unknown>>(sql`
        SELECT ${columns} FROM cowork_requests r
        WHERE r.workspace_id = ${scope.workspaceId}::uuid AND r.project_id = ${scope.projectId}::uuid AND r.work_id = ${scope.taskId}::uuid
          ${options.requestId ? sql`AND r.id = ${options.requestId}::uuid` : sql``}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${Math.min(options.limit ?? 50, 50)}`);
      return result.rows.map(card);
    },
    /**
     * What each reference is now, in the order given. A reference is available while it exists in this project at the
     * exact version the request named (the rule admission and the inbox use); only then is its title read. GitHub
     * references are never described: they carry no verified recipient adapter yet.
     */
    async describe(scope: { workspaceId: string; projectId: string }, refs: readonly CoWorkSourceRef[]): Promise<CoWorkReferenceFact[]> {
      const wanted = (types: string[]) => [...new Set(refs.filter((ref) => types.includes(ref.type) && 'id' in ref).map((ref) => (ref as { id: string }).id))];
      const facts = new Map<string, { title: string; version: number | null; kind?: string; message?: CoWorkReferenceFact['message'] }>();
      const work = wanted(['work']);
      if (work.length) for (const row of (await tx.execute<{ id: string; number: number; title: string; version: number }>(sql`
        SELECT id, number, title, version FROM project_work_items
        WHERE workspace_id = ${scope.workspaceId}::uuid AND project_id = ${scope.projectId}::uuid AND id IN (${ids(work)})`)).rows)
        facts.set(`work:${row.id}`, { title: `#${row.number} ${row.title}`, version: row.version });
      const materials = wanted(['material', 'doc']);
      if (materials.length) for (const row of (await tx.execute<{ id: string; kind: string; version: number; title: string }>(sql`
        SELECT m.id, m.kind, m.current_version AS version, v.title FROM project_materials m
        JOIN project_material_versions v ON v.workspace_id = m.workspace_id AND v.project_id = m.project_id
          AND v.material_id = m.id AND v.version = m.current_version
        WHERE m.workspace_id = ${scope.workspaceId}::uuid AND m.project_id = ${scope.projectId}::uuid AND m.id IN (${ids(materials)})`)).rows)
        facts.set(`material:${row.id}`, { title: row.title, version: row.version, kind: row.kind });
      const results = wanted(['result']);
      if (results.length) for (const row of (await tx.execute<{ id: string; title: string }>(sql`
        SELECT id, title FROM project_results
        WHERE workspace_id = ${scope.workspaceId}::uuid AND project_id = ${scope.projectId}::uuid AND id IN (${ids(results)})`)).rows)
        facts.set(`result:${row.id}`, { title: row.title, version: null });
      const messages = wanted(['message']);
      if (messages.length) for (const row of (await tx.execute<{ id: string; body: string; conversation_id: string; space: 'people' | 'agents'; work_id: string | null }>(sql`
        SELECT m.id, m.body, m.conversation_id, c.space, c.work_id FROM project_messages m
        JOIN project_conversations c ON c.workspace_id = m.workspace_id AND c.project_id = m.project_id AND c.id = m.conversation_id
        WHERE m.workspace_id = ${scope.workspaceId}::uuid AND m.project_id = ${scope.projectId}::uuid AND m.id IN (${ids(messages)})`)).rows)
        facts.set(`message:${row.id}`, { title: clip(row.body), version: null,
          message: { conversationId: row.conversation_id, space: row.space, taskId: row.work_id } });
      const thoughts = wanted(['thought']);
      if (thoughts.length) for (const row of (await tx.execute<{ id: string; text: string; version: number }>(sql`
        SELECT t.id, t.text, t.version FROM sketch_thoughts t JOIN sketches s ON s.workspace_id = t.workspace_id AND s.id = t.sketch_id
        WHERE t.workspace_id = ${scope.workspaceId}::uuid AND s.project_id = ${scope.projectId}::uuid AND s.scope = 'project'
          AND t.id IN (${ids(thoughts)})`)).rows)
        facts.set(`thought:${row.id}`, { title: clip(row.text), version: row.version });
      return refs.map((ref): CoWorkReferenceFact => {
        const unavailable: CoWorkReferenceFact = { ref, available: false, title: null, message: null };
        if (ref.type === 'github_pr') return unavailable;
        const found = facts.get(`${ref.type === 'doc' ? 'material' : ref.type}:${ref.id}`);
        if (!found) return unavailable;
        if ('version' in ref && found.version !== ref.version) return unavailable;
        if (ref.type === 'doc' && found.kind !== 'doc') return unavailable;
        return { ref, available: true, title: found.title, message: found.message ?? null };
      });
    },
    /** The unit's current checkpoint, if it has a typed one. Observable progress only; never an untyped row. */
    async checkpoint(scope: { workspaceId: string; projectId: string }, unitId: string): Promise<CoWorkCheckpointFact | null> {
      const result = await tx.execute<{ progress: Record<string, unknown>; created_at: string }>(sql`
        SELECT c.progress, c.created_at::text AS created_at FROM cowork_units u
        JOIN cowork_checkpoints c ON c.workspace_id = u.workspace_id AND c.project_id = u.project_id AND c.unit_id = u.id AND c.id = u.checkpoint_id
        WHERE u.id = ${unitId}::uuid AND u.workspace_id = ${scope.workspaceId}::uuid AND u.project_id = ${scope.projectId}::uuid`);
      const row = result.rows[0];
      const progress = row?.progress;
      if (!row || progress?.schema !== 'flux.cowork.checkpoint/1' || typeof progress.summary !== 'string' || typeof progress.nextAction !== 'string') return null;
      const sources = Array.isArray(progress.sources) ? (progress.sources as { materialId?: unknown; version?: unknown }[])
        .filter((source) => typeof source.materialId === 'string' && Number.isSafeInteger(source.version))
        .map((source) => ({ materialId: source.materialId as string, version: source.version as number })).slice(0, 50) : [];
      return { summary: progress.summary, nextAction: progress.nextAction, blocker: typeof progress.blocker === 'string' ? progress.blocker : null,
        sources, createdAt: row.created_at };
    },
    /**
     * The request row, locked until the transaction ends. A claim, deferral, response or supersession holds this same
     * row for its own conditional update, so a cancel and one of them serialize here: whichever commits first wins and
     * the other reads the committed version. Nothing else is locked, so no wait cycle with a recipient's slot is possible.
     */
    async lockRequest(scope: { workspaceId: string; projectId: string; taskId: string }, requestId: string) {
      const result = await tx.execute<{ id: string }>(sql`
        SELECT r.id FROM cowork_requests r WHERE r.id = ${requestId}::uuid AND r.workspace_id = ${scope.workspaceId}::uuid
          AND r.project_id = ${scope.projectId}::uuid AND r.work_id = ${scope.taskId}::uuid FOR UPDATE`);
      return result.rows.length === 1;
    },
    /** Open -> cancelled by this person, at the version they saw. Null if it moved on, closed or expired meanwhile. */
    async cancel(scope: { workspaceId: string; projectId: string; taskId: string }, requestId: string, expectedVersion: number, userId: string) {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE cowork_requests r SET state = 'cancelled', reason = 'cancelled_by_person', cancelled_by = ${userId},
          version = r.version + 1, updated_at = clock_timestamp()
        WHERE r.id = ${requestId}::uuid AND r.workspace_id = ${scope.workspaceId}::uuid AND r.project_id = ${scope.projectId}::uuid
          AND r.work_id = ${scope.taskId}::uuid AND r.version = ${expectedVersion} AND r.state IN ('queued', 'deferred', 'claimed')
          AND r.expires_at > clock_timestamp()
        RETURNING r.id`);
      return result.rows.length === 1;
    },
  };
}

/** A project's explicit review rule; no row means the contract default. */
export function coworkReviewPolicyRows(tx: DbExecutor) {
  return {
    async get(projectId: string) {
      const result = await tx.execute<{ review_separation: CoWorkReviewRule; updated_at: string; updated_by: string | null; updated_by_name: string | null }>(sql`
        SELECT p.review_separation, p.updated_at::text AS updated_at, p.updated_by, ${userName(sql`p.updated_by`)} AS updated_by_name
        FROM cowork_review_policies p WHERE p.project_id = ${projectId}::uuid`);
      const row = result.rows[0];
      return row ? { reviewSeparation: row.review_separation, updatedAt: row.updated_at,
        updatedBy: row.updated_by ? { id: row.updated_by, name: row.updated_by_name ?? 'Someone' } : null } : null;
    },
    async set(projectId: string, reviewSeparation: CoWorkReviewRule, userId: string) {
      await tx.execute(sql`
        INSERT INTO cowork_review_policies (project_id, review_separation, updated_by) VALUES (${projectId}::uuid, ${reviewSeparation}, ${userId})
        ON CONFLICT (project_id) DO UPDATE SET review_separation = EXCLUDED.review_separation, updated_by = EXCLUDED.updated_by,
          updated_at = clock_timestamp()`);
    },
    /** The rule a co-work command in this project applies now. */
    async current(projectId: string): Promise<CoWorkReviewRule> {
      const result = await tx.execute<{ review_separation: CoWorkReviewRule }>(sql`
        SELECT review_separation FROM cowork_review_policies WHERE project_id = ${projectId}::uuid`);
      return result.rows[0]?.review_separation ?? 'distinct_connection';
    },
  };
}
