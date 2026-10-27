import type { ProjectAccess, WorkspaceRole } from '@flux/contracts';
import type { Principal } from '../principal.js';
import { ForbiddenError, NotFoundError, WorkspaceAiBlockedError } from './errors.js';
import type {
  AccessReader, ActorReads, Actor, AgentFacts, AssistantRunFacts, DmFacts, DraftFacts, LoadOptions, ProjectFacts, SketchFacts, WorkspaceAi,
} from './ports.js';

export type { Actor, LoadOptions, WorkspaceAi } from './ports.js';

/**
 * # Flux access policy
 *
 * This module is the single authorization choke point. Every entry point that reads or
 * changes workspace data — the HTTP API, WebSocket subscriptions and replay, worker jobs,
 * and the future file, search, MCP and extension surfaces — MUST decide access through
 * {@link authorize} / {@link assertAuthorized} for one object and through
 * `visibleFilter` (`@flux/db`) for lists. Nothing may query collaborative tables for a caller
 * without one of them. See `docs/development/access-policy.md`.
 *
 * The decisions are pure: they run over facts an {@link AccessReader} returns (`./ports.ts`) and
 * never build a query. `@flux/db` (`repositories/access.ts`) is its one implementation; it reads
 * the facts with SQL, takes the locks in the order the evaluators below call it, and owns the list
 * conditions behind `visibleFilter` (#90).
 *
 * Rules, evaluated from current rows on every call (there is no cache, so removing a
 * membership, grant or agent applies to the very next call):
 *
 * - A principal acts inside one workspace. People act through their membership role
 *   (`owner`, `admin`, `member`, `guest`); an agent acts only through its own project
 *   grants and only while it is not revoked. A person-owned agent is also capped by its
 *   owner's current access and stops working when the owner leaves the workspace.
 * - Project access levels: none < viewer < contributor < manager.
 *   - An explicit `denied` grant gives none. **Explicit deny wins** over every role,
 *     grant, visibility and ownership rule for that project and its drafts.
 *   - Workspace owners and admins are managers of every project.
 *   - Otherwise an explicit `contributor` or `viewer` grant applies (a viewer grant also
 *     narrows a member's implicit access).
 *   - Otherwise a `member` is a contributor on `workspace`-visible projects. Guests and
 *     agents see only projects they were explicitly granted; nobody without a grant or
 *     manager role sees a `restricted` project.
 * - Drafts are private to their author by default. Workspace membership alone never
 *   reveals a private draft. A `project` draft is readable at project level viewer and
 *   writable at contributor. A `workspace` draft is readable by owners, admins and
 *   members (not guests or agents) and writable by its author, owners and admins.
 *   Sharing and moving need the author or, for a non-private draft, an owner/admin.
 * - Sketches (issue #69): a `project` sketch is readable at project level viewer and
 *   changeable at contributor. A `private` sketch is readable and changeable only by the
 *   person who created it while they are active in the workspace; owners and admins do not
 *   see it, and agents never do. `sketch.create` in a workspace is a private sketch by an
 *   active person; a project sketch needs `project.write` on its project. A `dm` sketch (#96)
 *   belongs to one DM: exactly its current participants read it, and they change it while the
 *   DM is open (a 1:1 whose other person left is read-only until that person reopens it).
 *   Owners, admins and agents outside the DM never see it.
 * - Direct messages (issue #107): a DM's audience is exactly its current participants. Only a
 *   participant who is active in the workspace reads or writes it; workspace owners and admins
 *   who are not participants never see it, and agents never do in this slice. `dm.create` is
 *   for owners, admins and members (guests can take part when added, but not start a DM).
 * - An agent never works outside its current project grants, not even on drafts it
 *   authored: it creates drafts only inside a project where it is a contributor, and
 *   every read (viewer) or write, share and move (contributor) of any draft — its own
 *   private drafts included — needs its current level on the draft's project.
 * - With `lock: true` (inside a mutation transaction) the decision locks the rows it
 *   depends on — membership/agent `FOR SHARE`, the draft `FOR UPDATE`, the project and
 *   the principal's grants on it `FOR SHARE` — so a concurrent membership, grant or
 *   agent change either commits first and is seen, or waits until the mutation commits.
 * - Callers that cannot see an object get {@link NotFoundError} (404) so its existence
 *   does not leak; visible objects with a forbidden action get {@link ForbiddenError} (403).
 */

