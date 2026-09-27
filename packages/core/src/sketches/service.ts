import { randomUUID } from 'node:crypto';
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
  type Sketch,
  type SketchDetail,
  type SketchListQuery,
  type SketchPage,
  type Thought,
  type ThoughtLink,
  type UpdateSketchCommand,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { LinkRecord, SketchPorts, SketchRecord, SketchTarget, SketchUnitOfWork, ThoughtChanges, ThoughtRecord } from './ports.js';
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

const iso = (date: Date) => date.toISOString();

function toSketch(record: SketchRecord, participants: { id: string; name: string }[], access: 'read' | 'write'): Sketch {
  return {
    id: record.id, workspaceId: record.workspaceId, scope: record.scope, projectId: record.projectId, title: record.title,
    participants: record.scope === 'direct' ? participants : [], createdBy: record.createdBy, access, version: record.version,
    createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

function toLink(record: LinkRecord): ThoughtLink {
  return { id: record.id, sketchId: record.sketchId, fromId: record.fromId, toId: record.toId, label: record.label, createdAt: iso(record.createdAt) };
}

/** Thoughts as `principal` may see them: a placement's title only when its object is readable now. */
async function thoughtViews(ports: SketchPorts, principal: Principal, workspaceId: string, records: ThoughtRecord[]): Promise<Thought[]> {
  const placements = new Map<string, Placement>();
  for (const record of records) {
    if (!record.placement || placements.has(record.placement.id)) continue;
    const view = await ports.access.placement(principal, record.placement);
    const title = view.readable && view.workspaceId === workspaceId ? view.title : null;
    placements.set(record.placement.id, { ...record.placement, title });
  }
  return records.map((record) => ({
    id: record.id, sketchId: record.sketchId, text: record.text, x: record.x, y: record.y, width: record.width, height: record.height,
    shape: record.shape, placement: record.placement ? placements.get(record.placement.id)! : null, createdBy: record.createdBy,
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
    ports.sketches.touchSketch(sketch.id).then(() => ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, data));

  return {
    async list(principal: Principal, workspaceId: string, query: SketchListQuery = {}): Promise<SketchPage> {
      const page = valid.page(query);
      const projectId = valid.optionalId(query.projectId, 'projectId') ?? undefined;
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspaceId);
        const { items, total } = await ports.sketches.listVisible(principal, workspaceId, { projectId }, page);
        const participants = await ports.sketches.participants(items.map((item) => item.id));
        const sketches: Sketch[] = [];
        for (const item of items) {
          const access = await ports.access.accessOf(principal, item.id);
          if (access) sketches.push(toSketch(item, participants.get(item.id) ?? [], access));
        }
        return { items: sketches, total, ...page };
      });
    },

    async create(principal: Principal, workspaceId: string, command: CreateSketchCommand): Promise<Sketch> {
      const title = valid.text(command?.title, 'title', SKETCH_LIMITS.title);
      let target: SketchTarget;
      if (command.scope === 'project') {
        if (command.participantIds !== undefined) throw new InvalidInputError('participantIds apply to direct sketches only');
        target = { scope: 'project', workspaceId, projectId: valid.id(command.projectId, 'projectId') };
      } else if (command.scope === 'direct') {
        if (command.projectId !== undefined) throw new InvalidInputError('projectId applies to project sketches only');
        const others = command.participantIds ?? [];
        if (!Array.isArray(others) || others.length > 50 || others.some((value) => typeof value !== 'string' || !value || value.length > 200)) {
          throw new InvalidInputError('participantIds must be at most 50 account ids');
        }
        const people = new Set<string>(principal.kind === 'human' ? [principal.id, ...others] : others);
        target = { scope: 'direct', workspaceId, participantIds: [...people] };
      } else {
        throw new InvalidInputError('scope must be one of project, direct');
      }
      return uow.run(async (ports) => {
        await ports.access.requireCreate(principal, target);
        const record = await ports.sketches.insertSketch({
          id: randomUUID(), workspaceId, scope: target.scope, projectId: target.scope === 'project' ? target.projectId : null,
          title, createdBy: principal, participantIds: target.scope === 'direct' ? target.participantIds : [],
        });
        const participants = await ports.sketches.participants([record.id]);
        await ports.events.record(principal, workspaceId, 'sketch.created.v1', record.id, { scope: record.scope });
        return toSketch(record, participants.get(record.id) ?? [], 'write');
      });
    },

    async get(principal: Principal, sketchId: string): Promise<SketchDetail> {
      return uow.run(async (ports) => {
        const { sketch, access } = await authorized(ports, principal, 'sketch.read', sketchId);
        const [participants, thoughts, links] = await Promise.all([
          ports.sketches.participants([sketch.id]), ports.sketches.thoughts(sketch.id), ports.sketches.links(sketch.id),
        ]);
        return {
          ...toSketch(sketch, participants.get(sketch.id) ?? [], access),
          thoughts: await thoughtViews(ports, principal, sketch.workspaceId, thoughts),
          links: links.map(toLink),
        };
      });
    },

    async rename(principal: Principal, sketchId: string, command: UpdateSketchCommand): Promise<Sketch> {
      const title = valid.text(command?.title, 'title', SKETCH_LIMITS.title);
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const participants = await ports.sketches.participants([sketch.id]);
        const version = valid.expectedVersion(command.expectedVersion);
        if (sketch.version !== version) throw new VersionConflictError(sketch.version, toSketch(sketch, participants.get(sketch.id) ?? [], 'write'));
        const renamed = await ports.sketches.renameSketch(sketch.id, title);
        await ports.events.record(principal, sketch.workspaceId, 'sketch.changed.v1', sketch.id, { op: 'renamed' });
        return toSketch(renamed, participants.get(sketch.id) ?? [], 'write');
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
      return uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        if (placement) {
          const view = await ports.access.placement(principal, placement);
          if (!view.readable) throw new NotFoundError('Draft', 'DRAFT_NOT_FOUND');
          if (view.workspaceId !== sketch.workspaceId) throw new RuleViolationError('A placed object must belong to the sketch’s workspace', 'CROSS_WORKSPACE');
        }
        if (linkFrom) await lockedThought(ports, sketch.id, linkFrom.thoughtId);
        if (await ports.sketches.thoughtExists(thoughtId)) throw new ConflictError('A thought with this id already exists', 'THOUGHT_EXISTS');
        if (linkFrom && await ports.sketches.linkExists(linkFrom.linkId)) throw new ConflictError('A link with this id already exists', 'LINK_EXISTS');
        const thought = await ports.sketches.insertThought({ id: thoughtId, workspaceId: sketch.workspaceId, sketchId: sketch.id, ...values, placement, createdBy: principal });
        const link = linkFrom ? await ports.sketches.insertLink({
          id: linkFrom.linkId, workspaceId: sketch.workspaceId, sketchId: sketch.id, fromId: linkFrom.thoughtId, toId: thought.id, label: linkFrom.label, createdBy: principal,
        }) : null;
        const [view] = await thoughtViews(ports, principal, sketch.workspaceId, [thought]);
        await changed(ports, principal, sketch, { op: 'thought_added', thoughtIds: [thought.id], linkIds: link ? [link.id] : [] });
        return { thought: view!, link: link ? toLink(link) : null };
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
        const [currentView] = await thoughtViews(ports, principal, sketch.workspaceId, [current]);
        checkVersion(current, command.expectedVersion, currentView!);
        const updated = await ports.sketches.updateThought(sketch.id, current.id, changes);
        const [view] = await thoughtViews(ports, principal, sketch.workspaceId, [updated]);
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
          const views = await thoughtViews(ports, principal, sketch.workspaceId, stale.map((move) => locked.get(move.id)!));
          throw new PositionsConflictError(views.map((view) => ({ id: view.id, currentVersion: view.version, current: view })));
        }
        const updated: ThoughtRecord[] = [];
        for (const move of parsed) updated.push(await ports.sketches.updateThought(sketch.id, move.id, { x: move.x, y: move.y }));
        const thoughts = await thoughtViews(ports, principal, sketch.workspaceId, updated);
        await changed(ports, principal, sketch, { op: 'thoughts_moved', thoughtIds: parsed.map((move) => move.id), linkIds: [] });
        return { thoughts };
      });
    },

    async removeThought(principal: Principal, sketchId: string, thoughtId: string, expected: number | undefined): Promise<void> {
      await uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const current = await lockedThought(ports, sketch.id, valid.id(thoughtId, 'thoughtId'));
        const [currentView] = await thoughtViews(ports, principal, sketch.workspaceId, [current]);
        checkVersion(current, expected, currentView!);
        const linkIds = (await ports.sketches.links(sketch.id)).filter((link) => link.fromId === current.id || link.toId === current.id).map((link) => link.id);
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
        const link = await ports.sketches.insertLink({ id: linkId, workspaceId: sketch.workspaceId, sketchId: sketch.id, fromId, toId, label: text, createdBy: principal });
        await changed(ports, principal, sketch, { op: 'link_added', thoughtIds: [fromId, toId], linkIds: [link.id] });
        return toLink(link);
      });
    },

    async removeLink(principal: Principal, sketchId: string, linkId: string): Promise<void> {
      await uow.run(async (ports) => {
        const { sketch } = await authorized(ports, principal, 'sketch.write', sketchId);
        const id = valid.id(linkId, 'linkId');
        if (!await ports.sketches.deleteLink(sketch.id, id)) throw new NotFoundError('Link', 'LINK_NOT_FOUND');
        await changed(ports, principal, sketch, { op: 'link_removed', thoughtIds: [], linkIds: [id] });
      });
    },
  };
}

export type SketchUseCases = ReturnType<typeof createSketchUseCases>;
