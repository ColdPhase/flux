/* global fetch, process, console, URL, setTimeout */
// Request measurement for scripts/check_performance.sh (#298). Runs with plain Node inside the API
// container, fed on stdin, after scripts/perf-seed.mjs. It signs in as seeded people and issues
// the HTTP requests the web app makes when it opens each view, in the app's own order and
// grouping (requests the app sends together are sent together). Server time is not measured
// here: the API's own request log records it (Fastify `responseTime`), and scripts/perf_report.py
// joins those lines with the windows printed below.
//
// FLUX_PERF_MODE:
//   prepare     sign in (two people) and read the ids the views need; prints a `state` line
//   plan        print the view plan only
//   count       per distinct request: reset pg_stat_statements, send it once, print the
//               statements it ran (needs the compose.perf.yaml overlay and DATABASE_URL)
//   pass        open every view once (one cold pass after a restart; FLUX_PERF_FIRST rotates
//               which view goes first)
//   warm        open every view FLUX_PERF_RUNS times (default 20)
//   concurrent  the warm loop by FLUX_PERF_CLIENTS people at once (default 2, never more)
//   once        every view once per prepared person (for auto_explain and the CPU profile)
// FLUX_PERF_PERSON picks who runs count, pass and warm: 0 the owner, 1 a member.
// Output: JSON lines (`state`, `plan`, `window`, `count`, `client`) on stdout. Every mode but
// prepare and plan reads the prepared state from FLUX_PERF_STATE.

import { createRequire } from 'node:module';

const api = process.env.FLUX_PERF_API ?? 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const password = process.env.FLUX_PERF_PASSWORD;
const mode = process.env.FLUX_PERF_MODE ?? 'plan';
const runs = Number(process.env.FLUX_PERF_RUNS ?? 20);
const clients = Math.min(2, Number(process.env.FLUX_PERF_CLIENTS ?? 2));
const WORKSPACE_NAME = 'Perf volume (#298)';
const MAIN_PROJECT = 'Community garden sensors';
const SEARCH_TERM = 'LoRa';
const emails = ['ada@perf.flux.test', 'jonas@perf.flux.test', 'maya@perf.flux.test'];

function fail(message) {
  console.error(`perf-measure: ${message}`);
  process.exit(1);
}
if (!origin || !password) fail('FLUX_PUBLIC_ORIGIN and FLUX_PERF_PASSWORD are required');
const emit = (row) => console.log(JSON.stringify(row));

class Session {
  cookies = new Map();

  async request(method, path, body) {
    const headers = { origin, accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const started = performance.now();
    const response = await fetch(new URL(path, api), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1).trim();
      if (value) this.cookies.set(pair.slice(0, index).trim(), value); else this.cookies.delete(pair.slice(0, index).trim());
    }
    const buffer = await response.arrayBuffer();
    const ms = performance.now() - started;
    let json = null;
    try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { json = null; }
    // Bytes on the wire: the compressed length when the server compressed the answer.
    const wire = Number(response.headers.get('content-length') ?? 0) || buffer.byteLength;
    return { status: response.status, json, ms, bytes: wire, encoding: response.headers.get('content-encoding') };
  }

  async expect(method, path, body) {
    const response = await this.request(method, path, body);
    if (response.status >= 400) fail(`${method} ${path} answered ${response.status}`);
    return response.json;
  }
}

async function signIn(email) {
  const session = new Session();
  const response = await session.request('POST', '/api/auth/sign-in/email', { email, password });
  if (response.status !== 200) fail(`sign-in ${email} answered ${response.status}`);
  return session;
}

const query = (fields) => new URLSearchParams(fields).toString();
/** The web app's bounded reference sets: distinct, sorted, at most 100 (apps/web/src/work/read-api.ts). */
const chunks = (values) => {
  const sorted = [...new Set(values)].sort();
  const out = [];
  for (let start = 0; start < sorted.length; start += 100) out.push(sorted.slice(start, start + 100).join(','));
  return out;
};

