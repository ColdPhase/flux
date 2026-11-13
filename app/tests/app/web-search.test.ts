import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { aiModelSearchesWeb, WEB_SEARCH_MICROS } from '@flux/contracts';
import {
  boundedWebSearch, KEY_WEB_SEARCH_LINE, NO_WEB_SEARCH_LINE, OPEN_ANY_ADDRESS_LINE, runtimeBrief, WebSearchRefusedError,
  type BriefInput, type PersonalCompute, type PersonalComputeRequest, type PersonalComputeResult,
} from '@flux/core';
import { personalRunWebReadRows } from '@flux/db';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { openAiResponse } from '../../packages/agent-runtime/src/responses.js';
import { registerAgentWebReads } from '../../apps/server/src/agent-connection/web-reads.js';
import type { AgentToolRegistry } from '../../apps/server/src/agent-connection/tool-registry.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { loadWebReadsConfig } from '../../apps/server/src/web-reads/config.js';
import { personalRunWorkerComposition, webSearchSwitch } from '../../apps/worker/src/personal-runs/composition.js';
import { db, pool } from './support/db.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { BRIEF } from './support/brief.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { FLUX_TOOLS } from './support/provider-tool-fixtures.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// Web search for API-key agents (#954, founder direction 2026-11-08, C-29, C-30, AG-8; #1441): the provider's own built-in search tool
// (Anthropic's `web_search` server tool, OpenAI's Responses `web_search`), on by default, turned off with the reading by the operator's
// one switch. An agent in pi in the agent runtime (RT-1) has no search of its own: it searches with Flux's `flux_web_search`, which the Flux
// server runs with the owner's key through that hosted search (RT-5), and reads pages with `flux_read_web`. The run lists what it searched
// and the addresses its answer cites. Since #1065 (founder direction 2026-11-09, C-30) any address opens, and one that carries private Flux
// text the run read (its brief, here) is refused.
// The adapters run against the Docker `providermock` (the documented shapes of both wire formats); the run is the REAL pinned pi with a
// scripted stand-in for Flux's model gateway, the real /mcp route of an API in this process whose provider is a stand-in (it records each search
// request and answers with what it is given to find), and the link mock as `public.test`. Nothing here is a provider pass: real providers are unverified.

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const SITE = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const PAGE = 'http://public.test/read/timetable';
const FLUX = 'mcp__flux__';
const KEY = `sk-ant-api03-${'owner-search-key-'.repeat(3)}WS01`;
const SEARCH = { query: 'harbour winter timetable', results: [PAGE, 'http://public.test/read/second'], cite: PAGE };

async function control(path: string, body?: unknown) {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ requests: RecordedProviderRequest[] }>;
}
const compute = (webSearch = true) => providerPersonalCompute({ enabled: true, webSearch, resolveKey: async () => KEY, policy: parsePrivateTargets(new URL(MOCK).hostname),
  baseUrls: { anthropic: `${MOCK}/anthropic`, openai: `${MOCK}/openai/v1` }, timeoutMs: 5_000 });
const requestOn = (provider: 'anthropic' | 'openai', overrides: Partial<PersonalComputeRequest> = {}): PersonalComputeRequest => ({
  connection: { id: 'connection-1', keyRef: 'key-ref', provider, baseUrl: null }, model: provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5.4',
  maxTokens: 1_500, effort: 'low', system: BRIEF.system, input: BRIEF.request, tools: FLUX_TOOLS, webSearch: true, ...overrides,
});
const live = new AbortController().signal;

