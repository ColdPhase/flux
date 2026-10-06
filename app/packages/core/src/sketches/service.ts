import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_THOUGHT_SIZE,
  SKETCH_LIMITS,
  type CreateLinkCommand,
  type CreateSketchCommand,
  type CreatedThought,
  type CreateThoughtCommand,
  type MovedThoughts,
  type MoveThoughtsCommand,
  type Placement,
  type PromotedSketch,
  type PromoteSketchCommand,
  type Sketch,
  type SketchCopy,
  type SketchPromotionPreview,
  type SketchDetail,
  type SketchListQuery,
  type SketchPage,
  type Thought,
  type ThoughtFile,
  type ThoughtLink,
  type UpdateSketchCommand,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { LinkRecord, SketchPorts, SketchRecord, SketchTarget, SketchUnitOfWork, ThoughtChanges, ThoughtRecord, ThoughtSourceRecord } from './ports.js';
import * as valid from './validation.js';

// Sketch use cases (issue #69). Each one runs in a unit of work: it asks the access port first
// (reads: `sketch.read`; changes: `sketch.write` with the sketch locked), then validates the
// caller's version, changes rows through the repository and records one event, so the
// decision, the change and the stream event commit together. Removing a thought removes only
// its placement on the map, never the object placed there.

/** 409 for a batch of moves: nothing moved; each stale thought comes back as the caller may read it now. */
export class PositionsConflictError extends ConflictError {
  constructor(conflicts: { id: string; currentVersion: number; current: Thought }[]) {
    super('Some thoughts changed since the expected versions', 'VERSION_CONFLICT');
    this.details = { conflicts };
  }
}

/** 409 for a promotion whose preview is out of date: nothing was copied; `details.preview` is the current one. */
export class PromotionChangedError extends ConflictError {
  constructor(preview: SketchPromotionPreview) {
    super('Who could see the copy, or what goes in, changed since the preview. Check it again.', 'PROMOTION_CHANGED');
    this.details = { preview };
  }
}

const iso = (date: Date) => date.toISOString();