/** Ids the views need, read through the API the way the app reads them. */
async function discover(session) {
  const workspace = (await session.expect('GET', '/api/v1/workspaces')).find((ws) => ws.name === WORKSPACE_NAME);
  if (!workspace) fail(`Workspace "${WORKSPACE_NAME}" is missing; run scripts/perf-seed.mjs first`);
  const ws = workspace.id;
  const projects = await session.expect('GET', `/api/v1/workspaces/${ws}/projects?limit=100&offset=0`);
  const project = projects.items.find((item) => item.name === MAIN_PROJECT);
  const p = project.id;
  const roots = await session.expect('GET', `/api/v1/projects/${p}/conversation-roots`);
  const notices = await session.expect('GET', `/api/v1/projects/${p}/task-notices?limit=100&offset=0`);
  const groups = {};
  for (const group of ['open', 'in_progress', 'blocked', 'finished']) {
    groups[group] = await session.expect('GET', `/api/v1/projects/${p}/work-view?${query({ purpose: 'tasks', group, mine: false, limit: 50 })}`);
  }
  const sketches = await session.expect('GET', `/api/v1/workspaces/${ws}/sketches?limit=50&offset=0&projectId=${p}`);
  const sketchId = sketches.items[0].id;
  const sketch = await session.expect('GET', `/api/v1/sketches/${sketchId}`);
  const docs = await session.expect('GET', `/api/v1/projects/${p}/docs?limit=100&offset=0`);
  const taskIds = Object.values(groups).flatMap((page) => (page.items ?? page.rows ?? []).map((row) => row.id ?? row.work?.id)).filter(Boolean);
  return {
    workspaceId: ws, projectId: p, sketchId, docId: docs.items[0].id,
    conversationId: roots.roots.at(-1).conversationId,
    rootMessageIds: roots.roots.map((root) => root.message.id),
    noticeRefs: [...notices.items.map((notice) => `work:${notice.workId}`), ...roots.roots.flatMap((root) => root.task ? [`work:${root.task.workId}`] : [])],
    taskRefs: taskIds.map((id) => `work:${id}`),
    thoughtIds: (sketch.thoughts ?? []).map((thought) => thought.id),
  };
}

const get = (label, path) => ({ label, method: 'GET', path });

/**
 * The views and their requests (#298), from the web app's own loaders and effects (apps/web/src:
 * app/data.ts, project/data.ts, app/ProjectConversation.tsx, work/ProjectTasks.tsx and TaskBoard.tsx,
 * sketch/, docs/Wiki.tsx and DocViews.tsx, notifications/, search/). Each inner array is one group
 * the app sends at the same time; groups run one after another, as the app's waterfalls do.
 * Cold loads run the shell loader beside the view's own; it is listed once per view here.
 */
