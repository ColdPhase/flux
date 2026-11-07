import type { AgentOperation } from '@flux/contracts';

const MAP_CHANGES: readonly AgentOperation[] = ['map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete',
  'map.positions.update', 'map.link.create', 'map.link.delete'];
/**
 * The kind of the exact project object a change targets, or null for a create. Command targets name native containers: the
 * task, the project map (also for thought/link commands), the doc, or the project conversation a reply joins. Private and
 * direct-message objects are never project objects.
 */
export function agentOperationTarget(operation: AgentOperation): 'work' | 'sketch' | 'doc' | 'conversation' | null {
  // #153: a unit is created for an exact native task of this project. #238: an agent undoes its own unused task.
  if (operation === 'work.update' || operation === 'cowork.unit.create' || operation === 'work.creation.revert') return 'work';
  if (operation === 'doc.update') return 'doc';
  if (operation === 'conversation.reply') return 'conversation';
  return MAP_CHANGES.includes(operation) ? 'sketch' : null;
}
