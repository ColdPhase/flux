import { randomUUID } from 'node:crypto';
import {
  DEFAULT_THOUGHT_SIZE,
  SKETCH_LIMITS,
  UNTITLED_SKETCH,
  type CreateLinkCommand,
  type CreateSketchCommand,
  type CreatedThought,
  type CreateThoughtCommand,
  type MovedThoughts,
  type MovedToMap,
  type MoveToMapCommand,
  type MoveThoughtsCommand,
  type Sketch,
  type SketchDetail,
  type SketchListQuery,
  type SketchPage,
  type Thought,
  type ThoughtFile,
  type ThoughtLink,
  type UpdateSketchCommand,
  type UpdateLinkLabelCommand,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { LinkRecord, SketchPorts, SketchRecord, SketchTarget, SketchUnitOfWork, ThoughtChanges, ThoughtRecord, ThoughtSourceRecord } from './ports.js';
import * as valid from './validation.js';

// Sketch use cases (issue #69). Each one runs in a unit of work: it asks the access port first
// (reads: `sketch.read`; changes: `sketch.write` with the sketch locked), then validates the
// caller's version, changes rows through the repository and records one event, so the
// decision, the change and the stream event commit together.

/** 409 for a batch of moves: nothing moved; each stale thought comes back as the caller may read it now. */
export class PositionsConflictError extends ConflictError {
  constructor(conflicts: { id: string; currentVersion: number; current: Thought }[]) {
    super('Some thoughts changed since the expected versions', 'VERSION_CONFLICT');
    this.details = { conflicts };
  }
}

/** Nothing changed: the caller must review the current connection label before saving again. */
export class LinkLabelConflictError extends ConflictError {
  constructor(current: ThoughtLink) {
    super('The connection label changed. Review the current label before saving again.', 'LABEL_CONFLICT');
    this.details = { currentLabel: current.label, current };
  }
}

/** How far under the lowest thought of the target map a moved group lands, on the plane (a thought is at most 800 high but is usually drawn higher than its stored height). */
const MOVE_GAP = 96;

const iso = (date: Date) => date.toISOString();

export function presentSketch(record: SketchRecord, access: 'read' | 'write'): Sketch {
  return {
    id: record.id, workspaceId: record.workspaceId, scope: record.scope, projectId: record.projectId, title: record.title,
    createdBy: record.createdBy,
    access, version: record.version, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
    ...(record.thoughtCount === undefined ? {} : { thoughtCount: record.thoughtCount }),
  };
}

export function presentThoughtLink(record: LinkRecord): ThoughtLink {
  return { id: record.id, sketchId: record.sketchId, fromId: record.fromId, toId: record.toId, label: record.label, createdAt: iso(record.createdAt) };
}

/**
 * Thoughts as they are presented. A project sketch's
 * thoughts carry their image (#252); its readers are the project's readers, who may read its published files.
 * Exported for the live map deltas (#228), which present the same views.
 */
export async function presentThoughts(ports: Pick<SketchPorts, 'files'>, sketch: Pick<SketchRecord, 'scope' | 'projectId'>, records: ThoughtRecord[]): Promise<Thought[]> {
  const files = sketch.scope === 'project' && sketch.projectId && records.length
    ? await ports.files.ofThoughts(sketch.projectId, records.map((record) => record.id)) : new Map<string, ThoughtFile>();
  return records.map((record) => ({
    id: record.id, sketchId: record.sketchId, text: record.text, x: record.x, y: record.y, width: record.width, height: record.height,
    shape: record.shape,
    source: record.source ? { author: { kind: record.source.authorKind, id: record.source.authorId, name: record.source.authorName },
      sentAt: iso(record.source.sentAt), projectMessageId: record.source.projectMessageId } : null,
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

export function createSketchUseCases(uow: SketchUnitOfWork) {
  const changed = (ports: SketchPorts, principal: Principal, sketch: SketchRecord, data: Record<string, unknown>) =>
    ports.sketches.touchSketch(sketch.id, principal).then(async () => {
      await ports.live.commit(principal, sketch);
      await ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, data);
    });

  return {
    async list(principal: Principal, workspaceId: string, query: SketchListQuery = {}): Promise<SketchPage> {
      const page = valid.page(query);
      const projectId = valid.optionalId(query.projectId, 'projectId') ?? undefined;
      if (query.scope !== undefined && query.scope !== 'private') throw new InvalidInputError('scope can only be private', 'INVALID_SCOPE');
      const scope = query.scope;
      if (query.hideEmpty !== undefined && typeof query.hideEmpty !== 'boolean') throw new InvalidInputError('hideEmpty must be true or false');
      const hideEmpty = query.hideEmpty === true;
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspaceId);
        const { items, total } = await ports.sketches.listVisible(principal, workspaceId, { projectId, scope, hideEmpty }, page);
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
      if (command?.scope === 'project') {
        target = { scope: 'project', workspaceId, projectId: valid.id(command.projectId, 'projectId') };
      } else if (command?.scope === 'private') {
        target = { scope: 'private', workspaceId };
      } else {
        throw new InvalidInputError('scope must be one of project, private');
      }
      return uow.run(async (ports) => {
        await ports.access.requireCreate(principal, target);
        // One private map for each person in a company (#947); the database holds the same rule for a race.
        if (target.scope === 'private') {
          if (await ports.sketches.privateSketchOf(workspaceId, principal.id)) throw new ConflictError('You already have your map', 'MY_MAP_EXISTS');
        }
        const record = await ports.sketches.insertSketch({
          id: randomUUID(), workspaceId, scope: target.scope, projectId: target.scope === 'project' ? target.projectId : null,
          title, createdBy: principal,
        });
        await ports.events.record(principal, workspaceId, 'sketch.created.v1', record.id, { scope: record.scope, thoughtIds: [] });
        return presentSketch(record, 'write');
      });
    },

    async get(principal: Principal, sketchId: string): Promise<SketchDetail> {
      return uow.run(async (ports) => {
        const { sketch, access } = await authorized(ports, principal, 'sketch.read', sketchId);
        const [thoughts, links] = await Promise.all([ports.sketches.thoughts(sketch.id), ports.sketches.links(sketch.id)]);
        return {
          ...presentSketch(sketch, access),
          thoughts: await presentThoughts(ports, sketch, thoughts),
          links: links.map(presentThoughtLink),
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
        return { ...presentSketch(sketch, access), thoughts: await presentThoughts(ports, sketch, thoughts), links: links.map(presentThoughtLink),
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
        const renamed = await ports.sketches.renameSketch(sketch.id, title, principal);
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
      const linkFrom = command.linkFrom === undefined ? null : {
        thoughtId: valid.id(command.linkFrom?.thoughtId, 'linkFrom.thoughtId'),
        label: valid.label(command.linkFrom.label),
        linkId: valid.optionalId(command.linkFrom.linkId, 'linkFrom.linkId') ?? randomUUID(),
      };
      const sourceProjectMessageId = valid.optionalId(command.sourceProjectMessageId, 'sourceProjectMessageId');
      const fileId = valid.optionalId(command.fileId, 'fileId');
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        let source: ThoughtSourceRecord | null = null;
        if (sourceProjectMessageId) {
          if (sketch.scope !== 'project' || !sketch.projectId) throw new RuleViolationError('Only a thought on a space map can quote a space message', 'NOT_A_PROJECT_SKETCH');
          const [message] = await ports.sketches.projectMessages(sketch.projectId, [sourceProjectMessageId]);
          if (!message) throw new NotFoundError('Message', 'MESSAGE_NOT_FOUND');
          source = { authorId: message.authorId, authorKind: message.authorKind, authorName: message.authorName, sentAt: message.createdAt,
            projectMessageId: message.id };
        }
        if (await ports.sketches.thoughtExists(thoughtId)) throw new ConflictError('A thought with this id already exists', 'THOUGHT_EXISTS');
        if (linkFrom && await ports.sketches.linkExists(linkFrom.linkId)) throw new ConflictError('A link with this id already exists', 'LINK_EXISTS');
        await ports.live.before(principal,sketch,{thoughtIds:[thoughtId,...(linkFrom?[linkFrom.thoughtId]:[])],linkIds:linkFrom?[linkFrom.linkId]:[]});
        // #252: stored files belong to a project, so only a project sketch's thought can show one.
        if (fileId && (sketch.scope !== 'project' || !sketch.projectId))
          throw new RuleViolationError('Images can be placed only on a space’s maps', 'IMAGES_NEED_A_PROJECT');
        const preparedImage=fileId&&ports.files.preparePlace?await ports.files.preparePlace(principal,{projectId:sketch.projectId!,fileId,thoughtId}):null;
        const artifacts=await ports.artifacts?.prepare(sketch,[thoughtId,...(linkFrom?[linkFrom.thoughtId]:[])]);
        if (linkFrom) await lockedThought(ports, sketch.id, linkFrom.thoughtId);
        if (fileId) {if(preparedImage)await preparedImage();else await ports.files.place(principal, { projectId: sketch.projectId!, fileId, thoughtId });}
        const thought = await ports.sketches.insertThought({ id: thoughtId, workspaceId: sketch.workspaceId, sketchId: sketch.id, ...values, source, createdBy: principal });
        const link = linkFrom ? await ports.sketches.insertLink({
          id: linkFrom.linkId, workspaceId: sketch.workspaceId, sketchId: sketch.id, fromId: linkFrom.thoughtId, toId: thought.id, label: linkFrom.label, createdBy: principal,
        }) : null;
        await artifacts?.thought(null,thought);
        if(fileId)await artifacts?.file(fileId);
        const [view] = await presentThoughts(ports, sketch, [thought]);
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
        const target=valid.id(thoughtId,'thoughtId');
        // Only a text change can be a canonical revision; geometry/shape keeps main's lock order without the task-graph fence.
        const artifacts=changes.text!==undefined?await ports.artifacts?.prepare(sketch,[target]):null;
        const current = await lockedThought(ports, sketch.id, target);
        const [currentView] = await presentThoughts(ports, sketch, [current]);
        checkVersion(current, command.expectedVersion, currentView!);
        await ports.live.before(principal,sketch,{thoughtIds:[current.id],linkIds:[],leaseId:command.leaseId});
        const updated = await ports.sketches.updateThought(sketch.id, current.id, changes, principal);
        await artifacts?.thought(current,updated);
        const [view] = await presentThoughts(ports, sketch, [updated]);
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
          const views = await presentThoughts(ports, sketch, stale.map((move) => locked.get(move.id)!));
          throw new PositionsConflictError(views.map((view) => ({ id: view.id, currentVersion: view.version, current: view })));
        }
        await ports.live.before(principal,sketch,{thoughtIds:parsed.map(move=>move.id),linkIds:[],leaseId:command.leaseId});
        const updated: ThoughtRecord[] = [];
        for (const move of parsed) updated.push(await ports.sketches.updateThought(sketch.id, move.id, { x: move.x, y: move.y }, principal));
        const thoughts = await presentThoughts(ports, sketch, updated);
        await changed(ports, principal, sketch, { op: 'thoughts_moved', thoughtIds: parsed.map((move) => move.id), linkIds: [] });
        return { thoughts };
      });
    },

    /**
     * Moves thoughts to another map the caller can change (#948). One all-or-nothing change over two maps: the thoughts appear on the
     * target as new thoughts with the same text, shape and size (a map keeps every id it has held, so the id changes), the originals
     * and their connections go, and connections between two moved thoughts are made again on the target. Both maps are locked in id
     * order so two moves in opposite directions never wait on each other, and the caller needs `sketch.write` on both.
     */
    async moveToMap(principal: Principal, fromSketchId: string, command: MoveToMapCommand): Promise<MovedToMap> {
      const fromId = valid.id(fromSketchId, 'sketchId');
      // One of the two: a map that exists, or a space's first map made with the move (so a move that fails leaves no empty map, #1116).
      if ((command?.toSketchId === undefined) === (command?.inSpace === undefined)) throw new InvalidInputError('Name the map to move to, or the space to make a map in');
      const toId = command.toSketchId === undefined ? null : valid.id(command.toSketchId, 'toSketchId');
      const inSpace = command.inSpace === undefined ? null : {
        workspaceId: valid.id(command.inSpace?.workspaceId, 'inSpace.workspaceId'), projectId: valid.id(command.inSpace?.projectId, 'inSpace.projectId'),
        title: command.inSpace.title === undefined ? UNTITLED_SKETCH : valid.text(command.inSpace.title, 'inSpace.title', SKETCH_LIMITS.title),
      };
      if (fromId === toId) throw new InvalidInputError('Choose another map to move the thoughts to', 'SAME_MAP');
      const listed = command?.thoughts;
      if (!Array.isArray(listed) || !listed.length || listed.length > SKETCH_LIMITS.moves) throw new InvalidInputError(`thoughts must list 1–${SKETCH_LIMITS.moves} thoughts`);
      const parsed = listed.map((item, index) => ({ id: valid.id(item?.id, `thoughts[${index}].id`), expectedVersion: item?.expectedVersion }));
      if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw new InvalidInputError('Each thought may appear once in thoughts');
      const at = command.at === undefined ? null : { x: valid.coordinate(command.at?.x, 'at.x'), y: valid.coordinate(command.at?.y, 'at.y') };
      return uow.run(async (ports) => {
        let source: SketchRecord;
        let target: SketchRecord;
        if (toId !== null) {
          const maps = new Map<string, Awaited<ReturnType<typeof authorized>>>();
          for (const id of [fromId, toId].sort()) maps.set(id, await authorized(ports, principal, 'sketch.write', id));
          source = maps.get(fromId)!.sketch;
          target = maps.get(toId)!.sketch;
        } else {
          source = (await authorized(ports, principal, 'sketch.write', fromId)).sketch;
          // The space's first map, in this same change: as any new map is made (the caller must be able to change the space).
          const place = { scope: 'project' as const, workspaceId: inSpace!.workspaceId, projectId: inSpace!.projectId };
          await ports.access.requireCreate(principal, place);
          target = await ports.sketches.insertSketch({ id: randomUUID(), workspaceId: place.workspaceId, scope: 'project', projectId: place.projectId, title: inSpace!.title, createdBy: principal });
          await ports.events.record(principal, place.workspaceId, 'sketch.created.v1', target.id, { scope: target.scope, thoughtIds: [] });
        }
        // My map is the one place a move starts or ends (#1116): the caller moves their own thoughts out of it, or into it. A thought of a
        // space is not moved to another space by anyone who can change both maps.
        const own = (map: SketchRecord) => map.scope === 'private' && map.createdBy.id === principal.id;
        if (!own(source) && !own(target)) throw new RuleViolationError('Move thoughts to or from your own My map', 'MOVE_NEEDS_MY_MAP');
        const locked = new Map((await ports.sketches.lockThoughts(source.id, parsed.map((item) => item.id))).map((row) => [row.id, row]));
        if (locked.size !== parsed.length) throw new NotFoundError('Thought', 'THOUGHT_NOT_FOUND');
        const stale = parsed.filter((item) => locked.get(item.id)!.version !== valid.expectedVersion(item.expectedVersion));
        if (stale.length) {
          const views = await presentThoughts(ports, source, stale.map((item) => locked.get(item.id)!));
          throw new PositionsConflictError(views.map((view) => ({ id: view.id, currentVersion: view.version, current: view })));
        }
        const records = parsed.map((item) => locked.get(item.id)!);
        // An image belongs to its space's files (#252): it stays where it is. My map has none, so nothing offers this move for one.
        if (source.scope === 'project' && source.projectId && (await ports.files.ofThoughts(source.projectId, records.map((row) => row.id))).size)
          throw new RuleViolationError('A thought with an image stays on its map', 'IMAGE_THOUGHT_STAYS');
        const related = new Map<string, LinkRecord>();
        for (const row of records) for (const link of await ports.sketches.relatedLinks(source.id, { thoughtId: row.id })) related.set(link.id, link);
        const moving = new Set(records.map((row) => row.id));
        const carried = [...related.values()].filter((link) => moving.has(link.fromId) && moving.has(link.toId));
        const severed = [...related.values()].filter((link) => !moving.has(link.fromId) || !moving.has(link.toId));
        // The group keeps its shape. It lands at `at`, else under everything on the target map (at its left edge), else where it was.
        const left = Math.min(...records.map((row) => row.x));
        const top = Math.min(...records.map((row) => row.y));
        const extent = at ? null : await ports.sketches.extent(target.id);
        const spot = at ?? (extent ? { x: extent.left, y: extent.bottom + MOVE_GAP } : { x: left, y: top });
        const clamp = (value: number) => Math.max(-SKETCH_LIMITS.coordinate, Math.min(SKETCH_LIMITS.coordinate, Math.round(value)));
        const idMap = new Map(records.map((row) => [row.id, randomUUID()]));
        const newLinkIds = new Map(carried.map((link) => [link.id, randomUUID()]));
        await ports.live.before(principal, source, { thoughtIds: [...moving], linkIds: [...related.keys()] });
        await ports.live.before(principal, target, { thoughtIds: [...idMap.values()], linkIds: [...newLinkIds.values()] });
        const artifacts = await ports.artifacts?.prepare(target, [...idMap.values()]);
        const inserted: ThoughtRecord[] = [];
        for (const row of records) {
          const thought = await ports.sketches.insertThought({ id: idMap.get(row.id)!, workspaceId: target.workspaceId, sketchId: target.id, text: row.text,
            x: clamp(spot.x + row.x - left), y: clamp(spot.y + row.y - top), width: row.width, height: row.height, shape: row.shape, source: null, createdBy: principal });
          await artifacts?.thought(null, thought);
          inserted.push(thought);
        }
        const links: LinkRecord[] = [];
        for (const link of carried) links.push(await ports.sketches.insertLink({ id: newLinkIds.get(link.id)!, workspaceId: target.workspaceId, sketchId: target.id,
          fromId: idMap.get(link.fromId)!, toId: idMap.get(link.toId)!, label: link.label, createdBy: principal }));
        for (const row of records) await ports.sketches.deleteThought(source.id, row.id);
        const views = await presentThoughts(ports, target, inserted);
        // The event names (`thought_removed`, `thought_added`) are the ones an encrypted space already accepts in its event data.
        await changed(ports, principal, source, { op: 'thought_removed', thoughtIds: [...moving], linkIds: [...related.keys()] });
        await changed(ports, principal, target, { op: 'thought_added', thoughtIds: inserted.map((row) => row.id), linkIds: links.map((link) => link.id) });
        return {
          fromSketchId: source.id, toSketchId: target.id,
          moved: records.map((row, index) => ({ from: row.id, thought: views[index]! })),
          links: links.map(presentThoughtLink), severed: severed.map(presentThoughtLink), origin: { x: left, y: top },
        };
      });
    },

    async removeThought(principal: Principal, sketchId: string, thoughtId: string, expected: number | undefined): Promise<void> {
      await uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const current = await lockedThought(ports, sketch.id, valid.id(thoughtId, 'thoughtId'));
        const [currentView] = await presentThoughts(ports, sketch, [current]);
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

    async updateLinkLabel(principal: Principal, sketchId: string, linkId: string, command: UpdateLinkLabelCommand): Promise<ThoughtLink> {
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const current = await ports.sketches.findLink(sketch.id, valid.id(linkId, 'linkId'));
        if (!current) throw new NotFoundError('Link', 'LINK_NOT_FOUND');
        if (command?.label === undefined || command?.expectedLabel === undefined)
          throw new InvalidInputError('label and expectedLabel are required');
        const label = valid.label(command.label);
        const expectedLabel = valid.label(command.expectedLabel, 'expectedLabel');
        if (current.label !== expectedLabel) throw new LinkLabelConflictError(presentThoughtLink(current));
        if (current.label === label) return presentThoughtLink(current);
        await ports.live.before(principal,sketch,{thoughtIds:[current.fromId,current.toId],linkIds:[current.id]});
        const updated = await ports.sketches.updateLinkLabel(sketch.id, current.id, label);
        await changed(ports, principal, sketch, { op: 'link_updated', thoughtIds: [current.fromId, current.toId], linkIds: [current.id] });
        return presentThoughtLink(updated);
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
  };
}

export type SketchUseCases = ReturnType<typeof createSketchUseCases>;
