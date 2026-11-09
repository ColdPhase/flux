import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { AGENT_TOOLS, agentConnectionPath, personalRunTokenPath, type Conversation, type Project, type Workspace } from '@flux/contracts';
import type { Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { createMcpDispatch } from '../../apps/server/src/agent-connection/mcp-dispatch.js';
import { createFluxMcpTools } from '../../apps/server/src/agent-connection/mcp-tools.js';
import { ASSISTANT_UNIT_CREATE_INPUT } from '../../apps/server/src/agent-connection/tool-registry.js';
import { convertedOnce } from '../../apps/server/src/agent-connection/tool-schema.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { agentSettings } from './support/agent-settings.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { mcp, toolValue } from './support/mcp.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';

// #1144: the MCP route builds its tool definitions (every tool's zod schema, its JSON Schema, the playbook's digest, the search cursor key
// and the check of the registrations against the tool list) once for the process, and a request only gets its own server with the tools it
// may use, bound to its verified claims. Nothing of one request may reach another: two principals, two runs and a client, interleaved on
// the one set of definitions, each get their own tools and their own results. The tool list itself is pinned by extension-contracts.test.ts.

const SECRET = 'a-search-cursor-secret-of-at-least-32-characters';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
type Message = Record<string, unknown> | null;
const text = (message: Message) => (message?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '';
const refusalCode = (message: Message) => {
  const result = message?.result as { isError?: boolean } | undefined;
  return result?.isError ? (JSON.parse(text(message)) as { code?: string }).code : undefined;
};
const listed = (message: Message) => (message?.result as { tools: { name: string }[] }).tools;
const projectsOf = (message: Message) => (JSON.parse(text(message)) as { projects: { id: string }[] }).projects.map((item) => item.id);
const titlesOf = (message: Message) => (JSON.parse(text(message)) as { items: { title: string }[] }).items.map((item) => item.title);

describe('a tool definition converts its JSON Schema once and shares it (#1144)', () => {
  // A real tool schema: a strict object of uuids, a bounded string and an integer.
  const schema = ASSISTANT_UNIT_CREATE_INPUT;
  const counted = () => {
    const standard = schema['~standard'];
    const calls: string[] = [];
    const fake = { '~standard': { ...standard, jsonSchema: {
      input: (options: { target: string }) => { calls.push(`input:${options.target}`); return standard.jsonSchema.input(options); },
      output: (options: { target: string }) => { calls.push(`output:${options.target}`); return standard.jsonSchema.output(options); },
    } } } as unknown as typeof schema;
    return { wrapped: convertedOnce(fake), calls };
  };

  test('zod converts it the first time it is asked, with each option set, and every later request gets the same frozen result', () => {
    const { wrapped, calls } = counted();
    const options = { target: 'draft-2020-12' } as const;
    const first = wrapped['~standard'].jsonSchema.input(options);
    const second = wrapped['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    assert.equal(calls.length, 1, 'converted once');
    assert.equal(first, second, 'the very same object');
    assert.deepEqual(first, schema['~standard'].jsonSchema.input(options), 'exactly what zod itself converts to');
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.properties) && Object.isFrozen((first.properties as Record<string, object>).unitKey),
      'frozen to its leaves: no request can change it for the next');
    wrapped['~standard'].jsonSchema.input({ target: 'draft-07' });
    wrapped['~standard'].jsonSchema.output(options);
    assert.deepEqual(calls, ['input:draft-2020-12', 'input:draft-07', 'output:draft-2020-12'], 'one conversion for each target and direction');
  });

  test('zod still validates every call, with its own result and its own messages', async () => {
    const { wrapped } = counted();
    const valid = { clientCommandId: randomUUID(), peerRequestClass: 'execute', taskId: randomUUID(), unitKey: 'codex-1', expectedTaskVersion: 3,
      assignmentConnectionId: randomUUID(), parent: null };
    assert.deepEqual(await wrapped['~standard'].validate(valid), await schema['~standard'].validate(valid));
    const bad = { ...valid, taskId: 'nope', expectedTaskVersion: 0, unitKey: '', extra: true };
    const refused = await wrapped['~standard'].validate(bad);
    assert.ok('issues' in refused && refused.issues!.length >= 4, 'a bad id, a version under its minimum, an empty key and an unknown key');
    assert.deepEqual(refused, await schema['~standard'].validate(bad), 'the very issues zod itself reports');
  });
});

describe('the tool definitions are built once and every server shares them (#1144)', () => {
  const claimsOf = (ownerUserId: string, run?: { tools: string[] }) => ({ ownerUserId, connectionId: randomUUID(), clientId: null, grantReferenceId: null, dispatch: createMcpDispatch(),
    ...(run ? { run: { id: randomUUID(), jti: randomUUID(), projectId: randomUUID(), conversationId: null, dmId: null, tools: run.tools } } : {}) });

  test('two servers of two principals share each tool\'s converted schema, and a personal run is served from its own definitions', () => {
    const tools = createFluxMcpTools(db, SECRET);
    const first = tools.server(claimsOf(randomUUID())), second = tools.server(claimsOf(randomUUID()));
    assert.notEqual(first, second, 'a server belongs to one request');
    for (const name of ['flux_get_work', 'flux_create_task', 'flux_bootstrap']) {
      const a = first.toolInputSchemaJson(name), b = second.toolInputSchemaJson(name);
      assert.ok(a && b, name);
      assert.equal(a.properties, b.properties, `${name}: the one converted schema, not one per request`);
      assert.ok(Object.isFrozen(a.properties), name);
    }
    // A run's change tool is defined differently (no sources; the project optional), and it is not the client's.
    const run = tools.server(claimsOf(randomUUID(), { tools: ['flux_create_task', 'flux_list_contexts'] }));
    const asRun = run.toolInputSchemaJson('flux_create_task')!.properties as Record<string, unknown>;
    const asClient = first.toolInputSchemaJson('flux_create_task')!.properties as Record<string, unknown>;
    assert.ok('sources' in asClient && !('sources' in asRun));
    assert.equal(run.toolInputSchemaJson('flux_get_work'), undefined, 'a tool outside the run\'s own list is not on its server');
    assert.equal(tools.server(claimsOf(randomUUID(), { tools: ['flux_create_task'] })).toolInputSchemaJson('flux_create_task')!.properties, asRun, 'runs share theirs too');
  });

  test('a personal run is served exactly its own tools from its own definitions, and a client all of the client\'s', () => {
    const tools = createFluxMcpTools(db, SECRET);
    const offered = (server: ReturnType<typeof tools.server>) => AGENT_TOOLS.filter((entry) => entry.kind === 'tool' && server.toolInputSchemaJson(entry.name) !== undefined).map((entry) => entry.name);
    const client = offered(tools.server(claimsOf(randomUUID())));
    assert.ok(client.length > 40 && client.includes('flux_get_work') && client.includes('flux_acknowledge_playbook'));
    assert.ok(!client.includes('flux_read_web'), 'no web read for a client, and none where the install has no reader');
    assert.deepEqual(offered(tools.server(claimsOf(randomUUID(), { tools: ['flux_get_work', 'flux_bootstrap'] }))).sort(), ['flux_bootstrap', 'flux_get_work']);
    assert.deepEqual(offered(tools.server(claimsOf(randomUUID(), { tools: [] }))), []);
    assert.deepEqual(offered(tools.server(claimsOf(randomUUID()))), client, 'and after a run, the client\'s list is what it was');
  });
});

describe('two principals, two runs and a client on one set of definitions, interleaved (#1144)', () => {
  interface Client { owner: Person; ws: Workspace; place: Project; agentId: string; taskTitle: string; connection: Awaited<ReturnType<typeof agentConnection>> }
  const connections = new FakeConnections();
  const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections, providerEnabled: true });
  const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
  let ada: Client; let jonas: Client;

  /** A person with a space, a task of their own and a local client signed in as their agent. */
  async function client(label: string): Promise<Client> {
    const owner = await person(label);
    const ws = await createWorkspace(owner, `${label} company`);
    const place = await createProject(owner, ws.id, `${label} project`, 'restricted');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: `${label} agent`, owner: 'self' } }), 201) as { id: string }).id;
    const taskTitle = `${label}-task-${randomBytes(4).toString('hex')}`;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: taskTitle } }), 201);
    return { owner, ws, place, agentId, taskTitle, connection: await agentConnection(pool, owner.browser, agentId, [place.id]) };
  }

  interface Run { owner: Person; place: Project; token: string; tools: string[]; call(name: string, args?: Record<string, unknown>): ReturnType<typeof mcp>; list(): ReturnType<typeof mcp> }
  /** A person's assistant, turned on with the given "What it may do", and one of its runs in flight with its token minted. */
  async function assistant(label: string, mayDo: 'act' | 'read'): Promise<Run> {
    const owner = await person(label);
    const ws = await createWorkspace(owner, `${label} company`);
    const place = await createProject(owner, ws.id, `${label} project`, 'workspace');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: `${label} assistant`, owner: 'self' } }), 201) as { id: string }).id;
    const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: `${label} asks`, clientMessageId: randomUUID() } }), 201) as Conversation;
    const connection = randomUUID();
    connections.connect(owner.id, connection);
    await runs.enable(human(owner), { agentId, connection, model: 'claude-sonnet-5' });
    expectStatus(await owner.browser.request('PATCH', agentConnectionPath((await agentSettings(owner, ws.id)).connectionId), { body: { mayDo } }), 200);
    const started = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: `${label}: what is here?` });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
    const nonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(started.run.id, sha256(nonce))), true);
    const minted = await fetch(`${apiUrl}${personalRunTokenPath(started.run.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(minted.status, 200);
    const { token, tools } = await minted.json() as { token: string; tools: string[] };
    let id = 0;
    return { owner, place, token, tools,
      call: (name, args = {}) => mcp(token, ++id, 'tools/call', { name, arguments: args }),
      list: () => mcp(token, ++id, 'tools/list') };
  }
  let acting: Run; let secondActing: Run; let reading: Run;

  before(async () => {
    ada = await client('tc-ada');
    jonas = await client('tc-jonas');
    // Jonas's agent only reads; Ada's acts.
    expectStatus(await jonas.owner.browser.request('PATCH', agentConnectionPath(jonas.connection.connectionId), { body: { mayDo: 'read' } }), 200);
    acting = await assistant('tc-run-one', 'act');
    secondActing = await assistant('tc-run-two', 'act');
    reading = await assistant('tc-run-three', 'read');
  });

  test('every client is listed the same tools, with the same descriptions and schemas, however often and in whatever company it asks', async () => {
    const ask = async (who: Client) => (await mcp(who.connection.accessToken, Math.floor(Math.random() * 1e6), 'tools/list')).message?.result as { tools: unknown[] };
    const [first, second] = [await ask(ada), await ask(jonas)];
    assert.ok(first.tools.length > 40);
    assert.deepEqual(first, second, 'two principals: the same list');
    // Runs and a read-only client in between change nothing for the next client.
    await Promise.all([acting.list(), reading.list(), ask(jonas), secondActing.list()]);
    assert.deepEqual(await ask(ada), first, 'the same list after other callers');
    assert.deepEqual((await ada.connection.toolNames()).sort(), (await jonas.connection.toolNames()).sort());
  });

  test('two principals\' parallel calls each reach their own space and each get their own answer, round after round', async () => {
    const rounds = 6;
    for (let round = 0; round < rounds; round += 1) {
      const [adaContexts, jonasContexts, adaWork, jonasWork, adaIntoJonas, jonasIntoAda] = await Promise.all([
        ada.connection.tool('flux_list_contexts', {}), jonas.connection.tool('flux_list_contexts', {}),
        ada.connection.tool('flux_list_work', { projectId: ada.place.id }), jonas.connection.tool('flux_list_work', { projectId: jonas.place.id }),
        ada.connection.tool('flux_list_work', { projectId: jonas.place.id }), jonas.connection.tool('flux_list_work', { projectId: ada.place.id }),
      ]);
      assert.deepEqual(projectsOf(adaContexts), [ada.place.id]);
      assert.deepEqual(projectsOf(jonasContexts), [jonas.place.id]);
      assert.deepEqual(titlesOf(adaWork), [ada.taskTitle]);
      assert.deepEqual(titlesOf(jonasWork), [jonas.taskTitle]);
      assert.ok(refusalCode(adaIntoJonas), 'Ada\'s agent cannot read Jonas\'s space');
      assert.ok(refusalCode(jonasIntoAda), 'nor Jonas\'s agent Ada\'s');
      assert.ok(!text(adaIntoJonas).includes(jonas.taskTitle) && !text(jonasIntoAda).includes(ada.taskTitle));
    }
  });

  test('"What it may do" and the capabilities are each principal\'s own: Ada\'s agent acts while Jonas\'s only reads, in the same breath', async () => {
    const made = (who: Client, index: number) => who.connection.tool('flux_create_task', { projectId: who.place.id, clientCommandId: randomUUID(), task: { title: `tc-made-${index}` } });
    const [mineOk, theirsRefused, mineOk2, theirsRefused2] = await Promise.all([made(ada, 1), made(jonas, 1), made(ada, 2), made(jonas, 2)]);
    assert.ok(JSON.parse(text(mineOk)).workId && JSON.parse(text(mineOk2)).workId, 'Ada\'s agent made its tasks');
    assert.equal(refusalCode(theirsRefused), 'AGENT_ONLY_READS');
    assert.equal(refusalCode(theirsRefused2), 'AGENT_ONLY_READS');
    const made1 = (await pool.query(`SELECT project_id FROM project_work_items WHERE title LIKE 'tc-made-%' ORDER BY title, created_at`)).rows as { project_id: string }[];
    assert.deepEqual(made1.map((row) => row.project_id), [ada.place.id, ada.place.id], 'only in the space of the principal that asked');
    const capabilities = async (who: Client) => toolValue((await who.connection.tool('flux_bootstrap', { projectId: who.place.id, clientSessionId: randomUUID() }))).capabilities as { name: string; available: boolean }[];
    const [adaCaps, jonasCaps] = await Promise.all([capabilities(ada), capabilities(jonas)]);
    assert.equal(adaCaps.find((item) => item.name === 'flux_create_task')!.available, true);
    assert.equal(jonasCaps.find((item) => item.name === 'flux_create_task')!.available, false);
    assert.equal(jonasCaps.find((item) => item.name === 'flux_list_work')!.available, true);
    assert.deepEqual(adaCaps.map((item) => item.name), jonasCaps.map((item) => item.name), 'the same tools, listed alike');
  });

  test('each run is listed exactly its own tools and reaches only its own place; a client and the runs never borrow from one another', async () => {
    for (let round = 0; round < 4; round += 1) {
      const [oneList, twoList, readList, adaList, oneContexts, twoContexts, readContexts, adaContexts] = await Promise.all([
        acting.list(), secondActing.list(), reading.list(), mcp(ada.connection.accessToken, 900 + round, 'tools/list'),
        acting.call('flux_list_contexts'), secondActing.call('flux_list_contexts'), reading.call('flux_list_contexts'), ada.connection.tool('flux_list_contexts', {}),
      ]);
      assert.deepEqual(listed(oneList.message).map((tool) => tool.name).sort(), acting.tools, 'the first run: exactly the tools minted for it');
      assert.deepEqual(listed(twoList.message).map((tool) => tool.name).sort(), secondActing.tools);
      assert.deepEqual(listed(readList.message).map((tool) => tool.name).sort(), reading.tools, 'a read-only assistant\'s run has the reads only');
      assert.ok(!reading.tools.includes('flux_create_task') && acting.tools.includes('flux_create_task'));
      assert.ok(listed(adaList.message).length > acting.tools.length, 'the client is listed all of the client\'s tools, not a run\'s');
      assert.deepEqual(projectsOf(oneContexts.message), [acting.place.id]);
      assert.deepEqual(projectsOf(twoContexts.message), [secondActing.place.id]);
      assert.deepEqual(projectsOf(readContexts.message), [reading.place.id]);
      assert.deepEqual(projectsOf(adaContexts), [ada.place.id]);
    }
  });

  test('two runs changing things at once each change their own place (no project is named: it is the run\'s), and a read-only run is refused', async () => {
    const titles = [0, 1, 2, 3].map((index) => ({ one: `tc-one-${index}-${randomBytes(3).toString('hex')}`, two: `tc-two-${index}-${randomBytes(3).toString('hex')}` }));
    const answers = await Promise.all(titles.flatMap((title) => [acting.call('flux_create_task', { clientCommandId: randomUUID(), task: { title: title.one } }),
      secondActing.call('flux_create_task', { clientCommandId: randomUUID(), task: { title: title.two } }), reading.call('flux_create_task', { clientCommandId: randomUUID(), task: { title: 'tc-never' } })]));
    answers.forEach((answer, index) => {
      if (index % 3 === 2) assert.equal(refusalCode(answer.message), 'MCP_ENTRY_UNAVAILABLE', 'a tool outside the run\'s own list is refused before anything runs');
      else assert.ok(JSON.parse(text(answer.message)).workId, `change ${index} applied`);
    });
    const placeOf = async (title: string) => ((await pool.query(`SELECT project_id FROM project_work_items WHERE title = $1`, [title])).rows as { project_id: string }[]).map((row) => row.project_id);
    for (const title of titles) {
      assert.deepEqual(await placeOf(title.one), [acting.place.id], 'the first run\'s task is in the first run\'s place');
      assert.deepEqual(await placeOf(title.two), [secondActing.place.id], 'the second run\'s is in the second\'s');
    }
    assert.deepEqual(await placeOf('tc-never'), [], 'a read-only run made nothing');
  });

  test('a run sees a client\'s resources and prompts never, a client always, whatever was asked before', async () => {
    const withBearer = (token: string, method: string, id: number) => mcp(token, id, method);
    const [clientPrompts, runPrompts, clientResources, runResources] = await Promise.all([
      withBearer(ada.connection.accessToken, 'prompts/list', 801), withBearer(acting.token, 'prompts/list', 802),
      withBearer(ada.connection.accessToken, 'resources/list', 803), withBearer(acting.token, 'resources/list', 804)]);
    const names = (message: Message, key: string) => ((message?.result as Record<string, { name: string }[]> | undefined)?.[key] ?? []).map((item) => item.name).sort();
    assert.deepEqual(names(clientPrompts.message, 'prompts'), ['resume_work', 'start_work']);
    assert.deepEqual(names(runPrompts.message, 'prompts'), [], 'a run is offered tools only');
    assert.deepEqual(names(clientResources.message, 'resources'), ['flux_cowork_playbook']);
    assert.deepEqual(names(runResources.message, 'resources'), []);
    // And a client's failure is its own: Jonas's refused write did not turn into a refusal for anyone else.
    assert.equal(toolFailure((await jonas.connection.tool('flux_create_task', { projectId: jonas.place.id, clientCommandId: randomUUID(), task: { title: 'tc-no' } }))).code, 'AGENT_ONLY_READS');
    assert.ok(JSON.parse(text(await ada.connection.tool('flux_create_task', { projectId: ada.place.id, clientCommandId: randomUUID(), task: { title: 'tc-yes' } }))).workId);
  });
});