export const WORKSPACE_ACTIONS = ['workspace.read', 'workspace.read_members', 'workspace.manage_members', 'workspace.manage_agents', 'workspace.manage_ai', 'workspace.manage_encryption', 'project.create', 'draft.create', 'agent.create', 'sketch.create', 'dm.create'] as const;
export const PROJECT_ACTIONS = ['project.read', 'project.write', 'project.manage'] as const;
export const DRAFT_ACTIONS = ['draft.read', 'draft.write', 'draft.share', 'draft.move'] as const;
export const AGENT_ACTIONS = ['agent.read', 'agent.revoke', 'agent.invoke'] as const;
export const SKETCH_ACTIONS = ['sketch.read', 'sketch.write'] as const;
export const DM_ACTIONS = ['dm.read', 'dm.write'] as const;
export const ASSISTANT_RUN_ACTIONS = ['assistant_run.read'] as const;

/** Actions grouped by the kind of object they are checked against. */
export interface ActionsByResource {
  workspace: (typeof WORKSPACE_ACTIONS)[number];
  project: (typeof PROJECT_ACTIONS)[number];
  draft: (typeof DRAFT_ACTIONS)[number];
  agent: (typeof AGENT_ACTIONS)[number];
  sketch: (typeof SKETCH_ACTIONS)[number];
  dm: (typeof DM_ACTIONS)[number];
  assistant_run: (typeof ASSISTANT_RUN_ACTIONS)[number];
}
export type ResourceType = keyof ActionsByResource;
export type Action = ActionsByResource[ResourceType];
export interface ResourceRef<T extends ResourceType = ResourceType> {
  type: T;
  id: string;
}

export interface Decision {
  /** The principal may perform the action. */
  allowed: boolean;
  /** The principal may know that the object exists; false maps to 404, not 403. */
  visible: boolean;
}

/**
 * The single AI check of every entry point (F-029): throws {@link WorkspaceAiBlockedError} unless AI is
 * allowed in the workspace and, when `epoch` is given (a queued item's admission epoch), still at it.
 * Returns the policy, whose `epoch` a new AI work item records. The policy row is read fresh; with `lock`
 * it is held `FOR SHARE`, ordered before the agent, membership, project and grant rows.
 */
export async function requireWorkspaceAi(reader: Pick<ActorReads, 'workspaceAi'>, workspaceId: string, options: { lock?: boolean; epoch?: number } = {}): Promise<WorkspaceAi> {
  const ai = await reader.workspaceAi(workspaceId, options);
  if (ai.state !== 'allowed' || (options.epoch !== undefined && options.epoch !== ai.epoch)) throw new WorkspaceAiBlockedError();
  return ai;
}

export const LEVEL = { none: 0, viewer: 1, contributor: 2, manager: 3 } as const;
const MANAGER_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isManager(role: WorkspaceRole | null) {
  return role !== null && MANAGER_ROLES.includes(role);
}

export function accessName(level: number): ProjectAccess | null {
  if (level >= LEVEL.manager) return 'manager';
  if (level >= LEVEL.contributor) return 'contributor';
  if (level >= LEVEL.viewer) return 'viewer';
  return null;
}

/**
 * Promotion of a DM sketch (#96) must commit exactly the audience it previewed. Before the
 * sketch is evaluated, this takes the rows every audience change locks first, FOR SHARE: the
 * workspace row (member added, removed or re-roled: `lockWorkspace`, FOR NO KEY UPDATE) and, for
 * an existing target, the project row (grants and visibility: `lockProjectForGrantChange`). The
 * global order stays workspace, project, membership, sketch, DM, participants.
 */
export async function lockPromotionScope(reader: Pick<AccessReader, 'sketchWorkspace' | 'lockWorkspaceForShare' | 'lockProjectForShare'>, sketchId: string, projectId: string | null): Promise<void> {
  if (!isUuid(sketchId)) return;
  const workspaceId = await reader.sketchWorkspace(sketchId);
  if (workspaceId === null) return;
  await reader.lockWorkspaceForShare(workspaceId);
  if (projectId && isUuid(projectId)) await reader.lockProjectForShare(projectId);
}

/**
 * Locks every participant row of a DM FOR SHARE, in user id order, after the DM row, and returns
 * the participants. A leave (DM row, then its own row) or a membership removal (which deletes
 * participant rows by cascade) then waits until the caller's change commits.
 */
export async function lockDmParticipants(reader: Pick<AccessReader, 'lockDmForShare' | 'lockParticipantsForShare'>, dmId: string): Promise<string[]> {
  await reader.lockDmForShare(dmId);
  return reader.lockParticipantsForShare(dmId);
}

