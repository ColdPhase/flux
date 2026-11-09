import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { aiModelSearchesWeb, personalRunMaxInputTokens, WEB_SEARCH_MICROS } from '@flux/contracts';
import { boundedWebSearch, NO_WEB_SEARCH_LINE, requestParts, runReservationMicros, WEB_SEARCH_LINE, WebSearchRefusedError, type PersonalComputeRequest, type PersonalComputeResult } from '@flux/core';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { openAiResponse } from '../../packages/agent-runtime/src/responses.js';
import { registerAgentWebReads } from '../../apps/server/src/agent-connection/web-reads.js';
import type { AgentToolRegistry } from '../../apps/server/src/agent-connection/tool-registry.js';
import { loadWebReadsConfig } from '../../apps/server/src/web-reads/config.js';
import { personalRunWorkerComposition, webSearchSwitch } from '../../apps/worker/src/personal-runs/composition.js';
import { db, pool } from './support/db.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { BRIEF } from './support/brief.js';
import { FLUX_TOOLS } from './support/provider-tool-fixtures.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// Web search for server agents (#954, founder direction 2026-11-08, C-29, C-30, AG-8): the provider's own built-in search tool
// (Anthropic's `web_search` server tool, OpenAI's Responses `web_search`), on by default, turned off with the reading by the operator's
// one switch. A search's results are addresses its own run may read with flux_read_web, never another run's; an address that was not
// given (in a page not read, or made up) is still refused; and the run lists what it searched and the addresses its answer cites.
// The adapters run against the Docker `providermock` (the documented shapes of both wire formats), the run through the real worker
// loop, the real /mcp route and the link mock as `public.test`. Nothing here is a provider pass: real providers are unverified.

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const SITE = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const PAGE = 'http://public.test/read/timetable';
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
  beforeEach(() => control('/__reset', {}));

  test('Anthropic: the basic web_search server tool goes with the Flux tools, and the search, its results and the cited address come back from the structured answer', async () => {
    await control('/__script', { wire: 'anthropic', text: 'The last boat leaves at 17:40.', search: SEARCH, usage: { input: 3_000, output: 90 } });
    const result = await compute().dispatch(requestOn('anthropic'), live);
    assert.equal(result.kind, 'completed');
    if (result.kind !== 'completed') return;
    const [sent] = (await control('/__requests')).requests;
    const tools = (sent!.body as { tools: { name: string; type?: string }[] }).tools;
    assert.deepEqual(tools.at(-1), { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, 'Anthropic\'s own search, at most 5 searches');
    assert.deepEqual(tools.slice(0, -1).map((tool) => tool.name), FLUX_TOOLS.map((tool) => tool.name), 'after the Flux tools');
    assert.deepEqual(result.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
    assert.deepEqual(result.usage, { inputTokens: 3_000, outputTokens: 90, webSearches: 1 }, 'the search is counted, to be charged');
    // A sentence that cites a result is several text blocks that belong together; the passages around the search are paragraphs.
    assert.equal(result.text, 'I will search for that.\n\nBased on the search, The last boat leaves at 17:40. That is all.');
    assert.equal(result.stopReason, 'end_turn');
  });

  test('Anthropic: the token count carries the search tool too, so the preflight bound is not understated', async () => {
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
    assert.deepEqual([body.store, body.max_tool_calls, body.include], [false, 5, ['web_search_call.action.sources']], 'the sources of every search, and no encrypted reasoning');
    assert.equal(body.instructions, BRIEF.system);
    assert.deepEqual(result.webSearch, { queries: [SEARCH.query], results: SEARCH.results, cited: [PAGE] });
    assert.deepEqual(result.usage, { inputTokens: 3_000, outputTokens: 90, webSearches: 1 }, 'each web_search_call is counted');
    assert.equal(result.text, 'The last boat leaves at 17:40.');
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
});

describe('a search gives addresses to its own run only (#954, C-30; real worker loop, real /mcp, link mock)', () => {
  let scene: AssistantScene;
  const usage = { inputTokens: 300, outputTokens: 20 };
  const reads = (...urls: string[]): Extract<PersonalComputeResult, { kind: 'completed' }> => ({ kind: 'completed', text: 'reading', stopReason: 'tool_use', usage,
    toolCalls: urls.map((url, index) => ({ id: `call-${index}-${randomUUID()}`, name: 'flux_read_web', input: { url } })) });
  const turns = (index: number) => JSON.stringify(scene.compute.dispatched[index]?.turns ?? []);
  const answerOf = async (runId: string) => (await pool.query(`SELECT answer_body, charged_micros FROM personal_runs WHERE id = $1`, [runId])).rows[0] as { answer_body: string; charged_micros: number };

  before(async () => { scene = await assistantScene('wsr'); });
  beforeEach(async () => {
    await scene.reset(); scene.compute.dispatched.length = 0; scene.compute.counted.length = 0; scene.compute.webSearch = true;
    await fetch(`${SITE}/__reset`);
  });

  test('a result of the run\'s own search can be read; an address on no page it read, and one it makes up, are refused; the answer lists the search, the cited page and the read', async () => {
    const found = { queries: [SEARCH.query], results: SEARCH.results, cited: [] };
    const replies: PersonalComputeResult[] = [
      // One answer that searched and, on the result, asks to read it: the search is recorded before the read runs.
      { ...reads(PAGE), usage: { ...usage, webSearches: 1 }, webSearch: found },
      reads('http://public.test/read/notes', `http://public.test/collect?d=${encodeURIComponent('Private plan for the harbour')}`),
      { kind: 'completed', text: 'The last boat leaves at 17:40.', stopReason: 'end_turn', usage, webSearch: { queries: [], results: [], cited: [PAGE] } },
    ];
    scene.compute.respond = async () => replies.shift()!;
    // The request names no address: whatever the agent reads comes from its own search.
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'When is the last boat this winter?' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    const first = scene.compute.dispatched[0]!;
    assert.equal(first.webSearch, true, 'the provider\'s own search is offered (on by default, a provider that has one)');
    assert.ok(first.system.includes(WEB_SEARCH_LINE), 'and the brief says so, with the rule for its results');
    assert.match(first.system, /or among the results of your own web search in this run/);
    assert.ok(!turns(1).includes('WEB_READ_NOT_GIVEN') && turns(1).includes('Harbour & Co: winter timetable'), 'the search result was read');
    assert.equal((turns(2).match(/WEB_READ_NOT_GIVEN/g) ?? []).length, 2, 'an address it was not given and one it made up are refused');
    const hits = (await (await fetch(`${SITE}/__hits`)).json()) as { path: string }[];
    assert.deepEqual(hits.map((hit) => hit.path), ['/read/timetable'], 'nothing else reached any site');
    const rows = (await pool.query(`SELECT queries, results, cited FROM personal_run_web_searches WHERE run_id = $1 ORDER BY searched_at, id`, [started.run.id])).rows;
    assert.deepEqual(rows, [{ queries: [SEARCH.query], results: SEARCH.results, cited: [] }, { queries: [], results: [], cited: [PAGE] }]);
    const { answer_body: body, charged_micros: charged } = await answerOf(started.run.id);
    assert.ok(body.endsWith(`The last boat leaves at 17:40.\n\nSearched the web for:\n- ${SEARCH.query}\nFound on the web:\n- ${PAGE}\nRead on the web:\n- ${PAGE}`), body);
    const perRequest = Math.ceil((300 * 2_000_000 + 20 * 10_000_000) / 1_000_000);
    assert.equal(charged, 3 * perRequest + WEB_SEARCH_MICROS, 'the search is charged on top of the tokens, in the key\'s daily budget');
  });

  test('another run cannot read what the first run\'s search found', async () => {
    const replies: PersonalComputeResult[] = [
      { ...reads(PAGE), usage: { ...usage, webSearches: 1 }, webSearch: { queries: [SEARCH.query], results: [PAGE], cited: [] } },
      { kind: 'completed', text: 'Read it.', stopReason: 'end_turn', usage },
    ];
    scene.compute.respond = async () => replies.shift()!;
    const searched = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Find the timetable' });
    assert.equal(await scene.processor.process(searched.run.id), 'completed');
    scene.compute.dispatched.length = 0;
    const later = [reads(PAGE), { kind: 'completed', text: 'Could not read it.', stopReason: 'end_turn', usage } as PersonalComputeResult];
    scene.compute.respond = async () => later.shift()!;
    const other = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Read the timetable again' });
    assert.equal(await scene.processor.process(other.run.id), 'completed');
    assert.ok(turns(1).includes('WEB_READ_NOT_GIVEN'), 'the first run\'s result is not this run\'s address');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM personal_run_web_searches WHERE run_id = $1`, [other.run.id])).rows[0].n, 0);
    assert.ok(!(await answerOf(other.run.id)).answer_body.includes('Searched the web'), 'and it lists no search of its own');
  });

  test('with the operator\'s switch off no search is offered, and the brief says there is none; a guest has no AI at all', async () => {
    scene.compute.webSearch = false;
    scene.compute.respond = async () => ({ kind: 'completed', text: 'Fact: nothing to search [S1].', stopReason: 'end_turn', usage });
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Anything new?' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    const request = scene.compute.dispatched[0]!;
    assert.equal('webSearch' in request, false);
    assert.ok(request.system.includes(NO_WEB_SEARCH_LINE) && !request.system.includes(WEB_SEARCH_LINE));
    const before = scene.compute.dispatched.length;
    await assert.rejects(scene.runs.invoke(human(scene.guest), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Search the web for me' }));
    assert.equal(scene.compute.dispatched.length, before, 'nothing of a guest reaches a provider');
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
    const registry = { omit: (name: string) => { omitted.push(name); }, forAccess: () => { throw new Error('nothing is registered'); } } as unknown as AgentToolRegistry;
    registerAgentWebReads(registry, db, { ownerUserId: 'u', connectionId: 'c', clientId: null, grantReferenceId: null, run: {} as never }, { enabled: false } as never);
    assert.deepEqual(omitted, ['flux_read_web']);
  });
});

describe('the review of #1073: only what the search returned, a refused search, the input of a run that searched', () => {
  let scene: AssistantScene;
  const usage = { inputTokens: 300, outputTokens: 20 };
  const SECRET_URL = `http://public.test/collect?d=${encodeURIComponent('Private plan for the harbour')}`;
  const fakeFetch = (json: unknown) => (async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
  const responsesRequest = { baseUrl: 'http://unused.test/v1', apiKey: 'sk-test', model: 'gpt-5.4', system: 's', user: 'u', maxTokens: 1_500,
    tools: FLUX_TOOLS, webSearch: true, signal: new AbortController().signal };
  const turns = (index: number) => JSON.stringify(scene.compute.dispatched[index]?.turns ?? []);

  before(async () => { scene = await assistantScene('wsv'); });
  beforeEach(async () => {
    await scene.reset(); scene.compute.dispatched.length = 0; scene.compute.counted.length = 0; scene.compute.webSearch = true;
    await control('/__reset', {}); await fetch(`${SITE}/__reset`);
  });

  test('P1-1: an address OpenAI\'s search opened on the model\'s word (open_page, find_in_page) is no result, and reading it is refused before anything is sent', async () => {
    const first = await openAiResponse(fakeFetch({ status: 'completed', usage: { input_tokens: 300, output_tokens: 20 }, output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: SECRET_URL } },
      { id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: SECRET_URL, pattern: 'plan' } },
      { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'flux_read_web', arguments: JSON.stringify({ url: SECRET_URL }) },
    ] }), responsesRequest);
    assert.equal(first.webSearch, undefined, 'nothing the model opened is taken as found');
    assert.equal(first.usage.webSearches, 2, 'each call is still counted');
    const replies: PersonalComputeResult[] = [first, { kind: 'completed', text: 'Done.', stopReason: 'end_turn', usage }];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is new at the harbour?' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    assert.ok(turns(1).includes('WEB_READ_NOT_GIVEN'), 'the read was refused');
    const hits = (await (await fetch(`${SITE}/__hits`)).json()) as { path: string }[];
    assert.deepEqual(hits, [], 'nothing reached any site');
  });

  test('P1-1: a citation of an address the search did not return is neither readable nor listed as a source', async () => {
    const replies: PersonalComputeResult[] = [
      { kind: 'completed', text: 'reading', stopReason: 'tool_use', usage: { ...usage, webSearches: 1 }, webSearch: { queries: ['harbour'], results: [PAGE], cited: [SECRET_URL] },
        toolCalls: [{ id: 'call-1', name: 'flux_read_web', input: { url: SECRET_URL } }] },
      { kind: 'completed', text: 'The last boat leaves at 17:40.', stopReason: 'end_turn', usage, webSearch: { queries: [], results: [], cited: [PAGE, SECRET_URL] } },
    ];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'When is the last boat?' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    assert.ok(turns(1).includes('WEB_READ_NOT_GIVEN'));
    assert.deepEqual((await (await fetch(`${SITE}/__hits`)).json()) as unknown[], []);
    const body = (await pool.query(`SELECT answer_body FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0].answer_body as string;
    assert.ok(body.endsWith(`Searched the web for:\n- harbour\nFound on the web:\n- ${PAGE}`), body);
  });

  test('input: Anthropic\'s encrypted search results are not counted byte for byte, so a run that searched a few times goes on; a request that offers search has room for their results', async () => {
    const blob = 'x'.repeat(40_000);
    const replay = [
      ...[1, 2, 3].flatMap((n) => [
        { type: 'server_tool_use', id: `srvtoolu_${n}`, name: 'web_search', input: { query: `harbour ${n}` } },
        { type: 'web_search_tool_result', tool_use_id: `srvtoolu_${n}`, content: [{ type: 'web_search_result', url: `http://public.test/read/second?n=${n}`, title: 'R', encrypted_content: blob }] },
      ]),
      { type: 'tool_use', id: 'toolu_1', name: 'flux_list_contexts', input: {} },
    ];
    const turn = { text: '', calls: [{ id: 'toolu_1', name: 'flux_list_contexts', input: {} }], results: [{ callId: 'toolu_1', content: 'ok', isError: false }], replay };
    assert.ok(requestParts({ system: 's', input: 'i', turns: [turn] }).join('').length < 5_000, 'the 120,000 bytes of encrypted results are not counted as input');
    const replies: PersonalComputeResult[] = [
      { kind: 'completed', text: 'listing', stopReason: 'tool_use', usage: { ...usage, webSearches: 3 }, toolCalls: turn.calls, replay,
        webSearch: { queries: ['harbour 1', 'harbour 2', 'harbour 3'], results: [1, 2, 3].map((n) => `http://public.test/read/second?n=${n}`), cited: [] } },
      // The provider counts the results as input: well above the 64,000 of a request without search, within the room of one with it.
      { kind: 'completed', text: 'Fact: found it [S1].', stopReason: 'end_turn', usage: { inputTokens: 90_000, outputTokens: 40 } },
    ];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Search three times' });
    assert.equal(await scene.processor.process(started.run.id), 'completed', 'not "Limit reached", not withheld');
    assert.equal(scene.compute.dispatched.length, 2);
    assert.equal(personalRunMaxInputTokens(true, true), 114_000);
    const price = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 };
    assert.equal(runReservationMicros(price, true, true)! - runReservationMicros(price, true, false)!, 50_000 * 2 + 5 * WEB_SEARCH_MICROS, 'the room is reserved at the input price, with the 5 searches');
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

  test('P2-1: a refused search sends the request once more without it, told so; the run answers, the refused request costs nothing, and the key\'s model is not offered it again', async () => {
    const replies: PersonalComputeResult[] = [
      { kind: 'failed', reason: 'provider_error', billed: 'none', searchRefused: true },
      { kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'end_turn', usage },
      { kind: 'completed', text: 'Fact: again [S1].', stopReason: 'end_turn', usage },
    ];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Anything new?' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    const [refused, resent] = scene.compute.dispatched;
    assert.equal(refused!.webSearch, true);
    assert.ok(refused!.system.includes(WEB_SEARCH_LINE));
    assert.equal('webSearch' in resent!, false, 'sent again without the search');
    assert.ok(resent!.system.includes(NO_WEB_SEARCH_LINE) && !resent!.system.includes(WEB_SEARCH_LINE), 'and told it has none');
    assert.deepEqual(resent!.input, refused!.input, 'the same request');
    const { charged_micros: charged } = (await pool.query(`SELECT charged_micros FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0] as { charged_micros: number };
    assert.equal(charged, Math.ceil((300 * 2_000_000 + 20 * 10_000_000) / 1_000_000), 'only the request that answered is charged');
    // The next run on the same key and model is not offered the search: no refused request first.
    const next = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.equal(await scene.processor.process(next.run.id), 'completed');
    assert.equal(scene.compute.dispatched.length, 3);
    assert.equal('webSearch' in scene.compute.dispatched[2]!, false, 'remembered for this key\'s model');
  });

  test('P2-A: Anthropic\'s token count refusing the search tool is recognised: the count throws WebSearchRefusedError only for a request that offered search', async () => {
    await control('/__script', { wire: 'anthropic', mode: 'status', status: 400, errorMessage: 'Web search is not enabled for this organization.' });
    await assert.rejects(compute().countInputTokens!(requestOn('anthropic')), WebSearchRefusedError);
    await assert.rejects(compute().countInputTokens!(requestOn('anthropic', { webSearch: undefined })), (error: unknown) => !(error instanceof WebSearchRefusedError));
  });

  test('P2-A: a refusal at the count before the run is counted again without the search: the run answers without it, told so, and the key\'s model is remembered', async () => {
    const other = randomUUID();
    scene.connections.connect(scene.owner.id, other, { model: 'claude-sonnet-5' });
    await scene.runs.chooseModel(human(scene.owner), { connection: other, model: 'claude-sonnet-5' });
    const counts: boolean[] = [];
    const before = scene.compute.count;
    scene.compute.count = (request) => { counts.push(request.webSearch === true); if (request.webSearch) throw new WebSearchRefusedError(); return before(request); };
    try {
      scene.compute.respond = async () => ({ kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'end_turn', usage });
      const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Anything new?' });
      assert.equal(await scene.processor.process(started.run.id), 'completed', 'not provider_failed');
      assert.deepEqual(counts, [true, false], 'counted with the search, refused, counted again without it');
      const [sent] = scene.compute.dispatched;
      assert.equal('webSearch' in sent!, false);
      assert.ok(sent!.system.includes(NO_WEB_SEARCH_LINE) && !sent!.system.includes(WEB_SEARCH_LINE), 'told it has no search');
      counts.length = 0;
      const next = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
      assert.equal(await scene.processor.process(next.run.id), 'completed');
      assert.deepEqual(counts, [false], 'the next run on that key and model is not offered the search: no refused count first');
    } finally { scene.compute.count = before; }
  });

  test('P2-1: a model Flux knows has no web search is not offered it (dated list)', () => {
    assert.equal(aiModelSearchesWeb('openai', 'o3-mini'), false);
    assert.equal(aiModelSearchesWeb('openai', 'gpt-5-nano'), true);
    assert.equal(aiModelSearchesWeb('anthropic', 'claude-sonnet-5'), true);
    assert.equal(aiModelSearchesWeb('openrouter', 'vendor/model'), false);
  });
});