function viewPlan(ids) {
  const { workspaceId: ws, projectId: p } = ids;
  const shell = [
    [get('me', '/api/v1/me')],
    [get('workspaces', '/api/v1/workspaces')],
    [get('projects', `/api/v1/workspaces/${ws}/projects?limit=100&offset=0`)],
    [get('dms', `/api/v1/workspaces/${ws}/dms?limit=100&offset=0`)],
    [get('inbox dot', '/api/v1/inbox?limit=1'), get('live capabilities', '/api/v1/live-sessions/capabilities')],
  ];
  const projectShell = [
    [get('project', `/api/v1/projects/${p}`)],
    [get('project people', `/api/v1/projects/${p}/people`),
      get('project sketches', `/api/v1/workspaces/${ws}/sketches?limit=20&offset=0&projectId=${p}`),
      get('project docs', `/api/v1/projects/${p}/docs?limit=100&offset=0`)],
    [get('work summary', `/api/v1/projects/${p}/work-summary`),
      get('needs you', `/api/v1/return?${query({ place: 'project', id: p, scope: 'all', from: 'last-visit' })}`)],
  ];
  const [associations] = chunks(ids.rootMessageIds);
  const [references] = chunks(ids.noticeRefs);
  const relations = chunks(ids.taskRefs);
  const thoughts = chunks(ids.thoughtIds);
  return [
    { view: 'Home', groups: [...shell,
      [get('since you left', '/api/v1/return?place=home'), get('assistant', '/api/v1/personal-assistant'),
        get('drafts', `/api/v1/workspaces/${ws}/drafts?limit=100&offset=0`)]] },
    { view: 'Conversation', groups: [...shell, ...projectShell,
      [get('conversation roots', `/api/v1/projects/${p}/conversation-roots`),
        get('task notices', `/api/v1/projects/${p}/task-notices?limit=100&offset=0`),
        get('materials', `/api/v1/projects/${p}/materials?limit=100&offset=0`),
        get('members', `/api/v1/workspaces/${ws}/members`)],
      [get('assistant', '/api/v1/personal-assistant'), get('assistant runs', '/api/v1/assistant-runs?limit=10'),
        get('root work associations', `/api/v1/projects/${p}/work-associations?${query({ relation: 'source', limit: 50, messageIds: associations })}`),
        get('notice reference rows', `/api/v1/projects/${p}/work-reference-rows?${query({ objects: references })}`)]] },
    { view: 'Conversation thread', groups: [
      [get('thread', `/api/v1/conversations/${ids.conversationId}`)],
      [get('assistant answers', `/api/v1/conversations/${ids.conversationId}/assistant-answers?limit=100&offset=0`),
        get('assistant proposals', `/api/v1/projects/${p}/assistant-proposals?limit=100`)]] },
    { view: 'Tasks', groups: [...shell, ...projectShell.slice(0, 2),
      [get('comparison outcomes', `/api/v1/projects/${p}/proactive-comparison-outcomes?limit=100&offset=0`)],
      ['open', 'in_progress', 'blocked', 'finished'].map((group) =>
        get(`work view ${group}`, `/api/v1/projects/${p}/work-view?${query({ purpose: 'tasks', group, mine: false, limit: 50 })}`)),
      relations.map((objects, index) => get(`work relations ${index + 1}`, `/api/v1/projects/${p}/work-relations?${query({ objects, role: 'source', limit: 100 })}`))] },
    { view: 'Map', groups: [...shell, ...projectShell,
      [get('sketch list', `/api/v1/workspaces/${ws}/sketches?limit=50&offset=0&projectId=${p}`)],
      [get('sketch', `/api/v1/sketches/${ids.sketchId}`)],
      thoughts.map((thoughtIds, index) => get(`thought tasks ${index + 1}`, `/api/v1/projects/${p}/work-thought-tasks?${query({ thoughtIds })}`))] },
    { view: 'Wiki', groups: [...shell, ...projectShell,
      [get('doc', `/api/v1/docs/${ids.docId}`)]] },
    { view: 'Inbox', groups: [...shell, [get('inbox', '/api/v1/inbox?limit=100')]] },
    { view: 'Search', groups: [[get('search', `/api/v1/search?${query({ q: SEARCH_TERM, limit: 20 })}`)]] },
    { view: 'Jump to', groups: [[get('jump to', `/api/v1/search?${query({ q: 'frost', limit: 8 })}`)]] },
    // Beyond #298's list: the doc link picker (docs/LinkPicker.tsx) and the MCP list tool read this page.
    { view: 'Link picker', groups: [[get('conversation list', `/api/v1/projects/${p}/conversations?limit=100&offset=0`)]] },
  ];
}

async function openView(session, view, label = 'client') {
  for (const group of view.groups) {
    await Promise.all(group.map(async (request) => {
      const response = await session.request(request.method, request.path, request.body);
      emit({ type: label, view: view.view, label: request.label, method: request.method, path: request.path, status: response.status,
        ms: Math.round(response.ms * 10) / 10, bytes: response.bytes, encoding: response.encoding });
    }));
  }
}

function flatten(plan) {
  return plan.map((view) => ({ view: view.view, requests: view.groups.flat().map(({ label, method, path }) => ({ label, method, path })) }));
}

async function window(phase, work) {
  const start = Date.now();
  await work();
  emit({ type: 'window', phase, start, end: Date.now() });
}