/** Why a DM cannot take changes now: the other person of a 1:1 left it or the workspace (#107, #96). */
export interface DmClosed {
  reason: 'left' | 'unavailable';
  recipient: { id: string; name: string };
}

/**
 * Null while the DM takes changes. A 1:1 whose other person is no longer a participant is closed
 * for everyone else: nothing is sent, sketched or promoted on that person's behalf, and only they
 * can reopen it (the #107 DM_RECIPIENT_LEFT rule). Groups stay open to whoever remains.
 */
export async function dmClosedFor(reader: Pick<AccessReader, 'dmPair' | 'isParticipant' | 'userName' | 'loadActor'>, dmId: string, selfId: string): Promise<DmClosed | null> {
  const dm = await reader.dmPair(dmId);
  if (!dm || dm.kind !== 'pair' || !dm.pairKey) return null;
  const otherId = dm.pairKey.split(':').find((id) => id !== selfId);
  if (!otherId) return null;
  if (await reader.isParticipant(dmId, otherId)) return null;
  const name = await reader.userName(otherId);
  const active = (await reader.loadActor({ kind: 'human', id: otherId }, dm.workspaceId)).active;
  return { reason: active ? 'left' : 'unavailable', recipient: { id: otherId, name: name ?? '' } };
}

// ---------------------------------------------------------------------------------------
// Single-object evaluation. Internal evaluators also return the loaded row so domain
// methods decide and act on the same data inside one transaction. The row type is the one
// the reader returns (generic), so an adapter's whole table rows reach the caller.

export interface WorkspaceEvaluation extends Decision { actor: Actor }
export interface ProjectEvaluation<P extends ProjectFacts = ProjectFacts> extends Decision { actor: Actor | null; project: P | null; level: number }
export interface DraftEvaluation<D extends DraftFacts = DraftFacts> extends Decision { actor: Actor | null; draft: D | null; level: number; isOwner: boolean }
export interface AgentEvaluation<A extends AgentFacts = AgentFacts> extends Decision { actor: Actor | null; agent: A | null }
export interface SketchEvaluation<S extends SketchFacts = SketchFacts> extends Decision { actor: Actor | null; sketch: S | null }
export interface DmEvaluation<M extends DmFacts = DmFacts> extends Decision { actor: Actor | null; dm: M | null }
export interface AssistantRunEvaluation extends Decision { actor: Actor | null; run: AssistantRunFacts | null }

const DENIED: Decision = { allowed: false, visible: false };

export async function evaluateWorkspace(principal: Principal, action: ActionsByResource['workspace'], workspaceId: string, reader: AccessReader, options?: LoadOptions): Promise<WorkspaceEvaluation> {
  const actor = await reader.loadActor(principal, workspaceId, options);
  if (!actor.active) return { ...DENIED, actor };
  const human = principal.kind === 'human';
  let allowed: boolean;
  switch (action) {
    case 'workspace.read':
      allowed = true;
      break;
    case 'draft.create':
      // People may keep unscoped private drafts; an agent needs a project it can write in
      // (createDraft additionally requires that project to be the draft's project).
      allowed = human || await reader.hasWritableProject(actor);
      break;
    case 'sketch.create':
      allowed = human;
      break;
    case 'dm.create':
      allowed = human && actor.role !== 'guest';
      break;
    case 'workspace.read_members':
    case 'agent.create':
      allowed = human && actor.role !== 'guest';
      break;
    case 'workspace.manage_members':
    case 'workspace.manage_agents':
    case 'workspace.manage_ai':
    case 'workspace.manage_encryption':
    case 'project.create':
      allowed = human && isManager(actor.role);
      break;
  }
  return { allowed, visible: true, actor };
}

export async function evaluateProject<P extends ProjectFacts = ProjectFacts>(principal: Principal, action: ActionsByResource['project'], projectId: string, reader: AccessReader<P>, options?: LoadOptions): Promise<ProjectEvaluation<P>> {
  const none = { ...DENIED, actor: null, project: null, level: 0 };
  if (!isUuid(projectId)) return none;
  const located = await reader.locateProject(projectId);
  if (!located) return none;
  const actor = await reader.loadActor(principal, located.workspaceId, options);
  if (!actor.active) return { ...none, actor };
  if (options?.lock) await reader.lockProjectAccess(actor, projectId);
  const row = await reader.readProject(actor, projectId);
  if (!row || row.level < LEVEL.viewer) return { ...none, actor };
  const needed = action === 'project.manage' ? LEVEL.manager : action === 'project.write' ? LEVEL.contributor : LEVEL.viewer;
  return { allowed: row.level >= needed, visible: true, actor, project: row.project, level: row.level };
}

