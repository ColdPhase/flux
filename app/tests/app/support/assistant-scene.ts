import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  agentConnectionPath, personalRunTokenPath,
  type AgentMayDo, type AssistantChange, type Conversation, type Project, type Workspace,
} from '@flux/contracts';
import type { Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { personalRunUseCases } from '../../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './db.js';
import { apiUrl } from './http.js';
import { mcp } from './mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './people.js';
import { FakeConnections, FakeQueue } from './personal-runs.js';
import type { PiRuntime } from './pi-runtime.js';
import { waitFor } from './wait.js';

// The shared starting point of the assistant's change tests (F-027 A3/A4): an owner with an assistant in a project of a workspace, two other
// members, an assistant run that can be made "live" (token minted, MCP calls through the real `/mcp` route) and the helpers to make, read and
// end things. A fake clock, fake provider and fake CLI stand in for every vendor; nothing here calls one. A scene given a pi runtime
// (support/pi-runtime.ts) has a `processor`: the owner's API-key runs run in pi in it (#1441, RT-1), scripted through `pi.gateway`.

import { agentSettings } from './agent-settings.js';
export { agentSettings, type AgentSettingsView } from './agent-settings.js';
export const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export type Message = Record<string, unknown> | null;
export const result = (message: Message) => message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
export const text = (message: Message) => result(message)?.content?.[0]?.text ?? '';
export const DAY = 86_400_000;
/** Backends of the database that are waiting on a row lock right now. */
export const lockWaiters = async () => Number((await pool.query(
  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows[0].n);

export interface ChangeRow { id: string; state: string; wait_reason: string | null; authority: string | null; operation: string; object_id: string | null;
  receipt: Record<string, unknown> | null; refusal: string | null; decided_by: string | null; version: number; run_id: string; object_title: string;
  prepared_command: { tool: string; args: Record<string, unknown>; view?: string } | null }
export const changesOf = async (runId: string) =>
  (await pool.query(`SELECT * FROM assistant_changes WHERE run_id = $1 ORDER BY created_at, id`, [runId])).rows as ChangeRow[];

export async function assistantScene(label: string, options: { pi?: PiRuntime } = {}) {
  const connections = new FakeConnections();
  const queue = new FakeQueue();
  const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
  /** The worker with pi in the runtime, when the scene has one: the run's model (`pi.gateway`) calls the effect tools through the real `/mcp` route. */
  const processor = options.pi ? options.pi.processor(connections) : null;
  // The assistant's owner is a plain member who is the space's admin by grant, so their access can end (#903): a company owner or admin
  // reaches every space, and nothing takes it away. `lead` is the company's owner and the space's other admin.
  const lead = await person(`${label}-lead`);
  const owner = await person(`${label}-ada`);
  const peer = await person(`${label}-jonas`);
  const outsider = await person(`${label}-other`);
  const admin = await person(`${label}-admin`);
  const viewer = await person(`${label}-viewer`);
  const stranger = await person(`${label}-stranger`);
  const guest = await person(`${label}-guest`);
  const ws: Workspace = await createWorkspace(lead, `${label} workspace`);
  await addMember(lead, ws.id, owner, 'member');
  await addMember(lead, ws.id, peer, 'member');
  await addMember(lead, ws.id, outsider, 'member');
  await addMember(lead, ws.id, admin, 'admin');
  await addMember(lead, ws.id, viewer, 'member');
  await addMember(lead, ws.id, guest, 'guest');
  const place: Project = await createProject(lead, ws.id, 'Lamp sensor', 'restricted');
  await grant(lead, place.id, owner, 'manager');
  await grant(lead, place.id, peer, 'contributor');
  await grant(lead, place.id, outsider, 'contributor');
  await grant(lead, place.id, viewer, 'contributor');
  await grant(lead, place.id, guest, 'contributor');
  const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
    { body: { body: 'Please tidy the sensor tasks', clientMessageId: randomUUID() } }), 201) as Conversation;
  const connectionId = randomUUID();
  connections.connect(owner.id, connectionId);
  await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
  await options.pi?.place(owner.id);

  const settings = () => agentSettings(owner, ws.id);
  /** The assistant's own agent connection (the S6 policy and the run tokens belong to it). */
  const assistantConnectionId = async () => (await settings()).connectionId;
  /** Ask me first (F-036 AG-3), set by the owner in their own session. */
  async function setMayDo(mayDo: AgentMayDo) {
    expectStatus(await owner.browser.request('PATCH', agentConnectionPath(await assistantConnectionId()), { body: { mayDo } }), 200);
  }
  /** Back to the defaults every test starts from: Do it and tell me, nothing in flight. */
  async function reset() {
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    if ((await settings()).mayDo !== 'act') await setMayDo('act');
  }
  /** A run moved to `reading` (as the worker's claim does), with its token minted. */
  /** A run of the owner's assistant with a live token; `prompt` is what they asked (the addresses written in it are the ones an agent may read on the web). */
  async function liveRun(conversation: Conversation = thread, prompt = 'Tidy the project') {
    const started = await runs.invoke(human(owner), conversation.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
    return liveOf(started.run.id);
  }
  /** The same for a run that was started some other way (a task's, say): moved to `reading`, its token minted, its MCP calls through the real route. */
  async function liveOf(runId: string) {
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [runId]);
    const nonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(runId, sha256(nonce))), true);
    const response = await fetch(`${apiUrl}${personalRunTokenPath(runId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(response.status, 200);
    const minted = await response.json() as { token: string; tools: string[] };
    let id = 0;
    const call = (name: string, args: Record<string, unknown>) => mcp(minted.token, ++id, 'tools/call', { name, arguments: { clientCommandId: randomUUID(), ...args } });
    const raw = (method: string, params?: Record<string, unknown>) => mcp(minted.token, ++id, method, params);
    return { runId, token: minted.token, tools: minted.tools, call, raw };
  }
  /** The run ends normally, its token closed and expired: provenance only. */
  const complete = (runId: string) => pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'Done',
    cost_state = 'released', charged_micros = 0, run_token_closed_at = now(), run_token_expires_at = now() - interval '1 second' WHERE id = $1`, [runId]);
  const task = async (who: Person, title: string, projectId = place.id) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title } }), 201) as { id: string; number: number; version: number };
  const doc = async (who: Person, title: string, body = 'First text') =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title, body } }), 201) as { id: string; version: number };
  const docBody = async (id: string) => (await pool.query(`SELECT v.body, m.current_version FROM project_materials m JOIN project_material_versions v
    ON v.material_id = m.id AND v.version = m.current_version WHERE m.id = $1`, [id])).rows[0] as { body: string; current_version: number };
  const map = async (who: Person, title = 'Sensor map') => expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title, scope: 'project', projectId: place.id } }), 201) as { id: string; version: number };
  const patchWork = async (who: Person, id: string, version: number, body: Record<string, unknown>) =>
    expectStatus(await who.browser.request('PATCH', `/api/v1/work/${id}`, { body, headers: { 'if-match': `"${version}"` } }), 200) as { version: number };
  const taskRow = async (id: string) => (await pool.query(`SELECT title, outcome, status, blocker, waiting_for_user_id, criteria, version FROM project_work_items WHERE id = $1`, [id])).rows[0] as
    { title: string; outcome: string; status: string; blocker: string | null; waiting_for_user_id: string | null; criteria: string[]; version: number };
  const dependencies = async (id: string) => (await pool.query(`SELECT prerequisite_id FROM project_task_dependencies WHERE task_id = $1 ORDER BY prerequisite_id`, [id])).rows.map((row) => row.prerequisite_id as string);
  /**
   * A row lock held by this test, so that a request can be made to wait behind it at a chosen point and a rival write can win first.
   * `racing` starts the request, waits until it is really queued behind the lock, lets the rival commit inside the held transaction and
   * returns the request's answer; whatever fails, the held transaction is always ended, so one broken check cannot block the next test.
   */
  async function holding(sql: string, params: unknown[]) {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query(sql, params);
    const baseline = await lockWaiters();
    let ended = false;
    const api = {
      async release(rival?: (query: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown>) {
        if (ended) return;
        ended = true;
        try { if (rival) await rival((statement, values) => client.query(statement, values)); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      },
      async racing<T>(start: () => Promise<T>, rival?: (query: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown>): Promise<T> {
        const pending = start();
        try { await waitFor(async () => (await lockWaiters()) > baseline, 'a request waiting on the held lock'); }
        catch (error) { await api.release().catch(() => undefined); await pending.catch(() => undefined); throw error; }
        await api.release(rival);
        return pending;
      },
    };
    return api;
  }
  const listConversation = async (who: Person, conversation: Conversation = thread) =>
    (expectStatus(await who.browser.request('GET', `/api/v1/conversations/${conversation.id}/assistant-changes`), 200) as { items: AssistantChange[] }).items;

  return { connections, queue, runs, processor, assistantConnectionId, lead, owner, peer, outsider, admin, viewer, stranger, guest, ws, place, agentId, thread, connectionId, settings, setMayDo, reset,
    liveRun, liveOf, complete, task, doc, docBody, map, patchWork, taskRow, dependencies, holding, listConversation, changesOf };
}
export type AssistantScene = Awaited<ReturnType<typeof assistantScene>>;
