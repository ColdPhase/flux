/* global fetch, process, console, crypto, URL */
// Performance seed for scripts/check_performance.sh (#298). Like scripts/flux-demo.mjs it runs
// with plain Node inside the API container, fed on stdin, and writes only through the public HTTP
// API as signed-in people, so the access policy, idempotency, domain events and the worker's
// notifications apply exactly as for real use. Measurement data only: never run it against a
// deployment people use.
//
// Volume (#298): one workspace with 3 people and 10 projects; 2,000 messages in 100 threads of
// one project; 500 tasks (300 in that project, 200 across the others) with owners; a project map
// of 200 linked thoughts; 50 docs with 3 versions each; 20 materials; notifications follow from
// the replies, mentions and assignments. The content is deterministic; ids are not.
//
// Input (environment): FLUX_PERF_API (default http://127.0.0.1:8080), FLUX_PUBLIC_ORIGIN,
// FLUX_PERF_PASSWORD. Output: progress lines and a final `FLUX_PERF_SEED {json}` line.

const api = process.env.FLUX_PERF_API ?? 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const password = process.env.FLUX_PERF_PASSWORD;
const WORKSPACE_NAME = 'Perf volume (#298)';
const MAIN_PROJECT = 'Community garden sensors';
const THREADS = 100;
const MESSAGES_PER_THREAD = 20;
const MAIN_TASKS = 300;
const OTHER_TASKS = 200;
const THOUGHTS = 200;
const DOCS = 50;
const DOC_VERSIONS = 3;
const MATERIALS = 20;
// Two writers at a time at most: the host is shared (#298).
const CONCURRENCY = 2;

if (!origin) fail('FLUX_PUBLIC_ORIGIN is required');
if (!password) fail('FLUX_PERF_PASSWORD is required');

function fail(message) {
  console.error(`perf-seed: ${message}`);
  process.exit(1);
}

class Session {
  cookies = new Map();

  async request(method, path, body, extra = {}) {
    const headers = { origin, ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(path, api), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1).trim();
      if (value) this.cookies.set(pair.slice(0, index).trim(), value); else this.cookies.delete(pair.slice(0, index).trim());
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  }

  async expect(method, path, body, status = [200, 201], extra = {}) {
    const response = await this.request(method, path, body, extra);
    if (!status.includes(response.status)) fail(`${method} ${path} answered ${response.status}: ${response.text.slice(0, 400)}`);
    return response.json;
  }
}

async function account(name, email) {
  const session = new Session();
  const signUp = await session.request('POST', '/api/auth/sign-up/email', { email, password, name });
  if (signUp.status !== 200) {
    const signIn = await session.request('POST', '/api/auth/sign-in/email', { email, password });
    if (signIn.status !== 200) fail(`${email} could not sign up or sign in (${signUp.status}/${signIn.status})`);
  }
  const me = await session.expect('GET', '/api/v1/me');
  return { name, email, session, id: me.user.id };
}

/** Runs `count` jobs with at most CONCURRENCY in flight, in index order per lane. */
async function lanes(count, job) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < count) {
      const index = next++;
      await job(index);
    }
  }));
}

const uuid = () => crypto.randomUUID();
const started = Date.now();
const people = [
  await account('Ada Kowalska', 'ada@perf.flux.test'),
  await account('Jonas Berg', 'jonas@perf.flux.test'),
  await account('Maya Okafor', 'maya@perf.flux.test'),
];
const [ada, jonas, maya] = people;
const ref = (person) => ({ kind: 'human', id: person.id });

const existing = (await ada.session.expect('GET', '/api/v1/workspaces')).find((ws) => ws.name === WORKSPACE_NAME);
if (existing) {
  console.log(`Workspace "${WORKSPACE_NAME}" already exists; nothing new was seeded.`);
  console.log(`FLUX_PERF_SEED ${JSON.stringify({ workspaceId: existing.id, alreadySeeded: true })}`);
  process.exit(0);
}

const ws = await ada.session.expect('POST', '/api/v1/workspaces', { name: WORKSPACE_NAME });
for (const person of [jonas, maya]) {
  await ada.session.expect('POST', `/api/v1/workspaces/${ws.id}/members`, { email: person.email, role: 'member' });
}
const projectNames = [MAIN_PROJECT, 'School robotics club', 'Tool library', 'Repair café', 'Seed swap',
  'Rainwater barrels', 'Compost rota', 'Bike workshop', 'Pollinator strip', 'Winter market'];
const projects = [];
for (const name of projectNames) {
  projects.push(await ada.session.expect('POST', `/api/v1/workspaces/${ws.id}/projects`, { name, visibility: 'workspace' }));
}
const main = projects[0];
// Everyone last looked at Home and the main project now, before the busy period below, so
// "Since you left" and the project's "needs you" summarize everything that follows (#106/#133).
for (const person of people) {
  for (const place of [{ type: 'home' }, { type: 'project', id: main.id }]) {
    const query = place.type === 'home' ? 'place=home' : `place=project&id=${place.id}`;
    const { mark } = await person.session.expect('GET', `/api/v1/return?${query}`);
    await person.session.expect('PUT', '/api/v1/return-points', { place, mark });
  }
}
console.log(`  workspace, 3 people, ${projects.length} projects, return points (${Date.now() - started} ms)`);

// 2,000 messages: 100 threads of 20. Replies notify the thread's people; every seventh message
// addresses someone by name, every fifth asks a question.
const topics = ['soil moisture probes', 'LoRa gateway range', 'frost warnings', 'the council grant', 'volunteer rota',
  'battery life', 'sensor housings', 'data on the noticeboard', 'calibration day', 'the far beds'];