export async function evaluateDraft<D extends DraftFacts = DraftFacts>(principal: Principal, action: ActionsByResource['draft'], draftId: string, reader: AccessReader<ProjectFacts, D>, options: LoadOptions = {}): Promise<DraftEvaluation<D>> {
  const none = { ...DENIED, actor: null, draft: null, level: 0, isOwner: false };
  if (!isUuid(draftId)) return none;
  const located = await reader.locateDraft(draftId);
  if (!located) return none;
  const actor = await reader.loadActor(principal, located.workspaceId, options);
  if (!actor.active) return { ...none, actor };
  if (options.lock) {
    // Lock the draft first so its project cannot change, then that project's access rows.
    const locked = await reader.lockDraftForUpdate(draftId);
    if (locked?.projectId) await reader.lockProjectAccess(actor, locked.projectId);
  }
  const row = await reader.readDraft(actor, draftId, { lock: !!options.lock });
  if (!row || !row.readable) return { ...none, actor };
  const { draft, level, isOwner } = row;
  const manager = isManager(actor.role);
  let allowed: boolean;
  if (principal.kind === 'agent') {
    // Readable already implies current viewer access; changes need current contributor access.
    const writable = level >= LEVEL.contributor;
    allowed = action === 'draft.read' || (writable && (action === 'draft.write' ? isOwner || draft.visibility === 'project' : isOwner));
    return { allowed, visible: true, actor, draft, level, isOwner };
  }
  switch (action) {
    case 'draft.read':
      allowed = true;
      break;
    case 'draft.write':
      allowed = isOwner || (draft.visibility === 'project' && level >= LEVEL.contributor) || (draft.visibility === 'workspace' && manager);
      break;
    case 'draft.share':
    case 'draft.move':
      allowed = isOwner || (draft.visibility !== 'private' && manager);
      break;
  }
  return { allowed, visible: true, actor, draft, level, isOwner };
}

export async function evaluateAgent<A extends AgentFacts = AgentFacts>(principal: Principal, action: ActionsByResource['agent'], agentId: string, reader: AccessReader<ProjectFacts, DraftFacts, A>, options?: LoadOptions): Promise<AgentEvaluation<A>> {
  const none = { ...DENIED, actor: null, agent: null };
  if (!isUuid(agentId)) return none;
  const agent = await reader.readAgent(agentId);
  if (!agent) return none;
  const actor = await reader.loadActor(principal, agent.workspaceId, options);
  const self = principal.kind === 'agent' && principal.id === agent.id;
  const ownedByCaller = principal.kind === 'human' && agent.ownerUserId === principal.id;
  const visible = actor.active && (self || (principal.kind === 'human' && actor.role !== 'guest'));
  if (!visible) return { ...none, actor };
  // `agent.invoke` (#68, O-008): only the owning person, while the agent is not revoked. A
  // workspace role never lets anyone else use a person's assistant or its payer.
  // F-029: nobody invokes an agent of a workspace whose AI is off.
  if (action === 'agent.invoke' && ownedByCaller && (await reader.workspaceAi(agent.workspaceId, options)).state !== 'allowed') return { allowed: false, visible, actor, agent };
  const allowed = action === 'agent.invoke' ? ownedByCaller && !agent.revokedAt
    : action === 'agent.read' || ownedByCaller || isManager(actor.role);
  return { allowed, visible, actor, agent };
}

/**
 * With `lock`, the sketch row is taken `FOR NO KEY UPDATE` (changes to one sketch run one at a
 * time, so version checks and link rules see each other), then the project access rows
 * `FOR SHARE`, so a concurrent revocation is seen or waits.
 */