export function presentSketch(record: SketchRecord, access: 'read' | 'write'): Sketch {
  return {
    id: record.id, workspaceId: record.workspaceId, scope: record.scope, projectId: record.projectId, dmId: record.dmId, title: record.title,
    createdBy: record.createdBy, origin: record.copied ? { kind: 'dm_copy', copiedBy: record.copied.by, copiedAt: iso(record.copied.at) } : null,
    access, version: record.version, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

/** A message body as a thought's text: the thought keeps up to the text limit, marked when clipped. */
function thoughtText(body: string) {
  const text = body.trim();
  return text.length > SKETCH_LIMITS.text ? `${text.slice(0, SKETCH_LIMITS.text - 1)}…` : text;
}

/** Staggered columns in conversation order, so the first thoughts read top to bottom. */
function messageSpot(index: number) {
  const column = index % 3;
  return { x: 40 + column * 232, y: 40 + Math.floor(index / 3) * 136 + (column === 1 ? 44 : 0) };
}

export function presentThoughtLink(record: LinkRecord): ThoughtLink {
  return { id: record.id, sketchId: record.sketchId, fromId: record.fromId, toId: record.toId, label: record.label, createdAt: iso(record.createdAt) };
}

/**
 * Thoughts as `principal` may see them: a placement's title only when its object is readable now. A project sketch's
 * thoughts carry their image (#252); its readers are the project's readers, who may read its published files.
 * Exported for the live map deltas (#228), which present the same views.
 */
export async function presentThoughts(ports: Pick<SketchPorts, 'access' | 'files'>, principal: Principal, sketch: Pick<SketchRecord, 'workspaceId' | 'scope' | 'projectId'>, records: ThoughtRecord[]): Promise<Thought[]> {
  const { workspaceId } = sketch;
  const files = sketch.scope === 'project' && sketch.projectId && records.length
    ? await ports.files.ofThoughts(sketch.projectId, records.map((record) => record.id)) : new Map<string, ThoughtFile>();
  const placements = new Map<string, Placement>();
  for (const record of records) {
    if (!record.placement || placements.has(record.placement.id)) continue;
    const view = await ports.access.placement(principal, record.placement);
    const title = view.readable && view.workspaceId === workspaceId ? view.title : null;
    placements.set(record.placement.id, { ...record.placement, title });
  }
  return records.map((record) => ({
    id: record.id, sketchId: record.sketchId, text: record.text, x: record.x, y: record.y, width: record.width, height: record.height,
    shape: record.shape, placement: record.placement ? placements.get(record.placement.id)! : null,
    source: record.source ? { author: { id: record.source.authorId, name: record.source.authorName }, sentAt: iso(record.source.sentAt), dmMessageId: record.source.messageId } : null,
    ...(files.has(record.id) ? { file: files.get(record.id)! } : {}),
    createdBy: record.createdBy,
    version: record.version, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  }));
}

function checkVersion(current: ThoughtRecord, expected: unknown, view: Thought) {
  const version = valid.expectedVersion(expected);
  if (current.version !== version) throw new VersionConflictError(current.version, view);
}

/** Asks the access port, then reads the sketch it allowed. */
async function authorized(ports: SketchPorts, principal: Principal, action: 'sketch.read' | 'sketch.write', sketchId: string) {
  const access = await ports.access.requireSketch(principal, action, sketchId, { lock: action === 'sketch.write' });
  const sketch = await ports.sketches.findSketch(sketchId);
  if (!sketch) throw new NotFoundError('Sketch', 'SKETCH_NOT_FOUND');
  return { sketch, access };
}

async function lockedThought(ports: SketchPorts, sketchId: string, thoughtId: string) {
  const [thought] = await ports.sketches.lockThoughts(sketchId, [thoughtId]);
  if (!thought) throw new NotFoundError('Thought', 'THOUGHT_NOT_FOUND');
  return thought;
}

type PromotionChoice = { kind: 'new' } | { kind: 'existing'; projectId: string } | null;

/**
 * Whether a new project from a DM sketch gives the DM's other participants access (#188). `grant`
 * (the #96 default) or `none`; the web app states it, unchecked by default, so nobody is added
 * without the person choosing it. An existing project's audience never changes by a promotion.
 */
function participantChoice(value: unknown): boolean {
  if (value === undefined || value === 'grant') return true;
  if (value === 'none') return false;
  throw new InvalidInputError('participants must be grant or none');
}

/** The participants a new project is granted to: all of them, or only the caller. */
const grantees = (participants: { id: string; name: string }[], principal: Principal, grant: boolean) =>
  grant ? participants : participants.filter((person) => person.id === principal.id);

/**
 * The exact audience and content of copying `sketch` (a DM sketch) to `choice`. The token names
 * the target, every reader and every thought, link and version, so a promotion commits only what
 * the person saw. Without a choice it proposes a new project, or else the first project they can change.
 */
async function promotionPreview(ports: SketchPorts, principal: Principal, sketch: SketchRecord, requested: PromotionChoice,
  participants: { id: string; name: string }[], grant = true): Promise<SketchPromotionPreview> {
  const dmId = sketch.dmId!;
  const [targets, thoughts, links, messageCount] = await Promise.all([
    ports.promotion.targets(principal, sketch.workspaceId),
    ports.sketches.thoughts(sketch.id), ports.sketches.links(sketch.id), ports.sketches.dmMessageCount(dmId),
  ]);
  let choice = requested;
  if (!choice) choice = targets.canCreateProject ? { kind: 'new' } : targets.projects[0] ? { kind: 'existing', projectId: targets.projects[0].id } : null;
  if (choice?.kind === 'new' && !targets.canCreateProject) throw new ForbiddenError('Only workspace owners and admins can create a project; copy it into a project you can change', 'PROJECT_CREATE_FORBIDDEN');
  const { people, projectName } = choice ? await ports.promotion.audience(principal, sketch.workspaceId, grantees(participants, principal, grant), choice) : { people: [], projectName: null };
  const readers = new Set(people.map((person) => person.id));
  const fromMessages = thoughts.filter((thought) => thought.source?.messageId);
  const quoted = new Set(fromMessages.map((thought) => thought.source!.messageId));
  const content = { thoughts: thoughts.length, links: links.length, fromMessages: fromMessages.length };
  const target = !choice ? null : choice.kind === 'new' ? { kind: 'new' as const } : { kind: 'existing' as const, projectId: choice.projectId, projectName: projectName ?? '' };
  const token = createHash('sha256').update(JSON.stringify({
    sketch: sketch.id, target: choice, readers: [...readers].sort(),
    thoughts: thoughts.map((t) => `${t.id}:${t.version}`).sort(), links: links.map((l) => l.id).sort(),
  })).digest('base64url');
  return {
    sketchId: sketch.id, target, canCreateProject: targets.canCreateProject, projects: targets.projects, audience: people,
    leftOut: participants.filter((person) => choice && !readers.has(person.id)), content,
    staysInDm: { messages: Math.max(0, messageCount - quoted.size) }, token,
  };
}

function promotionChoice(query: { target?: unknown; projectId?: unknown }): PromotionChoice {
  if (query.projectId !== undefined) return { kind: 'existing', projectId: valid.id(query.projectId, 'projectId') };
  if (query.target === 'new') return { kind: 'new' };
  if (query.target !== undefined) throw new InvalidInputError('target must be new, or name a projectId');
  return null;
}

export function createSketchUseCases(uow: SketchUnitOfWork) {
  const changed = (ports: SketchPorts, principal: Principal, sketch: SketchRecord, data: Record<string, unknown>) =>
    ports.sketches.touchSketch(sketch.id).then(async () => {
      await ports.live.commit(principal, sketch);
      await ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, data);
    });

  return {
    async list(principal: Principal, workspaceId: string, query: SketchListQuery = {}): Promise<SketchPage> {
      const page = valid.page(query);
      const projectId = valid.optionalId(query.projectId, 'projectId') ?? undefined;
      const dmId = valid.optionalId(query.dmId, 'dmId') ?? undefined;
      if (query.scope !== undefined && query.scope !== 'private') throw new InvalidInputError('scope can only be private', 'INVALID_SCOPE');
      const scope = query.scope;
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspaceId);
        const { items, total } = await ports.sketches.listVisible(principal, workspaceId, { projectId, dmId, scope }, page);
        const sketches: Sketch[] = [];
        for (const item of items) {
          const access = await ports.access.accessOf(principal, item.id);
          if (access) sketches.push(presentSketch(item, access));
        }
        return { items: sketches, total, ...page };
      });
    },

    async create(principal: Principal, workspaceId: string, command: CreateSketchCommand): Promise<Sketch> {
      const title = valid.text(command?.title, 'title', SKETCH_LIMITS.title);
      let target: SketchTarget;
      if (command?.scope !== 'project' && command?.projectId !== undefined) throw new InvalidInputError('projectId applies to project sketches only');
      if (command?.scope !== 'dm' && (command?.dmId !== undefined || command?.fromMessageIds !== undefined)) throw new InvalidInputError('dmId and fromMessageIds apply to DM sketches only');
      if (command?.scope === 'project') {
        target = { scope: 'project', workspaceId, projectId: valid.id(command.projectId, 'projectId') };
      } else if (command?.scope === 'private') {
        target = { scope: 'private', workspaceId };
      } else if (command?.scope === 'dm') {
        target = { scope: 'dm', workspaceId, dmId: valid.id(command.dmId, 'dmId') };
      } else {
        throw new InvalidInputError('scope must be one of project, private, dm');
      }
      const fromMessages = command.fromMessageIds === undefined ? [] : valid.ids(command.fromMessageIds, 'fromMessageIds', SKETCH_LIMITS.fromMessages);
      return uow.run(async (ports) => {
        await ports.access.requireCreate(principal, target);
        const dmId = target.scope === 'dm' ? target.dmId : null;
        // "Start sketch from these messages": only messages of this DM, which the caller reads now.
        const messages = dmId && fromMessages.length ? await ports.sketches.dmMessages(dmId, fromMessages) : [];
        if (messages.length !== fromMessages.length) throw new NotFoundError('Message', 'MESSAGE_NOT_FOUND');
        const record = await ports.sketches.insertSketch({
          id: randomUUID(), workspaceId, scope: target.scope, projectId: target.scope === 'project' ? target.projectId : null, dmId,
          title, createdBy: principal,
        });
        const thoughtIds: string[] = [];
        for (const [index, message] of messages.entries()) {
          const thought = await ports.sketches.insertThought({
            id: randomUUID(), workspaceId, sketchId: record.id, text: thoughtText(message.body), ...messageSpot(index),
            ...DEFAULT_THOUGHT_SIZE, shape: 'card', placement: null, createdBy: principal,
            source: { authorId: message.authorId, authorName: message.authorName, sentAt: message.createdAt, dmId: message.dmId, messageId: message.id },
          });
          thoughtIds.push(thought.id);
        }
        await ports.events.record(principal, workspaceId, 'sketch.created.v1', record.id, { scope: record.scope, thoughtIds });
        return presentSketch(record, 'write');
      });
    },

    async get(principal: Principal, sketchId: string): Promise<SketchDetail> {
      return uow.run(async (ports) => {
        const { sketch, access } = await authorized(ports, principal, 'sketch.read', sketchId);
        const [thoughts, links] = await Promise.all([ports.sketches.thoughts(sketch.id), ports.sketches.links(sketch.id)]);
        // A DM sketch lists only the project copies the caller can open now.
        const copies: SketchCopy[] = [];
        if (sketch.scope === 'dm') {
          for(const copy of await ports.sketches.copiesOf(sketch.id)) {
            try {await ports.access.requireSketch(principal,'sketch.read',copy.sketchId,{lock:true});copies.push(copy);}
            catch(error){if(!(error instanceof ForbiddenError||error instanceof NotFoundError))throw error;}
          }
        }
        return {
          ...presentSketch(sketch, access),
          thoughts: await presentThoughts(ports, principal, sketch, thoughts),
          links: links.map(presentThoughtLink),
          copies,
        };
      });
    },

    /** Canonical bounded map view. The caller holds the map row's read lock for a stable checkpoint. */
    async getWindow(principal: Principal, sketchId: string, query: { limit?: number; offset?: number; linkOffset?: number; expectedUpdatedAt?: string }) {
      const page = valid.page(query);
      const linkPage = valid.page({ limit: page.limit, offset: query.linkOffset });
      if (page.limit > 50) throw new InvalidInputError('A map window is at most 50 thoughts and links');
      return uow.run(async (ports) => {
        const { sketch, access } = await authorized(ports, principal, 'sketch.read', sketchId);
        if ((page.offset > 0 || linkPage.offset > 0) && query.expectedUpdatedAt === undefined)
          throw new InvalidInputError('A continuation needs the map updatedAt checkpoint', 'VERSION_REQUIRED');
        if (query.expectedUpdatedAt !== undefined && query.expectedUpdatedAt !== iso(sketch.updatedAt))
          throw new ConflictError('The map changed; read it again from the first page', 'SOURCE_VERSION_CONFLICT');
        const [thoughts, links, counts] = await Promise.all([ports.sketches.thoughts(sketch.id, page),
          ports.sketches.links(sketch.id, linkPage), ports.sketches.mapCounts(sketch.id)]);
        return { ...presentSketch(sketch, access), thoughts: await presentThoughts(ports, principal, sketch, thoughts), links: links.map(presentThoughtLink),
          thoughtPage: { ...page, total: counts.thoughts, nextOffset: page.offset + page.limit < counts.thoughts ? page.offset + page.limit : null },
          linkPage: { ...linkPage, total: counts.links, nextOffset: linkPage.offset + linkPage.limit < counts.links ? linkPage.offset + linkPage.limit : null } };
      });
    },

    async rename(principal: Principal, sketchId: string, command: UpdateSketchCommand): Promise<Sketch> {
      const title = valid.text(command?.title, 'title', SKETCH_LIMITS.title);
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const version = valid.expectedVersion(command.expectedVersion);
        if (sketch.version !== version) throw new VersionConflictError(sketch.version, presentSketch(sketch, 'write'));
        await ports.live.before(principal,sketch,{thoughtIds:[],linkIds:[],sketch:true});
        const renamed = await ports.sketches.renameSketch(sketch.id, title);
        await ports.live.commit(principal,sketch);
        await ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, { op: 'renamed' });
        return presentSketch(renamed, 'write');
      });
    },

    async addThought(principal: Principal, sketchId: string, command: CreateThoughtCommand): Promise<CreatedThought> {
      const thoughtId = valid.optionalId(command?.id, 'id') ?? randomUUID();
      const values = {
        text: valid.text(command.text, 'text', SKETCH_LIMITS.text),
        x: valid.coordinate(command.x, 'x'),
        y: valid.coordinate(command.y, 'y'),
        width: command.width === undefined ? DEFAULT_THOUGHT_SIZE.width : valid.width(command.width),
        height: command.height === undefined ? DEFAULT_THOUGHT_SIZE.height : valid.height(command.height),
        shape: command.shape === undefined ? 'card' as const : valid.shape(command.shape),
      };
      const placement = command.placement === undefined ? null : (() => {
        if (command.placement?.type !== 'draft') throw new InvalidInputError('placement.type must be draft');
        return { type: 'draft' as const, id: valid.id(command.placement.id, 'placement.id') };
      })();
      const linkFrom = command.linkFrom === undefined ? null : {
        thoughtId: valid.id(command.linkFrom?.thoughtId, 'linkFrom.thoughtId'),
        label: valid.label(command.linkFrom.label),
        linkId: valid.optionalId(command.linkFrom.linkId, 'linkFrom.linkId') ?? randomUUID(),
      };
      const sourceMessageId = valid.optionalId(command.sourceMessageId, 'sourceMessageId');
      const fileId = valid.optionalId(command.fileId, 'fileId');
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        let source: ThoughtSourceRecord | null = null;
        if (sourceMessageId) {
          if (sketch.scope !== 'dm') throw new RuleViolationError('Only a thought in a DM sketch can quote a message of that DM', 'NOT_A_DM_SKETCH');
          const [message] = await ports.sketches.dmMessages(sketch.dmId!, [sourceMessageId]);
          if (!message) throw new NotFoundError('Message', 'MESSAGE_NOT_FOUND');
          source = { authorId: message.authorId, authorName: message.authorName, sentAt: message.createdAt, dmId: message.dmId, messageId: message.id };
        }
        if (placement) {
          const view = await ports.access.placement(principal, placement);
          if (!view.readable) throw new NotFoundError('Draft', 'DRAFT_NOT_FOUND');
          if (view.workspaceId !== sketch.workspaceId) throw new RuleViolationError('A placed object must belong to the sketch’s workspace', 'CROSS_WORKSPACE');
        }
        if (linkFrom) await lockedThought(ports, sketch.id, linkFrom.thoughtId);
        if (await ports.sketches.thoughtExists(thoughtId)) throw new ConflictError('A thought with this id already exists', 'THOUGHT_EXISTS');
        if (linkFrom && await ports.sketches.linkExists(linkFrom.linkId)) throw new ConflictError('A link with this id already exists', 'LINK_EXISTS');
        await ports.live.before(principal,sketch,{thoughtIds:[thoughtId,...(linkFrom?[linkFrom.thoughtId]:[])],linkIds:linkFrom?[linkFrom.linkId]:[]});
        // #252: stored files belong to a project, so only a project sketch's thought can show one.
        if (fileId && (sketch.scope !== 'project' || !sketch.projectId))
          throw new RuleViolationError('Images can be placed only on a project’s maps', 'IMAGES_NEED_A_PROJECT');
        if (fileId) await ports.files.place(principal, { projectId: sketch.projectId!, fileId, thoughtId });
        const thought = await ports.sketches.insertThought({ id: thoughtId, workspaceId: sketch.workspaceId, sketchId: sketch.id, ...values, placement, source, createdBy: principal });
        const link = linkFrom ? await ports.sketches.insertLink({
          id: linkFrom.linkId, workspaceId: sketch.workspaceId, sketchId: sketch.id, fromId: linkFrom.thoughtId, toId: thought.id, label: linkFrom.label, createdBy: principal,
        }) : null;
        const [view] = await presentThoughts(ports, principal, sketch, [thought]);
        await changed(ports, principal, sketch, { op: 'thought_added', thoughtIds: [thought.id], linkIds: link ? [link.id] : [] });
        return { thought: view!, link: link ? presentThoughtLink(link) : null };
      });
    },

    async updateThought(principal: Principal, sketchId: string, thoughtId: string, command: UpdateThoughtCommand): Promise<Thought> {
      const changes: ThoughtChanges = {};
      if (command?.text !== undefined) changes.text = valid.text(command.text, 'text', SKETCH_LIMITS.text);
      if (command?.x !== undefined) changes.x = valid.coordinate(command.x, 'x');
      if (command?.y !== undefined) changes.y = valid.coordinate(command.y, 'y');
      if (command?.width !== undefined) changes.width = valid.width(command.width);
      if (command?.height !== undefined) changes.height = valid.height(command.height);
      if (command?.shape !== undefined) changes.shape = valid.shape(command.shape);
      if (!Object.keys(changes).length) throw new InvalidInputError('Change at least one of text, x, y, width, height, shape');
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const current = await lockedThought(ports, sketch.id, valid.id(thoughtId, 'thoughtId'));
        const [currentView] = await presentThoughts(ports, principal, sketch, [current]);
        checkVersion(current, command.expectedVersion, currentView!);
        await ports.live.before(principal,sketch,{thoughtIds:[current.id],linkIds:[],leaseId:command.leaseId});
        const updated = await ports.sketches.updateThought(sketch.id, current.id, changes);
        const [view] = await presentThoughts(ports, principal, sketch, [updated]);
        await changed(ports, principal, sketch, { op: 'thought_updated', thoughtIds: [current.id], linkIds: [] });
        return view!;
      });
    },

    async moveThoughts(principal: Principal, sketchId: string, command: MoveThoughtsCommand): Promise<MovedThoughts> {
      const moves = command?.moves;
      if (!Array.isArray(moves) || !moves.length || moves.length > SKETCH_LIMITS.moves) throw new InvalidInputError(`moves must list 1–${SKETCH_LIMITS.moves} thoughts`);
      const parsed = moves.map((move, index) => ({
        id: valid.id(move?.id, `moves[${index}].id`),
        x: valid.coordinate(move?.x, `moves[${index}].x`),
        y: valid.coordinate(move?.y, `moves[${index}].y`),
        expectedVersion: move?.expectedVersion,
      }));
      if (new Set(parsed.map((move) => move.id)).size !== parsed.length) throw new InvalidInputError('Each thought may appear once in moves');
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const locked = new Map((await ports.sketches.lockThoughts(sketch.id, parsed.map((move) => move.id))).map((row) => [row.id, row]));
        if (locked.size !== parsed.length) throw new NotFoundError('Thought', 'THOUGHT_NOT_FOUND');
        const stale = parsed.filter((move) => locked.get(move.id)!.version !== valid.expectedVersion(move.expectedVersion));
        if (stale.length) {
          const views = await presentThoughts(ports, principal, sketch, stale.map((move) => locked.get(move.id)!));
          throw new PositionsConflictError(views.map((view) => ({ id: view.id, currentVersion: view.version, current: view })));
        }
        await ports.live.before(principal,sketch,{thoughtIds:parsed.map(move=>move.id),linkIds:[],leaseId:command.leaseId});
        const updated: ThoughtRecord[] = [];
        for (const move of parsed) updated.push(await ports.sketches.updateThought(sketch.id, move.id, { x: move.x, y: move.y }));
        const thoughts = await presentThoughts(ports, principal, sketch, updated);
        await changed(ports, principal, sketch, { op: 'thoughts_moved', thoughtIds: parsed.map((move) => move.id), linkIds: [] });
        return { thoughts };
      });
    },

    async removeThought(principal: Principal, sketchId: string, thoughtId: string, expected: number | undefined): Promise<void> {
      await uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const current = await lockedThought(ports, sketch.id, valid.id(thoughtId, 'thoughtId'));
        const [currentView] = await presentThoughts(ports, principal, sketch, [current]);
        checkVersion(current, expected, currentView!);
        const linkIds = (await ports.sketches.relatedLinks(sketch.id,{thoughtId:current.id})).map((link) => link.id);
        await ports.live.before(principal,sketch,{thoughtIds:[current.id],linkIds});
        await ports.sketches.deleteThought(sketch.id, current.id);
        await changed(ports, principal, sketch, { op: 'thought_removed', thoughtIds: [current.id], linkIds });
      });
    },

    async addLink(principal: Principal, sketchId: string, command: CreateLinkCommand): Promise<ThoughtLink> {
      const linkId = valid.optionalId(command?.id, 'id') ?? randomUUID();
      const fromId = valid.id(command?.fromId, 'fromId');
      const toId = valid.id(command?.toId, 'toId');
      const text = valid.label(command.label);
      if (fromId === toId) throw new RuleViolationError('A thought cannot link to itself', 'SELF_LINK');
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const found = await ports.sketches.lockThoughts(sketch.id, [fromId, toId]);
        if (found.length !== 2) throw new NotFoundError('Thought', 'THOUGHT_NOT_FOUND');
        if (await ports.sketches.linkBetween(sketch.id, fromId, toId)) throw new ConflictError('These thoughts are already linked', 'LINK_EXISTS');
        if (await ports.sketches.linkExists(linkId)) throw new ConflictError('A link with this id already exists', 'LINK_EXISTS');
        await ports.live.before(principal,sketch,{thoughtIds:[fromId,toId],linkIds:[linkId]});
        const link = await ports.sketches.insertLink({ id: linkId, workspaceId: sketch.workspaceId, sketchId: sketch.id, fromId, toId, label: text, createdBy: principal });
        await changed(ports, principal, sketch, { op: 'link_added', thoughtIds: [fromId, toId], linkIds: [link.id] });
        return presentThoughtLink(link);
      });
    },

    async removeLink(principal: Principal, sketchId: string, linkId: string): Promise<void> {
      await uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const id = valid.id(linkId, 'linkId');
        await ports.live.before(principal,sketch,{thoughtIds:[],linkIds:[id]});
        if (!await ports.sketches.deleteLink(sketch.id, id)) throw new NotFoundError('Link', 'LINK_NOT_FOUND');
        await changed(ports, principal, sketch, { op: 'link_removed', thoughtIds: [], linkIds: [id] });
      });
    },

    /** What copying a DM sketch into a project would share, and with whom (#96). Changes nothing. */
    async previewPromotion(principal: Principal, sketchId: string, query: { target?: unknown; projectId?: unknown; participants?: unknown } = {}): Promise<SketchPromotionPreview> {
      const choice = promotionChoice(query);
      const grant = participantChoice(query.participants);
      return uow.run(async (ports) => {
        const { sketch, access } = await authorized(ports, principal, 'sketch.read', sketchId);
        if (sketch.scope !== 'dm') throw new RuleViolationError('Only a sketch in a direct message is copied into a project', 'NOT_A_DM_SKETCH');
        await ports.access.requireDmOpen(principal, sketch.dmId!);
        if (access !== 'write') throw new ForbiddenError('Not allowed to perform this action on the sketch');
        return promotionPreview(ports, principal, sketch, choice, await ports.sketches.dmParticipants(sketch.dmId!), grant);
      });
    },

    /**
     * Copies a DM sketch into a new restricted project (granted to exactly the DM's participants, or
     * with `participants: 'none'` to nobody but its managers, #188) or an existing project the caller can change. Only the sketch's thoughts, links and each source
     * message's author and time are copied; the copy keeps no reference into the DM, so later DM
     * messages and sketch changes never reach it. `token` must match the current preview.
     */
    async promote(principal: Principal, sketchId: string, command: PromoteSketchCommand): Promise<PromotedSketch> {
      const target = command?.target;
      let choice: NonNullable<PromotionChoice>;
      let name: string | null = null;
      if (target?.kind === 'new') { choice = { kind: 'new' }; name = valid.text(target.name, 'target.name', 200); }
      else if (target?.kind === 'existing') choice = { kind: 'existing', projectId: valid.id(target.projectId, 'target.projectId') };
      else throw new InvalidInputError('target.kind must be new or existing');
      if (typeof command.token !== 'string' || !command.token) throw new InvalidInputError('token must be the preview token');
      const grant = participantChoice(command.participants);
      return uow.run(async (ports) => {
        // The audience is locked before it is read, and read once: every row whose change would
        // alter who can open the copy (workspace members, the target project's grants, the DM's
        // participants) stays as it is until this commits, so the token is checked against the
        // audience that is actually granted.
        await ports.access.lockPromotion(sketchId, choice.kind === 'existing' ? choice.projectId : null);
        // Read with the locks of a change, so a closed DM explains itself instead of a bare 403.
        const access = await ports.access.requireSketch(principal, 'sketch.read', sketchId, { lock: true });
        const sketch = await ports.sketches.findSketch(sketchId);
        if (!sketch) throw new NotFoundError('Sketch', 'SKETCH_NOT_FOUND');
        if (sketch.scope !== 'dm') throw new RuleViolationError('Only a sketch in a direct message is copied into a project', 'NOT_A_DM_SKETCH');
        const locked = new Set(await ports.access.lockParticipants(sketch.dmId!));
        await ports.access.requireDmOpen(principal, sketch.dmId!);
        if (access !== 'write') throw new ForbiddenError('Not allowed to perform this action on the sketch');
        const participants = (await ports.sketches.dmParticipants(sketch.dmId!)).filter((p) => locked.has(p.id));
        await ports.live.before(principal,sketch,{thoughtIds:[],linkIds:[]});
        const preview = await promotionPreview(ports, principal, sketch, choice, participants, grant);
        if (preview.token !== command.token) throw new PromotionChangedError(preview);
        const project = choice.kind === 'new'
          ? await ports.promotion.createProject(principal, sketch.workspaceId, name!, grantees(participants, principal, grant).map((p) => p.id))
          : { id: choice.projectId, name: preview.target?.kind === 'existing' ? preview.target.projectName : '' };
        const copy = await ports.sketches.insertSketch({
          id: randomUUID(), workspaceId: sketch.workspaceId, scope: 'project', projectId: project.id, dmId: null, title: sketch.title,
          createdBy: principal, copy: { fromSketchId: sketch.id, byUserId: principal.id },
        });
        const ids = new Map<string, string>();
        for (const thought of await ports.sketches.thoughts(sketch.id)) {
          const id = randomUUID();
          ids.set(thought.id, id);
          await ports.sketches.insertThought({
            id, workspaceId: sketch.workspaceId, sketchId: copy.id, text: thought.text, x: thought.x, y: thought.y,
            width: thought.width, height: thought.height, shape: thought.shape,
            // A placement names an object with its own audience; the copy carries only the text.
            placement: null,
            source: thought.source ? { ...thought.source, dmId: null, messageId: null } : null,
            createdBy: { kind: thought.createdBy.kind, id: thought.createdBy.id }, createdAt: thought.createdAt, updatedAt: thought.updatedAt,
          });
        }
        for (const link of await ports.sketches.links(sketch.id)) {
          await ports.sketches.insertLink({
            id: randomUUID(), workspaceId: sketch.workspaceId, sketchId: copy.id, fromId: ids.get(link.fromId)!, toId: ids.get(link.toId)!,
            label: link.label, createdBy: principal,
          });
        }
        await ports.events.record(principal, sketch.workspaceId, 'sketch.created.v1', copy.id, { scope: 'project', op: 'copied_from_dm' });
        await ports.sketches.touchSketch(sketch.id);await ports.live.commit(principal,sketch);
        // The DM's own record of the copy; its audience is the DM's participants.
        await ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, { op: 'copied_to_project', sketchId: copy.id, projectId: project.id });
        return { sketch: presentSketch(copy, 'write'), project };
      });
    },
  };
}

export type SketchUseCases = ReturnType<typeof createSketchUseCases>;
