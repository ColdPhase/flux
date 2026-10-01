import type { PageQuery, PersonRef, PromotionPerson, SketchCopy, SketchScope, ThoughtShape } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of the sketch use cases (issues #69, #46). Core states what it needs; the server
 * implements them with the access policy (`policySketchAccess`), Drizzle repositories and
 * `recordEvent`, and passes them in. Nothing in `packages/core/src/sketches` imports those.
 */

export type SketchAction = 'sketch.read' | 'sketch.write';

export interface SketchRecord {
  id: string;
  workspaceId: string;
  scope: SketchScope;
  projectId: string | null;
  dmId: string | null;
  title: string;
  createdBy: PersonRef;
  /** A project copy of a DM sketch: who copied it and when. */
  copied: { by: PersonRef; at: Date } | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The message a thought was started from; `dmId`/`messageId` only inside the DM itself. */
export interface ThoughtSourceRecord {
  authorId: string;
  authorName: string;
  sentAt: Date;
  dmId: string | null;
  messageId: string | null;
}

export interface ThoughtRecord {
  id: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ThoughtShape;
  placement: { type: 'draft'; id: string } | null;
  source: ThoughtSourceRecord | null;
  createdBy: PersonRef;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A message of a DM, as a sketch may quote it. */
export interface DmMessageView {
  id: string;
  dmId: string;
  sequence: number;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface LinkRecord {
  id: string;
  sketchId: string;
  fromId: string;
  toId: string;
  label: string | null;
  createdAt: Date;
}

/** Where a new sketch goes; the access port decides whether the caller may put it there. */
export type SketchTarget =
  | { scope: 'project'; workspaceId: string; projectId: string }
  | { scope: 'private'; workspaceId: string }
  | { scope: 'dm'; workspaceId: string; dmId: string };

/** The access policy's answer about an object placed on a map, for one reader, from current rows. */
export interface PlacementView {
  /** The reader may read the object now. */
  readable: boolean;
  /** The object's workspace when readable, else null. */
  workspaceId: string | null;
  title: string | null;
}

/** Adapter over the core access policy (`evaluateSketch`, `evaluateProject`, `evaluateDraft`). */
export interface SketchAccess {
  /**
   * Throws NotFoundError when the sketch is invisible to the principal and ForbiddenError when
   * the action is not allowed. `lock` (inside a change) locks the sketch and the rows the
   * decision depends on until the unit of work commits. Returns what the principal may do.
   */
  requireSketch(principal: Principal, action: SketchAction, sketchId: string, options?: { lock?: boolean }): Promise<'read' | 'write'>;
  /** What the principal may do with a sketch now, or null when it is invisible. */
  accessOf(principal: Principal, sketchId: string): Promise<'read' | 'write' | null>;
  /** Throws NotFoundError unless the principal is active in the workspace. */
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  /**
   * Throws the policy's 404/403, or RuleViolationError for a project or DM of another workspace.
   * A DM target also needs the DM to be open: a 1:1 whose other person left answers 409
   * DM_RECIPIENT_LEFT / DM_RECIPIENT_UNAVAILABLE (only that person can reopen it).
   */
  requireCreate(principal: Principal, target: SketchTarget): Promise<void>;
  /**
   * Promotion (#96), first: locks the rows every change to the copy's audience locks first (the
   * workspace, and an existing target project), FOR SHARE, before the sketch is evaluated.
   */
  lockPromotion(sketchId: string, projectId: string | null): Promise<void>;
  /** Locks the DM's participant rows FOR SHARE until the unit of work commits; returns their user ids. */
  lockParticipants(dmId: string): Promise<string[]>;
  /** The same 409 as {@link requireCreate} for an existing DM sketch's DM; returns when it is open. */
  requireDmOpen(principal: Principal, dmId: string): Promise<void>;
  /** Access to the underlying object of a placement. Never throws for invisible objects. */
  placement(principal: Principal, ref: { type: 'draft'; id: string }): Promise<PlacementView>;
}

export interface NewSketch {
  id: string;
  workspaceId: string;
  scope: SketchScope;
  projectId: string | null;
  dmId: string | null;
  title: string;
  createdBy: Principal;
  /** A project copy of a DM sketch: the source sketch and the person copying it. */
  copy?: { fromSketchId: string; byUserId: string };
}

export interface NewThought {
  id: string;
  workspaceId: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ThoughtShape;
  placement: { type: 'draft'; id: string } | null;
  source?: ThoughtSourceRecord | null;
  createdBy: Principal;
  /** A project copy keeps the original thought's times. */
  createdAt?: Date;
  updatedAt?: Date;
}

export interface NewLink {
  id: string;
  workspaceId: string;
  sketchId: string;
  fromId: string;
  toId: string;
  label: string | null;
  createdBy: Principal;
}

export type ThoughtChanges = Partial<Pick<ThoughtRecord, 'text' | 'x' | 'y' | 'width' | 'height' | 'shape'>>;

/** Rows only; the repository makes no access decisions (the use cases ask {@link SketchAccess}). */
export interface SketchRepository {
  /** The sketches of `workspaceId` that pass the policy's list filter for `principal`, newest change first. */
  listVisible(principal: Principal, workspaceId: string, filter: { projectId?: string; dmId?: string }, page: Required<PageQuery>): Promise<{ items: SketchRecord[]; total: number }>;
  /** One sketch by id; call only after the access port allowed it. */
  findSketch(id: string): Promise<SketchRecord | null>;
  insertSketch(sketch: NewSketch): Promise<SketchRecord>;
  /** Sets the title and increments the version; the caller has checked the version. */
  renameSketch(id: string, title: string): Promise<SketchRecord>;
  /** Bumps `updated_at` so lists sort by the latest change. */
  touchSketch(id: string): Promise<void>;
  thoughts(sketchId: string): Promise<ThoughtRecord[]>;
  /** These messages of the DM that exist, in conversation order. */
  dmMessages(dmId: string, ids: string[]): Promise<DmMessageView[]>;
  /** How many messages the DM has. */
  dmMessageCount(dmId: string): Promise<number>;
  /** The DM's current participants. */
  dmParticipants(dmId: string): Promise<{ id: string; name: string }[]>;
  /** Project copies made from this sketch, with their project's name; filter by access before showing. */
  copiesOf(sketchId: string): Promise<SketchCopy[]>;
  /** Rows of `sketchId` with these ids, locked for update (in id order). */
  lockThoughts(sketchId: string, ids: string[]): Promise<ThoughtRecord[]>;
  thoughtExists(id: string): Promise<boolean>;
  insertThought(thought: NewThought): Promise<ThoughtRecord>;
  /** Applies the changes and increments the version; the caller has checked the version. */
  updateThought(sketchId: string, id: string, changes: ThoughtChanges): Promise<ThoughtRecord>;
  /** Deletes the thought and its links; never the placed object. */
  deleteThought(sketchId: string, id: string): Promise<void>;
  links(sketchId: string): Promise<LinkRecord[]>;
  linkExists(id: string): Promise<boolean>;
  /** The link between two thoughts of the sketch, in either direction. */
  linkBetween(sketchId: string, a: string, b: string): Promise<LinkRecord | null>;
  insertLink(link: NewLink): Promise<LinkRecord>;
  /** Returns false when the sketch has no such link. */
  deleteLink(sketchId: string, id: string): Promise<boolean>;
}

/** Records a versioned event for the stream in the unit of work (identifiers only, never content). */
export interface SketchEventLog {
  record(principal: Principal, workspaceId: string, kind: 'sketch.created.v1' | 'sketch.changed.v1', sketchId: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * Where a DM sketch can be copied and who would see the copy (#96). The server implements it with
 * the core project use cases and the access policy, so the audience is the policy's own answer.
 */
export interface SketchPromotion {
  /** Whether the caller may create a project here, and the projects they can change. */
  targets(principal: Principal, workspaceId: string): Promise<{ canCreateProject: boolean; projects: { id: string; name: string }[] }>;
  /**
   * Everyone who could read the copy. A new project is restricted and granted to exactly the DM's
   * participants, so its readers are they and the workspace's owners and admins (who manage every
   * project). An existing project's readers are its current people. Throws the policy's 404/403
   * for a project the caller cannot change and RuleViolationError for another workspace's.
   */
  audience(principal: Principal, workspaceId: string, participants: { id: string; name: string }[], target: { kind: 'new' } | { kind: 'existing'; projectId: string }): Promise<{ people: PromotionPerson[]; projectName: string | null }>;
  /** Creates the restricted project and grants each participant who is not a manager contributor access. */
  createProject(principal: Principal, workspaceId: string, name: string, participantIds: string[]): Promise<{ id: string; name: string }>;
}

export interface SketchPorts {
  access: SketchAccess;
  sketches: SketchRepository;
  events: SketchEventLog;
  promotion: SketchPromotion;
}

/**
 * Runs `work` in one transaction: the decision, the change and its event commit together or not
 * at all. Called on an open transaction (such as an idempotency scope) it nests in it.
 */
export interface SketchUnitOfWork {
  run<T>(work: (ports: SketchPorts) => Promise<T>): Promise<T>;
}