export async function evaluateSketch<S extends SketchFacts = SketchFacts>(principal: Principal, action: ActionsByResource['sketch'], sketchId: string, reader: AccessReader<ProjectFacts, DraftFacts, AgentFacts, S>, options: LoadOptions = {}): Promise<SketchEvaluation<S>> {
  const none = { ...DENIED, actor: null, sketch: null };
  if (!isUuid(sketchId)) return none;
  const located = await reader.locateSketch(sketchId);
  if (!located) return none;
  const actor = await reader.loadActor(principal, located.workspaceId, options);
  if (!actor.active) return { ...none, actor };
  if (options.lock) {
    await reader.lockSketchForNoKeyUpdate(sketchId);
    // A private sketch depends only on its owner's membership, which loadActor locked.
    if (located.projectId) await reader.lockProjectAccess(actor, located.projectId);
    // A DM sketch depends on the caller's participant row: a concurrent leave (which deletes it)
    // or membership removal (which cascades to it) is either seen or waits for this change (#96).
    // The DM row comes first (FOR SHARE), as leave() takes it first (FOR NO KEY UPDATE), so a
    // leave either commits before this change or waits for it, and the two never deadlock.
    if (located.dmId && principal.kind === 'human') {
      await reader.lockDmForShare(located.dmId);
      await reader.lockParticipantForShare(located.dmId, principal.id);
    }
  }
  const row = await reader.readSketch(actor, sketchId);
  if (!row || !row.readable) return { ...none, actor };
  let allowed: boolean;
  if (action === 'sketch.read' || row.sketch.scope === 'private') allowed = true;
  else if (row.sketch.scope === 'dm') allowed = !(await dmClosedFor(reader, row.sketch.dmId!, principal.id));
  else allowed = row.level >= LEVEL.contributor;
  return { allowed, visible: true, actor, sketch: row.sketch };
}

/**
 * A DM is visible and changeable only for its current participants. With `lock`, the DM row is
 * taken `FOR NO KEY UPDATE` (sends, renames and leaves of one DM run one at a time) and the
 * caller's participant row `FOR SHARE`, after `loadActor` locked the membership: leaving or a
 * membership removal (which cascades to the participant row) either commits first and is seen,
 * or waits until this change commits.
 */
export async function evaluateDm<M extends DmFacts = DmFacts>(principal: Principal, _action: ActionsByResource['dm'], dmId: string, reader: AccessReader<ProjectFacts, DraftFacts, AgentFacts, SketchFacts, M>, options: LoadOptions = {}): Promise<DmEvaluation<M>> {
  const none = { ...DENIED, actor: null, dm: null };
  if (!isUuid(dmId)) return none;
  const located = await reader.locateDm(dmId);
  if (!located) return none;
  const actor = await reader.loadActor(principal, located.workspaceId, options);
  if (!actor.active || principal.kind !== 'human') return { ...none, actor };
  if (options.lock) {
    await reader.lockDmForNoKeyUpdate(dmId);
    await reader.lockParticipantForShare(dmId, principal.id);
  }
  const row = await reader.readDm(actor, dmId);
  if (!row || !row.readable) return { ...none, actor };
  // Reading and writing need the same thing: being a participant now.
  return { allowed: true, visible: true, actor, dm: row.dm };
}

/**
 * A personal assistant run (#68, O-008 §4): only its owner, while active in the run's
 * workspace, may know it exists. Workspace roles, project access and agents never see it; the
 * run's progress events therefore reach the owner alone. A committed answer is a separate
 * project object (`project.assistant_answer_committed.v1`) for the conversation's audience.
 */
export async function evaluateAssistantRun(principal: Principal, _action: ActionsByResource['assistant_run'], runId: string, reader: AccessReader, options: LoadOptions = {}): Promise<AssistantRunEvaluation> {
  const none = { ...DENIED, actor: null, run: null };
  if (!isUuid(runId) || principal.kind !== 'human') return none;
  const run = await reader.readAssistantRun(runId);
  if (!run || run.ownerUserId !== principal.id) return none;
  const actor = await reader.loadActor(principal, run.workspaceId, options);
  if (!actor.active) return { ...none, actor };
  return { allowed: true, visible: true, actor, run };
}

/**
 * Decides whether `principal` may perform `action` on `resource`, reading current
 * membership, grants and object visibility. Use {@link assertAuthorized} to throw the
 * matching 404/403 error instead.
 */
export async function authorize<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, reader: AccessReader, options?: LoadOptions): Promise<Decision> {
  const { allowed, visible } = await evaluate(principal, action, resource, reader, options);
  return { allowed, visible };
}

/**
 * Throws NotFoundError when the object is invisible to the principal, ForbiddenError when
 * the action is not allowed. Inside a commit transaction pass `{ lock: true }`: the
 * principal's membership/agent rows are locked FOR SHARE and a draft FOR UPDATE, so a
 * revocation committed earlier is seen and a concurrent one waits for this transaction.
 */
export async function assertAuthorized<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, reader: AccessReader, options?: LoadOptions): Promise<void> {
  enforce(await evaluate(principal, action, resource, reader, options), resource.type);
}

