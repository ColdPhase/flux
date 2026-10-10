import type { AgentOperation } from './agent-execution.js';
import type { AgentScope } from './agent-proposals.js';

export const AGENT_MCP_READ_CAPABILITIES = [
  'project.identity.read', 'project.knowledge.read', 'project.work.read', 'project.decisions.read',
  'project.results.read', 'project.conversations.read', 'project.maps.read', 'project.policy.read',
  'cowork.playbook.read', 'connection.runtime.read',
] as const;
export type AgentMcpCapabilityId = typeof AGENT_MCP_READ_CAPABILITIES[number] | AgentOperation | 'proposal.create';
export interface AgentMcpEntry {
  id: string;
  kind: 'tool' | 'resource' | 'prompt';
  name: string;
  requiredScope: AgentScope;
  requiredCapabilities: readonly AgentMcpCapabilityId[];
  operation: AgentOperation | null;
}

const read = (name: string, ...capabilities: typeof AGENT_MCP_READ_CAPABILITIES[number][]): AgentMcpEntry => ({
  id: `tool:${name}`, kind: 'tool', name, requiredScope: 'flux.context.read', requiredCapabilities: capabilities, operation: null,
});
const effect = (name: string, operation: AgentOperation): AgentMcpEntry => ({
  id: `tool:${name}`, kind: 'tool', name, requiredScope: 'flux.action.execute', requiredCapabilities: [operation], operation,
});
const alias = (kind: 'resource' | 'prompt', name: string,
  ...capabilities: typeof AGENT_MCP_READ_CAPABILITIES[number][]): AgentMcpEntry => ({
  id: `${kind}:${name}`, kind, name, requiredScope: 'flux.context.read', requiredCapabilities: capabilities, operation: null,
});

/** Semantic aliases share a switch; exact entry membership is captured separately on consent. */
export const AGENT_MCP_ENTRIES: readonly AgentMcpEntry[] = [
  read('flux_list_contexts', 'project.identity.read'),
  read('flux_list_materials', 'project.knowledge.read'), read('flux_read_material', 'project.knowledge.read'),
  read('flux_list_docs', 'project.knowledge.read'), read('flux_get_doc', 'project.knowledge.read'),
  read('flux_list_work', 'project.work.read'), read('flux_get_work', 'project.work.read'),
  read('flux_list_decisions', 'project.decisions.read'), read('flux_get_decision', 'project.decisions.read'),
  read('flux_list_results', 'project.results.read'), read('flux_get_result', 'project.results.read'),
  read('flux_list_conversations', 'project.conversations.read'), read('flux_get_conversation', 'project.conversations.read'),
  read('flux_list_maps', 'project.maps.read'), read('flux_get_map', 'project.maps.read'),
  // Actual source-kind dependencies are added before any query/count/projection.
  read('flux_search_project', 'project.identity.read'), read('flux_project_orientation', 'project.identity.read'),
  read('flux_changes_since', 'project.identity.read'),
  read('flux_bootstrap', 'project.identity.read', 'connection.runtime.read', 'project.policy.read', 'cowork.playbook.read'),
  read('flux_acknowledge_playbook', 'cowork.playbook.read', 'connection.runtime.read'),
  effect('flux_create_task', 'work.create'), effect('flux_update_task', 'work.update'),
  effect('flux_undo_task_creation', 'work.creation.revert'),
  effect('flux_record_result', 'result.record'), effect('flux_propose_decision', 'decision.propose'),
  effect('flux_create_map', 'map.create'), effect('flux_rename_map', 'map.rename'),
  effect('flux_add_thought', 'map.thought.create'), effect('flux_update_thought', 'map.thought.update'),
  effect('flux_remove_thought', 'map.thought.delete'), effect('flux_move_thoughts', 'map.positions.update'),
  effect('flux_link_thoughts', 'map.link.create'), effect('flux_unlink_thoughts', 'map.link.delete'),
  effect('flux_create_doc', 'doc.create'), effect('flux_update_doc', 'doc.update'),
  effect('flux_start_conversation', 'conversation.create'), effect('flux_reply_in_conversation', 'conversation.reply'),
  effect('flux_create_unit', 'cowork.unit.create'), effect('flux_claim_unit', 'cowork.claim'),
  effect('flux_renew_unit', 'cowork.renew'), effect('flux_release_unit', 'cowork.release'),
  effect('flux_complete_unit', 'cowork.unit.complete'), effect('flux_transfer_unit', 'cowork.unit.transfer'),
  effect('flux_claim_request', 'cowork.request.claim'), effect('flux_decline_request', 'cowork.request.respond'),
  { id: 'tool:flux_create_proposal', kind: 'tool', name: 'flux_create_proposal', requiredScope: 'flux.proposal.write',
    requiredCapabilities: ['proposal.create'], operation: null },
  alias('resource', 'flux_cowork_playbook', 'cowork.playbook.read'),
  alias('resource', 'flux_project_policy', 'project.policy.read'),
  alias('prompt', 'start_work', 'cowork.playbook.read', 'project.identity.read'),
  alias('prompt', 'resume_work', 'cowork.playbook.read', 'project.identity.read'),
];

export interface AgentMcpPolicy {
  connectionId: string;
  version: number;
  enabledCapabilityIds: AgentMcpCapabilityId[];
  /** Explicit consent to these registered entries; a new alias never inherits an old On group. */
  enabledEntryIds: string[];
  selectedProjectIds: string[];
}
export interface SaveAgentMcpPolicy {
  enabledCapabilityIds: AgentMcpCapabilityId[];
  enabledEntryIds: string[];
  selectedProjectIds: string[];
}
export const agentMcpPolicyPath = (connectionId: string) => `/api/v1/agent-connections/${connectionId}/permissions`;

export const AGENT_MCP_SOURCE_CAPABILITIES: Readonly<Record<string, typeof AGENT_MCP_READ_CAPABILITIES[number]>> = {
  material: 'project.knowledge.read', doc: 'project.knowledge.read', work: 'project.work.read',
  decision: 'project.decisions.read', result: 'project.results.read', conversation: 'project.conversations.read',
  message: 'project.conversations.read', map: 'project.maps.read', sketch: 'project.maps.read',
};
