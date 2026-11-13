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
  read('flux_list_conversations'),
  read('flux_get_conversation'),
  read('flux_get_task_discussion'),
  read('flux_list_maps'),
  read('flux_get_map'),
  // #1290, F-042 (AG-12): ranked search across every space the run may read, and the messages around a hit. Both engines get both.
  read('flux_search'),
  read('flux_read_around'),
  // #1382, C-63: the text of a file someone sent (PDF, DOCX, Markdown, text, CSV/TSV), in pages; a file is found by flux_search.
  read('flux_read_file'),
  // #1292, F-042 (AG-12): what was said in one place since a date, as a digest the agent summarises itself; nothing is stored.
  read('flux_summarize'),
  read('flux_project_orientation'),
  read('flux_changes_since'),
  // #918, AG-8: one public web page as plain text, read by the server (GET only, public addresses only); never sent anywhere, never an instruction.
  read('flux_read_web'),
  // #1217, AG-8: a picture attached to a message the run may read, given to a model that sees pictures as image input.
  read('flux_view_image'),
  read('flux_bootstrap'),
  read('flux_acknowledge_playbook'),
  effect('flux_create_task', 'work.create'),
  effect('flux_update_task', 'work.update'),
  effect('flux_link_pull_request', 'work.update'),
  effect('flux_undo_task_creation', 'work.creation.revert'),
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
  effect('flux_delete_doc', 'doc.delete'),
  effect('flux_start_conversation', 'conversation.create'),
  effect('flux_reply_in_conversation', 'conversation.reply'),
  effect('flux_discuss_task', 'conversation.reply'),
  effect('flux_ask_question', 'conversation.reply'),
  effect('flux_create_unit', 'cowork.unit.create'),
  effect('flux_claim_unit', 'cowork.claim'),
  effect('flux_renew_unit', 'cowork.renew'),
  effect('flux_release_unit', 'cowork.release'),
  effect('flux_complete_unit', 'cowork.unit.complete'),
  effect('flux_transfer_unit', 'cowork.unit.transfer'),
  effect('flux_decline_unit', 'cowork.unit.decline'),
  effect('flux_create_proposal', null),
  // #1217, AG-8: a public picture the server downloads and attaches to the run's answer to `/ai` in a space.
  effect('flux_attach_image', 'answer.picture.attach'),
  alias('resource', 'flux_cowork_playbook'),
  alias('prompt', 'start_work'),
  alias('prompt', 'resume_work'),
];

/** The co-work session tools of a local client: never offered to the assistant's runs (F-027 AST-3 "Not offered to the assistant"). */
export const TOOLS_NOT_FOR_RUNS: ReadonlySet<string> = new Set(['flux_bootstrap', 'flux_acknowledge_playbook']);