async function evaluate(principal: Principal, action: Action, resource: ResourceRef, reader: AccessReader, options?: LoadOptions) {
  switch (resource.type) {
    case 'workspace': return evaluateWorkspace(principal, action as ActionsByResource['workspace'], resource.id, reader, options);
    case 'project': return evaluateProject(principal, action as ActionsByResource['project'], resource.id, reader, options);
    case 'draft': return evaluateDraft(principal, action as ActionsByResource['draft'], resource.id, reader, options);
    case 'agent': return evaluateAgent(principal, action as ActionsByResource['agent'], resource.id, reader, options);
    case 'sketch': return evaluateSketch(principal, action as ActionsByResource['sketch'], resource.id, reader, options);
    case 'dm': return evaluateDm(principal, action as ActionsByResource['dm'], resource.id, reader, options);
    case 'assistant_run': return evaluateAssistantRun(principal, action as ActionsByResource['assistant_run'], resource.id, reader, options);
  }
}

const READ_ACTION = { workspace: 'workspace.read', project: 'project.read', draft: 'draft.read', agent: 'agent.read', sketch: 'sketch.read', dm: 'dm.read', assistant_run: 'assistant_run.read' } as const satisfies { [T in ResourceType]: ActionsByResource[T] };

/**
 * The workspace of an object the principal can currently see, or null. Entry points use
 * it to scope records such as idempotency keys without revealing invisible objects.
 */
export async function visibleWorkspaceOf(principal: Principal, resource: ResourceRef, reader: AccessReader): Promise<string | null> {
  const evaluation = await evaluate(principal, READ_ACTION[resource.type], resource, reader);
  if (!evaluation.visible) return null;
  if ('project' in evaluation) return evaluation.project?.workspaceId ?? null;
  if ('draft' in evaluation) return evaluation.draft?.workspaceId ?? null;
  if ('agent' in evaluation) return evaluation.agent?.workspaceId ?? null;
  if ('sketch' in evaluation) return evaluation.sketch?.workspaceId ?? null;
  if ('dm' in evaluation) return evaluation.dm?.workspaceId ?? null;
  if ('run' in evaluation) return evaluation.run?.workspaceId ?? null;
  return evaluation.actor.workspaceId;
}

// ---------------------------------------------------------------------------------------
// Events. The stream and replay deliver an event to a recipient only when this returns
// true at delivery time; payloads carry identifiers and kind, never content.

export interface EventRef {
  kind: string;
  workspaceId: string | null;
  objectId: string;
}

/** The object an event is about, derived from its versioned kind (`<type>.<verb>.v<n>`). */
export function eventResource(event: EventRef): ResourceRef | null {
  if (!event.workspaceId) return null;
  const type = event.kind.split('.', 1)[0];
  if (type === 'workspace') return event.objectId === event.workspaceId ? { type, id: event.objectId } : null;
  if (type === 'project' || type === 'draft' || type === 'agent' || type === 'sketch' || type === 'dm' || type === 'assistant_run') return { type, id: event.objectId };
  return null;
}

/**
 * Whether `principal` may receive `event` now: the principal must be active in the
 * event's workspace and currently able to read the object the event is about. Unknown
 * kinds and events without a workspace are never delivered.
 */
export async function authorizeEvent(principal: Principal, event: EventRef, reader: AccessReader): Promise<boolean> {
  // F-029: the AI policy change is for the workspace's people; no agent ever receives it.
  if (event.kind === 'workspace.ai_policy_changed.v1' && principal.kind !== 'human') return false;
  const resource = eventResource(event);
  if (!resource) return false;
  const decision = await evaluate(principal, READ_ACTION[resource.type], resource, reader);
  if (!decision.allowed || !decision.visible) return false;
  // The object must still belong to the event's workspace (defense in depth).
  if ('actor' in decision && decision.actor && decision.actor.workspaceId !== event.workspaceId) return false;
  return true;
}

const LABELS: Record<ResourceType, string> = { workspace: 'Workspace', project: 'Project', draft: 'Draft', agent: 'Agent', sketch: 'Sketch', dm: 'Direct message', assistant_run: 'Assistant run' };

/** Converts a decision into the non-leaking error contract. */
export function enforce<D extends Decision>(decision: D, type: ResourceType): D {
  if (!decision.visible) throw new NotFoundError(LABELS[type], `${type.toUpperCase()}_NOT_FOUND`);
  if (!decision.allowed) throw new ForbiddenError(`Not allowed to perform this action on the ${type}`);
  return decision;
}
