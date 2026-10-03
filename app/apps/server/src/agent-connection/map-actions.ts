import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, SKETCH_LIMITS, THOUGHT_SHAPES, type AgentJsonValue, type AgentOperation,
  type CreateThoughtCommand, type MoveThoughtsCommand, type ThoughtShape, type UpdateThoughtCommand } from '@flux/contracts';
import type { Database } from '@flux/core';
import { actionAnnotations as annotations, actionId as id, actionInput, actionVersion as version, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const execution = actionInput(['execute', 'plan']);
const coordinate = z.number().min(-SKETCH_LIMITS.coordinate).max(SKETCH_LIMITS.coordinate);
const shape = z.enum(THOUGHT_SHAPES as unknown as [ThoughtShape, ...ThoughtShape[]]);
const mapId = id.describe('A project map of this project; private and direct-message maps are never targets.');
const thought = { text: z.string().min(1).max(SKETCH_LIMITS.text), x: coordinate, y: coordinate,
  width: z.number().min(SKETCH_LIMITS.minWidth).max(SKETCH_LIMITS.maxWidth).optional(),
  height: z.number().min(SKETCH_LIMITS.minHeight).max(SKETCH_LIMITS.maxHeight).optional(), shape: shape.optional() };

/**
 * Standing-grant changes to a project's shared maps through the canonical sketch commands, in the same
 * one-transaction executor as the work actions. The command target is always the map; a change's
 * produced post-state is the changed thought(s) and the map checkpoint, so a retry after any later map
 * change is visibly stale instead of replaying over it.
 */
export function registerAgentMapActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);
  const grantNote = 'Needs a live standing grant for this operation (for this map or the whole project) and the runtime from flux_bootstrap.';

  register('map.create').registerTool('flux_create_map', {
    title: 'Create a project map under a standing grant',
    description: `Create one shared map in the project, visible to the project's people. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, title: z.string().min(1).max(SKETCH_LIMITS.title) }), annotations,
  }, ({ title, ...input }) => run(() => execute(input, 'map.create', null, { title }, async ({ maps, agent, runtime }) => {
    const map = await maps.create(agent, runtime.workspaceId, { title, scope: 'project', projectId: input.projectId });
    return { value: { mapId: map.id, version: map.version }, postconditions: [{ kind: 'map', id: map.id, version: map.version }] };
  })));

  register('map.rename').registerTool('flux_rename_map', {
    title: 'Rename a project map under a standing grant',
    description: `Rename one project map at the version you last read. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, expectedVersion: version, title: z.string().min(1).max(SKETCH_LIMITS.title) }), annotations,
  }, ({ mapId: target, expectedVersion, title, ...input }) => run(() => execute(input, 'map.rename', target, { expectedVersion, title },
    async ({ maps, agent }) => {
      const map = await maps.rename(agent, target, { title, expectedVersion });
      return { value: { mapId: map.id, version: map.version }, postconditions: [{ kind: 'map', id: map.id, version: map.version }] };
    })));

  register('map.thought.create').registerTool('flux_add_thought', {
    title: 'Add a thought to a project map under a standing grant',
    description: `Add one thought at a position on a project map, optionally linked from an existing thought. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, thought: z.strictObject({ ...thought,
      linkFrom: z.strictObject({ thoughtId: id, label: z.string().max(SKETCH_LIMITS.label).optional() }).optional() }) }), annotations,
  }, ({ mapId: target, thought: added, ...input }) => run(() => execute(input, 'map.thought.create', target, added as unknown as AgentJsonValue,
    async ({ maps, agent, mapCheckpoint }) => {
      const command: CreateThoughtCommand = { ...added, ...(added.linkFrom ? { linkFrom: { thoughtId: added.linkFrom.thoughtId,
        ...(added.linkFrom.label !== undefined ? { label: added.linkFrom.label } : {}) } } : {}) };
      const created = await maps.addThought(agent, target, command);
      return { value: { thoughtId: created.thought.id, version: created.thought.version, linkId: created.link?.id ?? null },
        postconditions: [{ kind: 'thought', id: created.thought.id, version: created.thought.version }, await mapCheckpoint(target)] };
    })));

  register('map.thought.update').registerTool('flux_update_thought', {
    title: 'Change a thought on a project map under a standing grant',
    description: `Change one thought's text, position, size or shape at the version you last read. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, thoughtId: id, expectedVersion: version,
      changes: z.strictObject({ text: thought.text.optional(), x: coordinate.optional(), y: coordinate.optional(),
        width: thought.width, height: thought.height, shape: thought.shape }) }), annotations,
  }, ({ mapId: target, thoughtId, expectedVersion, changes, ...input }) => run(() => execute(input, 'map.thought.update', target,
    { thoughtId, expectedVersion, changes } as unknown as AgentJsonValue, async ({ maps, agent, mapCheckpoint }) => {
      const command: UpdateThoughtCommand = { ...changes, expectedVersion };
      const updated = await maps.updateThought(agent, target, thoughtId, command);
      return { value: { thoughtId: updated.id, version: updated.version },
        postconditions: [{ kind: 'thought', id: updated.id, version: updated.version }, await mapCheckpoint(target)] };
    })));

  register('map.thought.delete').registerTool('flux_remove_thought', {
    title: 'Remove a thought from a project map under a standing grant',
    description: `Remove one thought and its links at the version you last read. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, thoughtId: id, expectedVersion: version }),
    annotations: { ...annotations, destructiveHint: true },
  }, ({ mapId: target, thoughtId, expectedVersion, ...input }) => run(() => execute(input, 'map.thought.delete', target,
    { thoughtId, expectedVersion }, async ({ maps, agent, mapCheckpoint }) => {
      await maps.removeThought(agent, target, thoughtId, expectedVersion);
      return { value: { thoughtId }, postconditions: [await mapCheckpoint(target)] };
    })));

  register('map.positions.update').registerTool('flux_move_thoughts', {
    title: 'Move thoughts on a project map under a standing grant',
    description: `Move up to ${SKETCH_LIMITS.moves} thoughts, each at the version you last read; any stale one moves none. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId,
      moves: z.array(z.strictObject({ id, x: coordinate, y: coordinate, expectedVersion: version })).min(1).max(SKETCH_LIMITS.moves) }), annotations,
  }, ({ mapId: target, moves, ...input }) => run(() => execute(input, 'map.positions.update', target, { moves } as unknown as AgentJsonValue,
    async ({ maps, agent, mapCheckpoint }) => {
      const command: MoveThoughtsCommand = { moves };
      const moved = await maps.moveThoughts(agent, target, command);
      return { value: { thoughts: moved.thoughts.map((item) => ({ id: item.id, version: item.version })) },
        postconditions: [...moved.thoughts.map((item) => ({ kind: 'thought' as const, id: item.id, version: item.version })), await mapCheckpoint(target)] };
    })));

  register('map.link.create').registerTool('flux_link_thoughts', {
    title: 'Link two thoughts on a project map under a standing grant',
    description: `Connect two thoughts of the same project map, with an optional label. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, fromId: id, toId: id, label: z.string().max(SKETCH_LIMITS.label).optional() }), annotations,
  }, ({ mapId: target, fromId, toId, label, ...input }) => run(() => execute(input, 'map.link.create', target,
    { fromId, toId, ...(label !== undefined ? { label } : {}) } as AgentJsonValue, async ({ maps, agent, mapCheckpoint }) => {
      const link = await maps.addLink(agent, target, { fromId, toId, ...(label !== undefined ? { label } : {}) });
      return { value: { linkId: link.id }, postconditions: [await mapCheckpoint(target)] };
    })));

  register('map.link.delete').registerTool('flux_unlink_thoughts', {
    title: 'Remove a link between thoughts under a standing grant',
    description: `Remove one link between two thoughts of a project map. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, mapId, linkId: id }), annotations: { ...annotations, destructiveHint: true },
  }, ({ mapId: target, linkId, ...input }) => run(() => execute(input, 'map.link.delete', target, { linkId },
    async ({ maps, agent, mapCheckpoint }) => {
      await maps.removeLink(agent, target, linkId);
      return { value: { linkId }, postconditions: [await mapCheckpoint(target)] };
    })));
}