const threadIds = [];
await lanes(THREADS, async (thread) => {
  const topic = topics[thread % topics.length];
  const author = people[thread % 3];
  const root = await author.session.expect('POST', `/api/v1/projects/${main.id}/conversations`, {
    body: `Thread ${thread + 1}: what should we decide about ${topic} before the next workday?`, clientMessageId: uuid(),
  });
  threadIds[thread] = root.id;
  for (let index = 1; index < MESSAGES_PER_THREAD; index++) {
    const person = people[(thread + index) % 3];
    const other = people[(thread + index + 1) % 3];
    const addressed = index % 7 === 0 ? `@${other.name.split(' ')[0]} ` : '';
    const ask = index % 5 === 0 ? ' Could you check this before Thursday?' : '';
    await person.session.expect('POST', `/api/v1/conversations/${root.id}/messages`, {
      body: `${addressed}Reply ${index} on ${topic}: the readings from bed ${(thread + index) % 12 + 1} look ${index % 2 ? 'stable' : 'noisy'} after the rain.${ask}`,
      clientMessageId: uuid(),
    });
  }
});
console.log(`  ${THREADS * MESSAGES_PER_THREAD} messages in ${THREADS} threads (${Date.now() - started} ms)`);

// 500 tasks: 300 in the main project, 200 across the other nine, owners rotating over the three
// people (assignment notifications), statuses mixed.
const statuses = ['open', 'open', 'in_progress', 'done'];
const taskIds = [];
await lanes(MAIN_TASKS + OTHER_TASKS, async (index) => {
  const project = index < MAIN_TASKS ? main : projects[1 + (index % (projects.length - 1))];
  const creator = people[index % 3];
  const owner = people[(index + 1) % 3];
  const task = await creator.session.expect('POST', `/api/v1/projects/${project.id}/work`, {
    clientCommandId: uuid(),
    title: `Task ${index + 1}: ${['order', 'test', 'mount', 'label', 'document'][index % 5]} ${topics[index % topics.length]}`,
    outcome: `Done when the ${topics[(index + 3) % topics.length]} notes say who did what.`,
    owner: ref(owner),
    status: statuses[index % statuses.length],
  });
  taskIds[index] = task.id;
});
console.log(`  ${MAIN_TASKS + OTHER_TASKS} tasks (${Date.now() - started} ms)`);

// A project map with 200 thoughts, each linked to an earlier one.
const sketch = await ada.session.expect('POST', `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Where the sensors go', scope: 'project', projectId: main.id });
const thoughtIds = [];
const first = await ada.session.expect('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { text: 'Six sensors for twelve beds', x: 0, y: 0 });
thoughtIds.push(first.thought.id);
for (let index = 1; index < THOUGHTS; index++) {
  const person = people[index % 3];
  const parent = thoughtIds[Math.floor((index - 1) / 3)];
  const created = await person.session.expect('POST', `/api/v1/sketches/${sketch.id}/thoughts`, {
    text: `Thought ${index + 1}: ${topics[index % topics.length]}`,
    x: 260 * (1 + Math.floor(Math.log(index + 1) / Math.log(3))), y: 90 * (index % 40) - 1800,
    linkFrom: { thoughtId: parent, label: index % 4 === 0 ? 'because' : null },
  });
  thoughtIds.push(created.thought.id);
}
console.log(`  map with ${THOUGHTS} thoughts (${Date.now() - started} ms)`);

// 50 docs with 3 versions each, edited by different people.
const docIds = [];
await lanes(DOCS, async (index) => {
  const author = people[index % 3];
  const section = (n) => [`## Part ${n}`, '', `Notes on ${topics[(index + n) % topics.length]} from the workday.`,
    '', '- Who: the garden volunteers', '- When: Thursday after school', '- Open question: the far beds'].join('\n');
  let doc = await author.session.expect('POST', `/api/v1/projects/${main.id}/docs`, {
    title: `Doc ${index + 1}: ${topics[index % topics.length]}`, body: section(1), reason: 'First notes',
  }, [201], { 'idempotency-key': uuid() });
  docIds[index] = doc.id;
  for (let version = 2; version <= DOC_VERSIONS; version++) {
    const editor = people[(index + version) % 3];
    doc = await editor.session.expect('PATCH', `/api/v1/docs/${doc.id}`, {
      body: Array.from({ length: version }, (_, n) => section(n + 1)).join('\n\n'),
      state: version === DOC_VERSIONS && index % 2 === 0 ? 'published' : 'draft',
      reason: `Added part ${version}`,
    }, [200], { 'if-match': `"${doc.version}"`, 'idempotency-key': uuid() });
  }
});
console.log(`  ${DOCS} docs with ${DOC_VERSIONS} versions each (${Date.now() - started} ms)`);

// Shared material (sources people cite). Beyond #298's list, but the Conversation view reads the
// project's materials on open and every 15 s, so a project that has some is the realistic case.
await lanes(MATERIALS, async (index) => {
  const author = people[index % 3];
  await author.session.expect('POST', `/api/v1/projects/${main.id}/materials`, {
    clientMutationId: uuid(), title: `Source ${index + 1}: ${topics[index % topics.length]}`,
    body: `Measurements and links about ${topics[index % topics.length]}, collected on workday ${index + 1}.`,
  });
});
console.log(`  ${MATERIALS} materials (${Date.now() - started} ms)`);

console.log(`FLUX_PERF_SEED ${JSON.stringify({
  workspaceId: ws.id, mainProjectId: main.id, projectIds: projects.map((p) => p.id), sketchId: sketch.id,
  threads: threadIds.length, tasks: taskIds.length, thoughts: thoughtIds.length, docs: docIds.length,
  people: people.map(({ name, email, id }) => ({ name, email, id })), seconds: Math.round((Date.now() - started) / 1000),
})}`);