async function countStatements(session, plan, phase) {
  const require = createRequire('/app/packages/db/package.json');
  const pg = require('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  const seen = new Set();
  const start = Date.now();
  // pg-boss maintenance and the measurement's own queries are not the request's statements.
  const mine = `query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%pgboss%' AND query NOT ILIKE '%pg_current_wal_lsn%' AND query NOT ILIKE '%pg_wal_lsn_diff%'
    AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  for (const view of plan) {
    for (const request of view.groups.flat()) {
      const key = `${request.method} ${request.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await client.query('SELECT pg_stat_statements_reset()');
      const lsn = async () => (await client.query('SELECT pg_current_wal_lsn() AS at')).rows[0].at;
      const before = await lsn();
      const response = await session.request(request.method, request.path, request.body);
      // Statement statistics are flushed when each statement ends; give the last one a moment.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // WAL written meanwhile: a read that writes (row locks, a commit record) also waits for a flush.
      const wal = Number((await client.query('SELECT pg_wal_lsn_diff($1, $2)::bigint AS bytes', [await lsn(), before])).rows[0].bytes);
      const { rows } = await client.query(`SELECT calls::int, round(total_exec_time::numeric, 2)::float AS ms, round(total_plan_time::numeric, 2)::float AS plan,
        rows::int, wal_records::int AS wal, left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query
        FROM pg_stat_statements WHERE ${mine} ORDER BY calls DESC, total_exec_time DESC`);
      const sum = (field) => Math.round(rows.reduce((total, row) => total + row[field], 0) * 100) / 100;
      emit({ type: 'count', phase, view: view.view, label: request.label, method: request.method, path: request.path, status: response.status,
        statements: rows.reduce((total, row) => total + row.calls, 0), dbMs: sum('ms'), planMs: sum('plan'), walBytes: wal, top: rows.slice(0, 15) });
    }
  }
  await client.end();
  emit({ type: 'window', phase, start, end: Date.now() });
}

// `prepare` signs in and discovers once; the other modes reuse its state (FLUX_PERF_STATE) so a
// cold pass after a restart sends nothing but the views' own requests.
let state;
if (mode === 'prepare' || mode === 'plan') {
  const sessions = [];
  for (const email of emails.slice(0, clients)) sessions.push(await signIn(email));
  state = { cookies: sessions.map((session) => [...session.cookies]), ids: await discover(sessions[0]) };
  if (mode === 'prepare') emit({ type: 'state', ...state });
} else {
  if (!process.env.FLUX_PERF_STATE) fail('FLUX_PERF_STATE is required; run FLUX_PERF_MODE=prepare first');
  state = JSON.parse(process.env.FLUX_PERF_STATE);
}
const sessions = state.cookies.map((cookies) => Object.assign(new Session(), { cookies: new Map(cookies) }));
const plan = viewPlan(state.ids);
if (mode === 'plan' || mode === 'count') emit({ type: 'plan', views: flatten(plan) });

// FLUX_PERF_PERSON: 0 is the workspace owner (Ada), 1 a member (Jonas); their access paths differ.
const person = Number(process.env.FLUX_PERF_PERSON ?? 0);
const me = sessions[person] ?? fail(`No prepared session for person ${person}`);
const named = (phase) => (person ? `${phase} (member)` : phase);

if (mode === 'count') {
  // One request at a time with nothing else running: its statements and its isolated server time.
  await countStatements(me, plan, named('isolated'));
} else if (mode === 'pass') {
  const first = Number(process.env.FLUX_PERF_FIRST ?? 0) % plan.length;
  const order = [...plan.slice(first), ...plan.slice(0, first)];
  await window(named('cold'), async () => { for (const view of order) await openView(me, view); });
} else if (mode === 'warm') {
  // One unrecorded pass first, so "warm" means a running process and a used pool.
  for (const view of plan) await openView(me, view, 'warmup');
  await window(named('warm'), async () => { for (let run = 0; run < runs; run++) for (const view of plan) await openView(me, view); });
} else if (mode === 'concurrent') {
  for (const view of plan) await openView(sessions[0], view, 'warmup');
  await window('concurrent', async () => {
    await Promise.all(sessions.map(async (session) => { for (let run = 0; run < runs; run++) for (const view of plan) await openView(session, view); }));
  });
} else if (mode === 'once') {
  // Every view once per person, one after the other (the auto_explain and profile phases).
  for (const session of sessions) for (const view of plan) await openView(session, view, 'once');
} else if (mode !== 'plan' && mode !== 'prepare') {
  fail(`Unknown FLUX_PERF_MODE ${mode}`);
}
