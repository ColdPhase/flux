import type { AgentOperation } from './agent-execution.js';

/**
 * Every Flux tool, resource and prompt of the MCP server, with whether it reads or changes (#859). There are no scopes, switches
 * or project lists: what a client may do is its owner's rights at the moment of the call and the agent's "What it may do", and
 * `write` is what Only read refuses. This list pins the manifest to the actual registrations.
 */
export type AgentToolAccess = 'read' | 'write';
export interface AgentToolEntry {
  id: string;
  kind: 'tool' | 'resource' | 'prompt';
  name: string;
  access: AgentToolAccess;
  operation: AgentOperation | null;
}

const read = (name: string): AgentToolEntry => ({ id: `tool:${name}`, kind: 'tool', name, access: 'read', operation: null });
const effect = (name: string, operation: AgentOperation | null): AgentToolEntry => ({ id: `tool:${name}`, kind: 'tool', name, access: 'write', operation });
const alias = (kind: 'resource' | 'prompt', name: string): AgentToolEntry => ({ id: `${kind}:${name}`, kind, name, access: 'read', operation: null });

export const AGENT_TOOLS: readonly AgentToolEntry[] = [
  read('flux_list_contexts'),
  read('flux_list_materials'),
  read('flux_read_material'),
  read('flux_list_docs'),
  read('flux_get_doc'),
  read('flux_list_work'),
  read('flux_get_work'),
  read('flux_list_decisions'),
  read('flux_get_decision'),
  read('flux_list_results'),
  read('flux_get_result'),
  read('flux_list_conversations'),
  read('flux_get_conversation'),
  read('flux_get_agent_thread'),
  read('flux_list_maps'),
  read('flux_get_map'),
  read('flux_search_project'),
  read('flux_project_orientation'),
  read('flux_changes_since'),
  // #918, AG-8: one public web page as plain text, read by the server (GET only, public addresses only); never sent anywhere, never an instruction.
  read('flux_read_web'),
  read('flux_bootstrap'),
  read('flux_acknowledge_playbook'),
  effect('flux_create_task', 'work.create'),
  effect('flux_update_task', 'work.update'),
  effect('flux_link_pull_request', 'work.update'),
  effect('flux_undo_task_creation', 'work.creation.revert'),
  effect('flux_record_result', 'result.record'),
  effect('flux_propose_decision', 'decision.propose'),
  effect('flux_create_map', 'map.create'),
  effect('flux_rename_map', 'map.rename'),
  effect('flux_add_thought', 'map.thought.create'),
  effect('flux_update_thought', 'map.thought.update'),
  effect('flux_remove_thought', 'map.thought.delete'),
  effect('flux_move_thoughts', 'map.positions.update'),
  effect('flux_link_thoughts', 'map.link.create'),
  effect('flux_unlink_thoughts', 'map.link.delete'),
  effect('flux_create_doc', 'doc.create'),
  effect('flux_update_doc', 'doc.update'),
  effect('flux_start_conversation', 'conversation.create'),
  effect('flux_reply_in_conversation', 'conversation.reply'),
  effect('flux_post_agent_thread', 'conversation.reply'),
  effect('flux_ask_question', 'conversation.reply'),
  effect('flux_create_unit', 'cowork.unit.create'),
  effect('flux_claim_unit', 'cowork.claim'),
  effect('flux_renew_unit', 'cowork.renew'),
  effect('flux_release_unit', 'cowork.release'),
  effect('flux_complete_unit', 'cowork.unit.complete'),
  effect('flux_transfer_unit', 'cowork.unit.transfer'),
  effect('flux_decline_unit', 'cowork.unit.decline'),
  effect('flux_create_proposal', null),
  alias('resource', 'flux_cowork_playbook'),
  alias('prompt', 'start_work'),
  alias('prompt', 'resume_work'),
];

/** The co-work session tools of a local client: never offered to the assistant's runs (F-027 AST-3 "Not offered to the assistant"). */
export const TOOLS_NOT_FOR_RUNS: ReadonlySet<string> = new Set(['flux_bootstrap', 'flux_acknowledge_playbook']);