describe('the provider\'s own web search on each wire format (#954; Docker mock of the documented shapes, no provider pass)', () => {
  const SECRET_URL = `http://public.test/collect?d=${encodeURIComponent('Private plan for the harbour')}`;
  const fakeFetch = (json: unknown) => (async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
  const responsesRequest = { baseUrl: 'http://unused.test/v1', apiKey: 'sk-test', model: 'gpt-5.4', system: 's', user: 'u', maxTokens: 1_500,
    tools: FLUX_TOOLS, webSearch: true, signal: new AbortController().signal };
  beforeEach(() => control('/__reset', {}));

  test('Anthropic: the basic web_search server tool goes with the Flux tools, and the search, its results and the cited address come back from the structured answer', async () => {
    await control('/__script', { wire: 'anthropic', text: 'The last boat leaves at 17:40.', search: SEARCH, usage: { input: 3_000, output: 90 } });
    const result = await compute().dispatch(requestOn('anthropic'), live);
    assert.equal(result.kind, 'completed');
    if (result.kind !== 'completed') return;
    const [sent] = (await control('/__requests')).requests;
    const tools = (sent!.body as { tools: { name: string; type?: string }[] }).tools;
    assert.deepEqual(tools.at(-1), { type: 'web_search_20250305', name: 'web_search' }, 'Anthropic\'s own search, with no max_uses: as many searches as the question needs (#1113)');
    assert.deepEqual(tools.slice(0, -1).map((tool) => tool.name), FLUX_TOOLS.map((tool) => tool.name), 'after the Flux tools');
    assert.deepEqual(result.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
    assert.deepEqual(result.usage, { inputTokens: 3_000, outputTokens: 90, webSearches: 1 }, 'the search is counted, to be charged');
    // A sentence that cites a result is several text blocks that belong together; the passages around the search are paragraphs.
    assert.equal(result.text, 'I will search for that.\n\nBased on the search, The last boat leaves at 17:40. That is all.');
    assert.equal(result.stopReason, 'end_turn');
  });

  test('Anthropic: the token count carries the search tool too, so the bound is not understated', async () => {
    await compute().countInputTokens!(requestOn('anthropic'));
    const [counted] = (await control('/__requests')).requests;
    assert.equal(counted!.path, '/anthropic/v1/messages/count_tokens');
    assert.ok(JSON.stringify((counted!.body as { tools: unknown }).tools).includes('web_search_20250305'));
  });

  test('OpenAI Responses: the web_search tool on the cached index goes with the Flux tools, nothing is stored, and the search call and its url_citation come back', async () => {
    await control('/__script', { wire: 'openai', text: 'The last boat leaves at 17:40.', search: SEARCH, usage: { input: 3_000, output: 90 } });
    const result = await compute().dispatch(requestOn('openai'), live);
    assert.equal(result.kind, 'completed');
    if (result.kind !== 'completed') return;
    const [sent] = (await control('/__requests')).requests;
    assert.equal(sent!.path, '/openai/v1/responses');
    const body = sent!.body as Record<string, unknown> & { tools: Record<string, unknown>[] };
    assert.deepEqual(body.tools.at(-1), { type: 'web_search', external_web_access: false }, 'no live page request on the agent\'s word but flux_read_web');
    assert.deepEqual(body.tools[0], { type: 'function', name: FLUX_TOOLS[0]!.name, description: FLUX_TOOLS[0]!.description, parameters: FLUX_TOOLS[0]!.inputSchema, strict: false });
    assert.deepEqual([body.store, body.include], [false, ['web_search_call.action.sources']], 'the sources of every search, and no encrypted reasoning');
    assert.equal('max_tool_calls' in body, false, 'and no limit on the calls of a request (#1113)');
    assert.equal(body.instructions, BRIEF.system);
    assert.deepEqual(result.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
    assert.deepEqual(result.usage, { inputTokens: 3_000, outputTokens: 90, webSearches: 1 }, 'each web_search_call is counted');
    assert.equal(result.text, 'The last boat leaves at 17:40.');
  });

  // The request `flux_web_search` makes (#1441, RT-5, `searchWithKey`): the search and nothing else, no Flux tool on it. Its answer must carry
  // the hosted search's results, or the tool finds nothing for every key.
  test('a request that is only the search (no Flux tool) offers the provider\'s own search and nothing else, on each wire format', async () => {
    await control('/__script', { wire: 'anthropic', text: 'The last boat leaves at 17:40.', search: SEARCH, usage: { input: 3_000, output: 90 } });
    const anthropic = await compute().dispatch(requestOn('anthropic', { tools: [] }), live);
    assert.equal(anthropic.kind, 'completed');
    if (anthropic.kind !== 'completed') return;
    assert.deepEqual(((await control('/__requests')).requests.at(-1)!.body as { tools: unknown }).tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
    assert.deepEqual(anthropic.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
    assert.equal(anthropic.usage.webSearches, 1);
    await control('/__script', { wire: 'openai', text: 'The last boat leaves at 17:40.', search: SEARCH, usage: { input: 3_000, output: 90 } });
    const openai = await compute().dispatch(requestOn('openai', { tools: [] }), live);
    assert.equal(openai.kind, 'completed');
    if (openai.kind !== 'completed') return;
    const body = (await control('/__requests')).requests.at(-1)!.body as { tools: unknown; include: unknown };
    assert.deepEqual([body.tools, body.include], [[{ type: 'web_search', external_web_access: false }], ['web_search_call.action.sources']]);
    assert.deepEqual(openai.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
  });

  test('without the run\'s search (the operator\'s switch off, or no tools), no search tool goes out and nothing is read as one', async () => {
    for (const wire of ['anthropic', 'openai'] as const) {
      await control('/__reset', {});
      await control('/__script', { wire, text: 'No search.', search: SEARCH });
      const result = await compute(false).dispatch(requestOn(wire, { webSearch: undefined }), live);
      const [sent] = (await control('/__requests')).requests;
      assert.ok(!JSON.stringify((sent!.body as { tools?: unknown }).tools).includes('web_search'), `${wire}: no search tool`);
      assert.equal(result.kind === 'completed' && result.webSearch, undefined, `${wire}: nothing is taken as a search`);
      assert.equal(result.kind === 'completed' && result.usage.webSearches, 1, `${wire}: a search the provider reports is still counted (and is out of the bounds of a request that offered none)`);
    }
  });

  test('what Flux keeps of a search is bounded: web addresses only, normalized, each once; queries on one line', () => {
    assert.deepEqual(boundedWebSearch({ queries: ['  ferry\ntimes ', 'ferry times', 42], results: ['http://a.example/x#frag', 'ftp://a.example/y', 'javascript:alert(1)', 'http://a.example/x'], cited: [null, 'https://b.example/'] }),
      { queries: ['ferry times'], results: ['http://a.example/x'], cited: ['https://b.example/'] });
  });

  test('P1-1: an address OpenAI\'s search opened on the model\'s word (open_page, find_in_page) is no result, and each call is still counted', async () => {
    const first = await openAiResponse(fakeFetch({ status: 'completed', usage: { input_tokens: 300, output_tokens: 20 }, output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: SECRET_URL } },
      { id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: SECRET_URL, pattern: 'plan' } },
      { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'flux_read_web', arguments: JSON.stringify({ url: SECRET_URL }) },
    ] }), responsesRequest);
    assert.equal(first.webSearch, undefined, 'nothing the model opened is taken as found');
    assert.equal(first.usage.webSearches, 2, 'each call is still counted');
  });

  test('P2-1: the providers\' refusal of their own search tool is recognised and not billed; any other 400 stays a provider error', async () => {
    const cases = [
      { wire: 'anthropic' as const, words: 'Web search is not enabled for this organization. An administrator can enable it in the Console.' },
      { wire: 'openai' as const, words: "Tool 'web_search' is not supported with o3-mini." },
    ];
    for (const { wire, words } of cases) {
      await control('/__script', { wire, mode: 'status', status: 400, errorMessage: words });
      assert.deepEqual(await compute().dispatch(requestOn(wire), live), { kind: 'failed', reason: 'provider_error', billed: 'none', searchRefused: true }, wire);
      for (const other of ['max_tokens: must be at most 4000', 'messages.1.content.2: web_search_tool_result block is not allowed here; a page said web search is disabled'])  {
        await control('/__script', { wire, mode: 'status', status: 400, errorMessage: other });
        assert.deepEqual(await compute().dispatch(requestOn(wire), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' }, `${wire}: another 400 (${other})`);
      }
      await control('/__script', { wire, mode: 'status', status: 400, errorMessage: words });
      const plain = await compute().dispatch(requestOn(wire, { webSearch: undefined }), live);
      assert.equal(plain.kind === 'failed' && plain.searchRefused, undefined, `${wire}: a request that offered no search is never a refused search`);
    }
  });

  test('P2-A: Anthropic\'s token count refusing the search tool is recognised: the count throws WebSearchRefusedError only for a request that offered search', async () => {
    await control('/__script', { wire: 'anthropic', mode: 'status', status: 400, errorMessage: 'Web search is not enabled for this organization.' });
    await assert.rejects(compute().countInputTokens!(requestOn('anthropic')), WebSearchRefusedError);
    await assert.rejects(compute().countInputTokens!(requestOn('anthropic', { webSearch: undefined })), (error: unknown) => !(error instanceof WebSearchRefusedError));
  });

  test('P2-1: a model Flux knows has no web search is not offered it (dated list)', () => {
    assert.equal(aiModelSearchesWeb('openai', 'o3-mini'), false);
    assert.equal(aiModelSearchesWeb('openai', 'gpt-5-nano'), true);
    assert.equal(aiModelSearchesWeb('anthropic', 'claude-sonnet-5'), true);
    assert.equal(aiModelSearchesWeb('openrouter', 'vendor/model'), false);
  });
});

/** The provider behind the API's `flux_web_search`: one search request of the run's own key, answered with what the test says it finds. */
class SearchProvider implements PersonalCompute {
  enabled = true;
  requests: PersonalComputeRequest[] = [];
  found: (request: PersonalComputeRequest) => { text: string; webSearch: { queries: string[]; results: string[]; cited: string[] } } = () => this.timetable();
  /** One search of the harbour's winter timetable: the page found, and the page cited. */
  timetable() {
    return { text: `Harbour & Co: winter timetable, ${PAGE}`, webSearch: { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] } };
  }
  async dispatch(request: PersonalComputeRequest): Promise<PersonalComputeResult> {
    this.requests.push(request);
    const found = this.found(request);
    return { kind: 'completed', stopReason: 'end_turn', text: found.text, usage: { inputTokens: 300, outputTokens: 20, webSearches: 1 }, webSearch: found.webSearch };
  }
}

describe('an API-key agent in pi searches with flux_web_search, opens any address but one that carries what it read in Flux, and lists its sources (#954, #1065, #1441, C-30; real pi, real /mcp, link mock)', () => {
  let scene: AssistantScene; let pi: PiRuntime;
  let closeApp: () => Promise<void> = async () => undefined;
  const provider = new SearchProvider();
  const SECRET = `http://public.test/collect?d=${encodeURIComponent('Private plan for the harbour')}`;
  const perRequest = Math.ceil((300 * 2_000_000 + 20 * 10_000_000) / 1_000_000);
  const address = (n: number) => `http://public.test/page/${n}`;
  const MADE_UP = 'http://public.test/page/not-found-by-any-search';
  const ask = (prompt: string) => scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const row = async (runId: string) => (await pool.query(`SELECT answer_body, charged_micros FROM personal_runs WHERE id = $1`, [runId])).rows[0] as { answer_body: string; charged_micros: number };
  const hits = async () => ((await (await fetch(`${SITE}/__hits`)).json()) as { path: string }[]).map((hit) => hit.path);
  const searches = async (runId: string) => (await pool.query(`SELECT queries, results, cited FROM personal_run_web_searches WHERE run_id = $1 ORDER BY searched_at, id`, [runId])).rows;
  const run = async (prompt: string) => {
    const started = await ask(prompt);
    assert.equal(await scene.processor!.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    return started.run.id;
  };

  before(async () => {
    // An API of this file's own: the web on, the test deployment's closed world (public.test is the link mock) and a stand-in provider behind the search.
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_WEB_READS: 'on', FLUX_TEST_FAILURE_INJECTION: 'true', FLUX_FIXTURE_TOKEN: process.env.FLUX_FIXTURE_TOKEN || 'fixture-web-search',
      FLUX_TEST_LINK_PREVIEW_HOSTS: 'public.test=linkmock:8098,other.test=linkmock:8098', FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `web-search-${'x'.repeat(40)}`,
      FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const connections = { list: (ownerUserId: string) => scene.connections.list(ownerUserId), resolve: (ownerUserId: string, id?: string) => scene.connections.resolve(ownerUserId, id) };
    const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'), 'packages/db/migrations', { keySearcher: { compute: provider, connections } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    closeApp = () => app.close();
    pi = await startPiRuntime({ apiUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` });
    scene = await assistantScene('wsr', { pi });
  });
  after(async () => { await pi.close(); await closeApp(); });
  beforeEach(async () => {
    await scene.reset();
    provider.requests = [];
    provider.found = () => provider.timetable();
    await fetch(`${SITE}/__reset`);
  });

  test('a search result and any other address open; one carrying the request\'s words is refused; the answer lists the search, the cited page and the reads', async () => {
    pi.gateway.script([
      { tool: `${FLUX}flux_web_search`, args: { query: SEARCH.query } },
      { tool: `${FLUX}flux_read_web`, args: { url: PAGE } },
      { tool: `${FLUX}flux_read_web`, args: { url: 'http://public.test/read/notes' } },
      { tool: `${FLUX}flux_read_web`, args: { url: SECRET } },
      { text: 'The last boat leaves at 17:40.' },
    ]);
    // The request names no address; its words are private Flux text the run read (its brief), recorded by the worker before the first request.
    const runId = await run('When is the last boat this winter? Keep our private plan for the harbour to yourself.');
    const [first] = pi.gateway.requests;
    assert.ok(first!.tools.includes(`${FLUX}flux_web_search`) && first!.tools.includes(`${FLUX}flux_read_web`), 'the run searches and reads (the operator\'s web switch is on, the key\'s provider has a search)');
    assert.ok(first!.prompt.includes(KEY_WEB_SEARCH_LINE), 'and the brief says so, with the rule for its results');
    assert.ok(first!.prompt.includes(OPEN_ANY_ADDRESS_LINE), 'and which addresses open');
    assert.deepEqual(provider.requests.map((request) => [request.connection.id, request.webSearch, request.tools]), [[scene.connectionId, true, []]], 'one search, on the run\'s own key, with no other tool');
    assert.match(provider.requests[0]!.input, /harbour winter timetable/);
    assert.ok((pi.gateway.requests[1]!.results[0] ?? '').includes(PAGE), 'the search result came back to the model');
    assert.ok((pi.gateway.requests[2]!.results[1] ?? '').includes('Harbour & Co: winter timetable'), 'the search result was read');
    assert.ok((pi.gateway.requests[3]!.results[2] ?? '').includes('Plain notes'), 'an address nothing gave opens');
    assert.equal((JSON.stringify(pi.gateway.requests.at(-1)!.results).match(/WEB_READ_PRIVATE_TEXT/g) ?? []).length, 1, 'one carrying the request\'s words is refused');
    assert.deepEqual(await hits(), ['/read/timetable', '/read/notes'], 'nothing reached the site the words were for');
    assert.deepEqual(await searches(runId), [{ queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] }]);
    const { answer_body: body, charged_micros: charged } = await row(runId);
    assert.ok(body.endsWith(`The last boat leaves at 17:40.\n\nSearched the web for:\n- ${SEARCH.query}\nFound on the web:\n- ${PAGE}\nRead on the web:\n- ${PAGE}\n- http://public.test/read/notes`), body);
    assert.equal(charged, perRequest + WEB_SEARCH_MICROS, 'the search is charged on the run, on top of its tokens, in the key\'s daily budget');
  });

  test('another run opens the same page like any address, and lists no search of the first run', async () => {
    pi.gateway.script([{ tool: `${FLUX}flux_web_search`, args: { query: SEARCH.query } }, { tool: `${FLUX}flux_read_web`, args: { url: PAGE } }, { text: 'Read it.' }]);
    await run('Find the timetable');
    pi.gateway.script([{ tool: `${FLUX}flux_read_web`, args: { url: PAGE } }, { text: 'Could not read it.' }]);
    const other = await run('Read the timetable again');
    assert.ok((pi.gateway.requests[1]!.results[0] ?? '').includes('Harbour & Co: winter timetable'), 'any address opens');
    assert.deepEqual(await searches(other), []);
    assert.ok(!(await row(other)).answer_body.includes('Searched the web'), 'and it lists no search of its own');
  });

  test('a run that is given no search is told it has none, and one with it is told how its results are used; a guest has no AI at all', async () => {
    // The tools a run is given are the run token's (the web switch off, or a provider without a hosted search, leave `flux_web_search` out:
    // agent-runtime-pi-search.test.ts); the brief follows them.
    const base: BriefInput = {
      kind: 'ask', tools: ['flux_get_conversation', 'flux_read_web'], agentName: 'Assistant', agentId: randomUUID(), ownerName: 'Ada', now: new Date(), timeZone: 'UTC',
      place: { kind: 'space', spaceId: 'p', spaceName: 'Lamp', conversationId: 'c', task: null }, task: null, scheduleTitle: null, agent: null, prompt: 'Anything new?',
      requestedAt: new Date(), messages: [], leftOut: false, turns: [], earlier: null, thought: null,
    };
    const without = runtimeBrief(base);
    assert.ok(without.includes(NO_WEB_SEARCH_LINE) && !without.includes(KEY_WEB_SEARCH_LINE));
    const given = runtimeBrief({ ...base, tools: [...base.tools, 'flux_web_search'] });
    assert.ok(given.includes(KEY_WEB_SEARCH_LINE) && !given.includes(NO_WEB_SEARCH_LINE));
    pi.gateway.script([]);
    await assert.rejects(scene.runs.invoke(human(scene.guest), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Search the web for me' }));
    assert.equal(pi.gateway.requests.length, 0, 'nothing of a guest reaches a model');
  });

  test('P1-1: a citation of an address the search did not return is not listed as a source', async () => {
    provider.found = () => ({ text: 'Harbour timetable', webSearch: { queries: ['harbour'], results: [PAGE], cited: [PAGE, SECRET] } });
    pi.gateway.script([{ tool: `${FLUX}flux_web_search`, args: { query: 'harbour' } }, { tool: `${FLUX}flux_read_web`, args: { url: SECRET } }, { text: 'The last boat leaves at 17:40.' }]);
    const runId = await run('When is the last boat? The private plan for the harbour is ours.');
    assert.ok((pi.gateway.requests[2]!.results[1] ?? '').includes('WEB_READ_PRIVATE_TEXT'), 'the read of that address was refused');
    assert.deepEqual(await hits(), [], 'nothing reached any site');
    assert.ok((await row(runId)).answer_body.endsWith(`Searched the web for:\n- harbour\nFound on the web:\n- ${PAGE}`), (await row(runId)).answer_body);
  });

  test('#1222: the stored answer has none of the model\'s own marks and no "Sources:" block repeating Flux\'s list, so each address is listed once', async () => {
    pi.gateway.script([{ tool: `${FLUX}flux_web_search`, args: { query: SEARCH.query } },
      { text: `The last boat leaves at 17:40 [8]【3†source】.\n\nSources:\n- Harbour & Co, "timetable": ${PAGE}` }]);
    const runId = await run('When is the last boat?');
    assert.equal((await row(runId)).answer_body, `The last boat leaves at 17:40.\n\nSearched the web for:\n- ${SEARCH.query}\nFound on the web:\n- ${PAGE}`);
  });

  // #1113 (founder direction, Hubert, 2026-11-09, "Żadnych limitów"): an agent searches and reads as much as a question needs. The caps of 5
  // searches and 20 addresses a run are gone, and since #1065 any address opens; the key's daily budget stays, and so do the run's own safety
  // bounds (its turns, its clock). A search is charged as the provider reports it.
  test('a run that searches 6 times and reads 7 addresses goes on to its answer: every search is recorded and charged as reported, an address no search found opens too, and every page is listed', async () => {
    // The nth search finds page n; the run reads it, and after the third also an address no search found.
    provider.found = (request) => {
      const n = Number(/winter (\d+)/.exec(request.input)?.[1]);
      return { text: `Page ${n}: ${address(n)}`, webSearch: { queries: [`harbour winter ${n}`], results: [address(n)], cited: [] } };
    };
    const numbers = [1, 2, 3, 4, 5, 6];
    pi.gateway.script([
      ...numbers.flatMap((n) => [{ tool: `${FLUX}flux_web_search`, args: { query: `harbour winter ${n}` } }, { tool: `${FLUX}flux_read_web`, args: { url: address(n) } },
        ...(n === 3 ? [{ tool: `${FLUX}flux_read_web`, args: { url: MADE_UP } }] : [])]),
      { text: 'The last boat leaves at 17:40.' },
    ]);
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'When is the last boat this winter?' });
    const processor = pi.processor(scene.connections, { caps: { maxTurns: 30 } });
    assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests.length, 14, '6 searches, 7 reads and the answer: more than the 5 searches the old limit allowed');
    assert.deepEqual(await hits(), ['/page/1', '/page/2', '/page/3', new URL(MADE_UP).pathname, '/page/4', '/page/5', '/page/6'], 'the 6 pages and the one no search found (#1065: any address opens)');
    assert.ok(!JSON.stringify(pi.gateway.requests.at(-1)!.results).includes('WEB_READ_'), 'nothing was refused');
    assert.equal(provider.requests.length, 6);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM personal_run_web_searches WHERE run_id = $1`, [started.run.id])).rows[0].n, 6);
    const { answer_body: body, charged_micros: charged } = (await pool.query(`SELECT answer_body, charged_micros FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0] as { answer_body: string; charged_micros: number };
    assert.equal(charged, 6 * (perRequest + WEB_SEARCH_MICROS), 'each search is charged as it was reported, on top of the tokens');
    assert.ok(body.includes('Searched the web for:\n- harbour winter 1\n- harbour winter 2') && body.includes(`Read on the web:\n- ${address(1)}\n- ${address(2)}`), body);
    assert.ok(body.includes(`- ${address(6)}`) && body.includes(`- ${MADE_UP}`), 'the 6th page and the address no search found are listed too');
  });

  test('a response of many searches is kept whole: its queries and results go into as many rows as they need', async () => {
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Research the harbour' });
    const queries = Array.from({ length: 25 }, (_, index) => `harbour query ${index}`);
    const results = Array.from({ length: 250 }, (_, index) => address(index));
    const kept = boundedWebSearch({ queries, results, cited: results.slice(0, 120) });
    assert.deepEqual([kept.queries.length, kept.results.length, kept.cited.length], [25, 250, 120], 'more than a handful of searches\' worth is not cut');
    await personalRunWebReadRows(db).addSearch(started.run.id, kept);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM personal_run_web_searches WHERE run_id = $1`, [started.run.id])).rows[0].n, 3, '25 queries and 250 results are 3 rows of the table\'s size');
    assert.equal((await pool.query(`SELECT sum(cardinality(results))::int AS n FROM personal_run_web_searches WHERE run_id = $1`, [started.run.id])).rows[0].n, 250, 'every result is kept');
    const listed = await personalRunWebReadRows(db).searches(started.run.id);
    assert.deepEqual([listed.queries.length, listed.cited.length], [25, 120]);
    await scene.runs.stop(human(scene.owner), started.run.id);
  });
});

describe('one operator switch for reading and searching, on by default (#954, C-29)', () => {
  test('FLUX_WEB_READS is on unless off, for the API\'s flux_read_web and the worker\'s search alike; anything else stops startup', () => {
    for (const env of [{}, { FLUX_WEB_READS: '' }, { FLUX_WEB_READS: 'on' }]) {
      assert.equal(loadWebReadsConfig(env).enabled, true, JSON.stringify(env));
      assert.equal(webSearchSwitch(env), true, JSON.stringify(env));
    }
    assert.equal(loadWebReadsConfig({ FLUX_WEB_READS: 'off' }).enabled, false);
    assert.equal(webSearchSwitch({ FLUX_WEB_READS: 'off' }), false);
    assert.throws(() => loadWebReadsConfig({ FLUX_WEB_READS: 'yes' }), /on or off/);
    assert.throws(() => webSearchSwitch({ FLUX_WEB_READS: 'yes' }), /on or off/);
  });

  test('the worker composes its provider with the switch: on by default, off when the operator says', () => {
    const env = { FLUX_TEST_PERSONAL_RUNS: 'anthropic-mock', FLUX_TEST_FAILURE_INJECTION: 'true', FLUX_TEST_ANTHROPIC_URL: 'http://providermock:8095' };
    assert.equal(personalRunWorkerComposition(env, db).compute.webSearch, true);
    assert.equal(personalRunWorkerComposition({ ...env, FLUX_WEB_READS: 'off' }, db).compute.webSearch, false);
  });

  test('with the switch off flux_read_web is not offered to a run', () => {
    const omitted: string[] = [];
    const registry = { run: true, omit: (name: string) => { omitted.push(name); }, forAccess: () => { throw new Error('nothing is registered'); } } as unknown as AgentToolRegistry;
    registerAgentWebReads(registry, db, { enabled: false } as never);
    assert.deepEqual(omitted, ['flux_read_web']);
  });
});
