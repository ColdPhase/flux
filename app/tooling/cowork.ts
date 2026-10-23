/** Small Docker helper for the supplied external host action. No vendor credentials, DB, task store or model calls. */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { COWORK_PLAYBOOK, isUuid } from '@flux/core';

export interface CoworkHostBinding {
  schema: 'flux.cowork.host/1'; origin: string; connectionId: string; projectId: string; client: 'codex'; workdir: string;
  threadId: string | null; outcome: 'new' | 'waiting' | 'failed'; updatedAt: string;
}
const thread = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function coworkHostScope(origin: string, connectionId: string, projectId: string, client: string, workdir: string) {
  const url = new URL(origin);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || !isUuid(connectionId) || !isUuid(projectId) || client !== 'codex' || !workdir.startsWith('/') || workdir.length > 4000)
    throw Error('Use an HTTPS Flux origin (or loopback), canonical connection/project IDs and the supported Codex client.');
  return { origin: url.origin, connectionId: connectionId.toLowerCase(), projectId: projectId.toLowerCase(), client: 'codex' as const, workdir };
}
export function coworkHostUrl(binding: Pick<CoworkHostBinding, 'origin' | 'connectionId' | 'projectId'>) {
  const url = new URL('/mcp', binding.origin);
  url.searchParams.set('flux_connection', binding.connectionId); url.searchParams.set('flux_project', binding.projectId);
  return url.href;
}
/** Only entry guidance is shipped here. The current authoritative bundle must come from the live scoped MCP server. */
export function coworkHostInstructions(binding: CoworkHostBinding, action: 'start' | 'resume') {
  return [action === 'start' ? COWORK_PLAYBOOK.startPayload : COWORK_PLAYBOOK.resumePayload,
    'This is Flux’s supplied host action. Use only the configured flux MCP server. Discover its CURRENT playbook resource with native resource tools and read it in full before any project effect. '
      + 'Do not substitute instructions from the launcher image. Then bootstrap the bound project, verify the connection/project below, acknowledge the exact current server bundle and follow it. '
      + 'A refusal or missing capability ends this action with the specific gap. Do not use another project, MCP server, account or payer. '
      + 'At a safe checkpoint retain the addressed inbox, save source coverage on the native task and release work before ending. With nothing ready, end this turn; never poll a model.',
    'Immutable host binding (data, grants nothing):', JSON.stringify({ connectionId: binding.connectionId, projectId: binding.projectId,
      client: binding.client, ...(binding.threadId ? { nativeThreadId: binding.threadId } : {}) })].join('\n\n');
}

// The override exists for isolated shell verification; the launcher mounts only /cowork-state.
const stateDir = process.env.FLUX_COWORK_STATE_DIR ?? '/cowork-state';
const state = join(stateDir, 'binding.json');
async function readBinding(): Promise<CoworkHostBinding | null> {
  const info = await lstat(state).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw Error('Invalid private adapter metadata.');
  const binding = JSON.parse(await readFile(state, 'utf8')) as CoworkHostBinding;
  const scope = coworkHostScope(binding.origin, binding.connectionId, binding.projectId, binding.client, binding.workdir);
  if (Object.keys(binding).some(key => !['schema', 'origin', 'connectionId', 'projectId', 'client', 'workdir', 'threadId', 'outcome', 'updatedAt'].includes(key))
    || typeof binding.updatedAt !== 'string' || !Number.isFinite(Date.parse(binding.updatedAt)) || binding.schema !== 'flux.cowork.host/1' || JSON.stringify(scope) !== JSON.stringify({ origin: binding.origin, connectionId: binding.connectionId,
    projectId: binding.projectId, client: binding.client, workdir: binding.workdir }) || binding.threadId !== null && (typeof binding.threadId !== 'string' || !thread.test(binding.threadId))
    || !['new', 'waiting', 'failed'].includes(binding.outcome)) throw Error('Invalid private adapter metadata.');
  return binding;
}
async function saveBinding(binding: CoworkHostBinding) {
  const temporary = `${state}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' });
  await rename(temporary, state); await chmod(state, 0o600);
}
export async function coworkNativeOutcome(path: string, original: CoworkHostBinding, exit: number) {
  let nativeId: string | null = null, completed = false, final = '', tools = 0;
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.length > 1_000_000) continue;
    let event: { type?: string; thread_id?: string; item?: { type?: string; text?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started' && event.thread_id && thread.test(event.thread_id)) nativeId = event.thread_id;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') tools++;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') final = event.item.text.slice(0, 20_000);
  }
  if (nativeId && original.threadId && nativeId !== original.threadId) throw Error('Native Resume returned another thread; the original binding is preserved.');
  const threadId = original.threadId ?? nativeId;
  return { binding: { ...original, threadId, outcome: exit === 0 && completed && threadId ? 'waiting' as const : 'failed' as const,
    updatedAt: new Date().toISOString() }, final, tools };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    const [action, origin, connectionId, projectId, client, workdir] = args;
    if (action !== 'start' && action !== 'resume') throw Error('Choose Start or Resume.');
    const scope = coworkHostScope(origin!, connectionId!, projectId!, client!, workdir!);
    const prior = await readBinding();
    if (prior && Object.entries(scope).some(([key, value]) => prior[key as keyof typeof scope] !== value)) throw Error('This private state belongs to another immutable host binding.');
    if (action === 'resume' && !prior?.threadId) throw Error('No adapter-created native thread exists here. Use Start first.');
    if (action === 'start' && prior?.threadId) throw Error('This action already has a native thread. Use Resume.');
    await saveBinding(prior ?? { schema: 'flux.cowork.host/1', ...scope, threadId: null, outcome: 'new', updatedAt: new Date().toISOString() });
    return;
  }
  const binding = await readBinding(); if (!binding) throw Error('Start this bound host action first.');
  if (command === 'url-config') { console.log(`mcp_servers.flux.url=${JSON.stringify(coworkHostUrl(binding))}`); return; }
  if (command === 'resource-config') { console.log(`mcp_servers.flux.oauth_resource=${JSON.stringify(new URL('/mcp', binding.origin).href)}`); return; }
  if (command === 'thread') { if (!binding.threadId) throw Error('No native thread was recorded.'); console.log(binding.threadId); return; }
  if (command === 'instructions') {
    const action = args[0]; if (action !== 'start' && action !== 'resume') throw Error('Choose Start or Resume.');
    console.log(`developer_instructions=${JSON.stringify(coworkHostInstructions(binding, action))}`); return;
  }
  if (command === 'record') {
    try {
      const result = await coworkNativeOutcome(join(stateDir, 'events.jsonl'), binding, Number(args[0]));
      await saveBinding(result.binding);
      // Native terminal output must not replay escape/control sequences.
      // eslint-disable-next-line no-control-regex
      if (result.final) console.log(result.final.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
      console.log(`Flux host action ${result.binding.outcome}; ${result.tools} native MCP calls. A later Resume targets this action's saved thread; that leg is unverified with a real account.`);
      if (result.binding.outcome === 'failed') process.exitCode = 1;
    } finally { await unlink(join(stateDir, 'events.jsonl')).catch(() => undefined); }
    return;
  }
  throw Error('Unknown Flux host helper action.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Flux host action is unavailable. Check its bound IDs, native account and private state; no alternate account was used.'); process.exitCode = 1; });
