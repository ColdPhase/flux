import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { callSupervisor, parseSupervisorFrame, parseSupervisorRequest, type PlanModel, type SupervisorCallOutcome, type SupervisorRequest } from '@flux/runtime-protocol';
import { FAKE_CLAUDE_MODELS } from '../../apps/runtime/src/fakes/fake-models.js';
import { collectCodexModels, plainLine, reduceClaudeModels, reduceCodexModels } from '../../apps/runtime/src/supervisor/models.js';
import { Lane } from '../../apps/runtime/src/supervisor/server.js';
import { CLAUDE_MODELS_TEMPLATE } from '../../apps/runtime/src/supervisor/templates.js';
import { portOf, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// #1332 (F-022 amended): the models the signed-in CLI offers its account, read in the person's own slot. The shapes below are the pinned CLIs'
// own, captured account-free in Docker on 2026-11-12 (Claude Code 2.1.285's answer to a headless `initialize` control request; Codex 0.160.1's
// app-server `model/list`), trimmed to the fields Flux reads. The fake CLIs answer in the same shapes (apps/runtime/src/fakes).

const CLAUDE_CAPTURE = FAKE_CLAUDE_MODELS;
const codex = (id: string, displayName: string, description: string, extra: Record<string, unknown> = {}) =>
  ({ id, model: id, displayName, description, hidden: false, isDefault: false, inputModalities: ['text', 'image'], ...extra });
const CODEX_CAPTURE = [
  codex('gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', { isDefault: true }),
  codex('gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.'),
  codex('gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.'),
  codex('gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.'),
  codex('gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.'),
  codex('gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.'),
  codex('gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.'),
  codex('gpt-5.5', 'GPT-5.5', 'Legacy coding model.'),
];

describe('Claude Code\'s initialization answer as the plan\'s choices', () => {
  test('its aliases in its order, named as it names them, with no API price, no `default` entry and no Fable', () => {
    assert.deepEqual(reduceClaudeModels(CLAUDE_CAPTURE), [
      { id: 'opus', name: 'Opus 5.5', note: 'Best for everyday, complex tasks', default: true, seesPictures: true },
      { id: 'sonnet', name: 'Sonnet 5.5', note: 'Efficient for routine tasks', default: false, seesPictures: true },
      { id: 'haiku', name: 'Haiku 4.5', note: 'Fastest for quick answers', default: false, seesPictures: true },
    ]);
  });

  test('the account\'s default is the listed model `default` resolves to; none when that is Fable', () => {
    const resolvesToSonnet = CLAUDE_CAPTURE.map((entry) => (entry.value === 'default' ? { ...entry, resolvedModel: 'claude-sonnet-5-5' } : entry));
    assert.deepEqual(reduceClaudeModels(resolvesToSonnet).map((model) => [model.id, model.default]), [['opus', false], ['sonnet', true], ['haiku', false]]);
    const resolvesToFable = CLAUDE_CAPTURE.map((entry) => (entry.value === 'default' ? { ...entry, resolvedModel: 'claude-fable-5-1' } : entry));
    assert.deepEqual(reduceClaudeModels(resolvesToFable).map((model) => model.default), [false, false, false], 'the caller then takes the first');
    assert.deepEqual(reduceClaudeModels(CLAUDE_CAPTURE.filter((entry) => entry.value !== 'default')).map((model) => model.default), [false, false, false]);
  });

  test('Fable is dropped whatever field names it; ids a command could misread are dropped; repeats and over-long lists are cut', () => {
    const fable = [{ value: 'fable', displayName: 'Fable' }, { value: 'x1', resolvedModel: 'claude-fable-5-2', displayName: 'Other' }, { value: 'x2', displayName: 'Claude FABLE 6' }];
    const odd = ['--model', 'opus;id', 'Opus', 'sonnet[1m]', '../x', '', 'a b'].map((value) => ({ value, displayName: 'x' }));
    assert.deepEqual(reduceClaudeModels([...fable, ...odd, { value: 'opus', displayName: 'Opus' }, { value: 'opus', displayName: 'Again' }]).map((model) => model.id), ['opus']);
    const many = Array.from({ length: 200 }, (_, index) => ({ value: `m${index}`, displayName: `M${index}`, description: '' }));
    assert.equal(reduceClaudeModels(many).length, 64);
    for (const junk of [null, undefined, 'x', 7, {}, [null, 3, 'x']]) assert.deepEqual(reduceClaudeModels(junk), [], JSON.stringify(junk));
  });

  test('a description without a version part, a price only or a long text is reduced to one plain line', () => {
    const [bare] = reduceClaudeModels([{ value: 'opus', displayName: 'Opus', description: 'Everything\u0007 on\n one line · $4/$20 per Mtok' }]);
    assert.deepEqual([bare?.name, bare?.note], ['Opus', 'Everything on one line'], 'a description that is not a version is the note');
    const [priced] = reduceClaudeModels([{ value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · $1/$5 per Mtok' }]);
    assert.deepEqual([priced?.name, priced?.note], ['Haiku 4.5', '']);
    const [long] = reduceClaudeModels([{ value: 'opus', displayName: 'O'.repeat(500), description: `V · ${'n'.repeat(500)}` }]);
    assert.ok(long!.name.length <= 80 && long!.note.length <= 200);
    assert.equal(plainLine('  a \u0000 b\t\n c ', 10), 'a b c');
  });
});

describe('Codex\'s model/list as the plan\'s choices', () => {
  test('the visible models in its order under its names, its own default marked', () => {
    const models = reduceCodexModels(CODEX_CAPTURE);
    assert.deepEqual(models.map((model) => model.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
    assert.deepEqual(models[0], { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', note: 'Latest workhorse model for coding and everyday work.', default: true, seesPictures: true });
    assert.deepEqual(models.filter((model) => model.default).map((model) => model.id), ['gpt-6.1-sol']);
  });

  test('hidden models and Fable are not shown; a model without images says so; ids a command could misread are dropped', () => {
    const list = [codex('hidden-one', 'Hidden', '', { hidden: true }), codex('gpt-fable-1', 'GPT Fable', ''), codex('text-only', 'Text only', '', { inputModalities: ['text'] }),
      codex('--flag', 'Flag', ''), codex('Upper', 'Upper', ''), codex('gpt-6.1-sol', 'GPT-6.1-Sol', 'x'), codex('gpt-6.1-sol', 'Again', ''), 'junk', null];
    assert.deepEqual(reduceCodexModels(list).map((model) => [model.id, model.seesPictures]), [['text-only', false], ['gpt-6.1-sol', true]]);
    assert.deepEqual(reduceCodexModels([]), []);
  });

  test('every page is read by its cursor; a bad answer is an error, never a made-up list', async () => {
    const pages = [{ data: CODEX_CAPTURE.slice(0, 3), nextCursor: 'c1' }, { data: CODEX_CAPTURE.slice(3, 6), nextCursor: 'c2' }, { data: CODEX_CAPTURE.slice(6), nextCursor: null }];
    const asked: unknown[] = [];
    const entries = await collectCodexModels(async (method, params) => { asked.push([method, params]); return pages[asked.length - 1]; });
    assert.equal(entries.length, 8);
    assert.deepEqual(asked, [['model/list', { limit: 100 }], ['model/list', { limit: 100, cursor: 'c1' }], ['model/list', { limit: 100, cursor: 'c2' }]]);
    // A server that never stops paging is cut after a few pages.
    let endless = 0;
    assert.equal((await collectCodexModels(async () => { endless += 1; return { data: [CODEX_CAPTURE[0]], nextCursor: 'again' }; })).length, 5);
    assert.equal(endless, 5);
    for (const junk of [null, 'x', {}, { data: 'x' }, { nextCursor: null }]) await assert.rejects(collectCodexModels(async () => junk), /Not a model list/, JSON.stringify(junk));
  });
});

describe('the closed request set and its answer', () => {
  const bindingId = randomUUID();
  const base = { bindingId, bootId: randomUUID(), client: 'codex' };

  test('`models` names the binding, the supervisor\'s boot and a CLI, and nothing else', () => {
    assert.deepEqual(parseSupervisorRequest('models', base), { ok: true, request: { kind: 'models', ...base } });
    for (const bad of [{ ...base, extra: 1 }, { ...base, client: 'bash' }, { ...base, bootId: 'x' }, { ...base, bindingId: '../x' }, { bindingId, client: 'codex' }, { bindingId, bootId: base.bootId }]) {
      assert.equal(parseSupervisorRequest('models', bad).ok, false, JSON.stringify(bad));
    }
  });

  test('the answer is a closed list of plan models: at least one, no repeat, no extra key, no long text', () => {
    const model: PlanModel = { id: 'opus', name: 'Opus', note: 'x', default: true, seesPictures: true };
    const frame = (models: unknown) => parseSupervisorFrame({ t: 'result', result: { kind: 'models', client: 'claude_code', models } });
    assert.ok(frame([model]));
    for (const bad of [[], [model, model], [{ ...model, extra: 1 }], [{ ...model, id: '--x' }], [{ ...model, name: '' }], [{ ...model, name: 'n'.repeat(81) }], [{ ...model, note: 'n'.repeat(201) }],
      [{ ...model, default: 'yes' }], Array.from({ length: 65 }, (_, index) => ({ ...model, id: `m${index}` }))]) {
      assert.equal(frame(bad), null, JSON.stringify(bad).slice(0, 80));
    }
  });

  test('it takes the person\'s lane only when it is free, so it never waits behind a run (#1332)', async () => {
    const lane = new Lane();
    let release!: () => void;
    const held = lane.run(() => new Promise<void>((done) => { release = done; }));
    assert.equal(lane.tryRun(async () => 'read'), null, 'busy while something holds it');
    release();
    await held;
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(await lane.tryRun(async () => 'read'), 'read');
  });
});

describe('the supervisor reads the models of the signed-in CLI in the person\'s own directory', () => {
  let slot: TestSlot;
  const target = () => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
  const ask = (request: Omit<Extract<SupervisorRequest, { kind: 'models' }>, 'kind' | 'bootId'> & { bootId?: string }): Promise<SupervisorCallOutcome> =>
    callSupervisor(target(), { kind: 'models', bootId: slot.config.bootId, ...request }, { timeoutMs: 30_000 });
  const homeOf = (bindingId: string, client: 'claude_code' | 'codex') => join(slot.config.dataDir, bindingId, client === 'codex' ? 'codex' : 'claude');
  const callsOf = async (bindingId: string, client: 'claude_code' | 'codex') =>
    (await readFile(join(homeOf(bindingId, client), 'fake-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  async function bound() {
    const bindingId = randomUUID();
    assert.ok((await callSupervisor(target(), { kind: 'bind', bindingId })).ok);
    return bindingId;
  }
  const modelsOf = (outcome: SupervisorCallOutcome) => {
    assert.ok(outcome.ok && outcome.result.kind === 'models', JSON.stringify(outcome));
    return outcome.result.models;
  };

  before(async () => { slot = await startTestSlot(); });
  after(async () => { await slot.close(); });

  test('Claude Code: its headless initialization with the run\'s restrictions, read once, and the answer carries no Fable', async () => {
    const bindingId = await bound();
    const models = modelsOf(await ask({ bindingId, client: 'claude_code' }));
    assert.deepEqual(models.map((model) => [model.id, model.name, model.default]), [['opus', 'Opus 5.5', true], ['sonnet', 'Sonnet 5.5', false], ['haiku', 'Haiku 4.5', false]]);
    const asked = (await callsOf(bindingId, 'claude_code')).filter((entry) => entry.event === 'initialize');
    assert.equal(asked.length, 1);
    const call = (await callsOf(bindingId, 'claude_code')).find((entry) => Array.isArray(entry.argv) && (entry.argv as string[]).includes('--input-format')) as { argv: string[] };
    assert.deepEqual(call.argv, [...CLAUDE_MODELS_TEMPLATE], 'the fixed template, nothing from the request');
  });

  test('Codex: model/list without Flux\'s catalog, nothing else sent, hidden models left out, every page read', async () => {
    const bindingId = await bound();
    await writeFile(join(homeOf(bindingId, 'codex'), 'fake-model-page'), '1');
    const models = modelsOf(await ask({ bindingId, client: 'codex' }));
    assert.deepEqual(models.map((model) => model.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], 'the hidden one is not listed');
    assert.equal(models.find((model) => model.default)?.id, 'gpt-6.1-sol');
    const recorded = await callsOf(bindingId, 'codex');
    assert.deepEqual(recorded.filter((entry) => entry.event === 'app_server' && entry.method !== 'initialized').map((entry) => entry.method), ['initialize', 'model/list', 'model/list', 'model/list'], 'nothing else reached the app-server');
    const argv = (recorded.find((entry) => entry.event === 'app_server')!.argv as string[]);
    assert.ok(argv.includes('app-server') && !argv.some((value) => value.startsWith('model_catalog_json')), 'no catalog of Flux\'s on this session');
    assert.ok(argv.includes('features.plugins=false'), 'the reviewed features stay off');
  });

  test('a list the test seeds is what shows: a changed account, and a CLI that lists only Fable or nothing is not available', async () => {
    const bindingId = await bound();
    await writeFile(join(homeOf(bindingId, 'claude_code'), 'fake-models.json'), JSON.stringify([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5 · Quick' }]));
    assert.deepEqual(modelsOf(await ask({ bindingId, client: 'claude_code' })).map((model) => model.id), ['haiku']);
    await writeFile(join(homeOf(bindingId, 'claude_code'), 'fake-models.json'), JSON.stringify([{ value: 'claude-fable-5-1', displayName: 'Fable' }]));
    assert.deepEqual(await ask({ bindingId, client: 'claude_code' }), { ok: false, code: 'not_available' }, 'only Fable: nothing to offer');
    await writeFile(join(homeOf(bindingId, 'codex'), 'fake-models.json'), '[]');
    assert.deepEqual(await ask({ bindingId, client: 'codex' }), { ok: false, code: 'not_available' });
  });

  test('a CLI that cannot answer is `not_available`, and so is one whose list is not a list', async () => {
    const bindingId = await bound();
    for (const client of ['claude_code', 'codex'] as const) {
      await writeFile(join(homeOf(bindingId, client), 'fake-scenario'), 'models_unreadable');
      assert.deepEqual(await ask({ bindingId, client }), { ok: false, code: 'not_available' }, client);
      await writeFile(join(homeOf(bindingId, client), 'fake-scenario'), '');
    }
    await writeFile(join(homeOf(bindingId, 'claude_code'), 'fake-models.json'), JSON.stringify('nope'));
    assert.deepEqual(await ask({ bindingId, client: 'claude_code' }), { ok: false, code: 'not_available' });
    assert.ok(modelsOf(await ask({ bindingId, client: 'codex' })).length, 'a negative control: the other CLI still answers');
  });

  test('refused before any CLI starts: another boot, a CLI the operator did not list, no binding', async () => {
    const bindingId = await bound();
    assert.deepEqual(await ask({ bindingId, client: 'codex', bootId: randomUUID() }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await ask({ bindingId: randomUUID(), client: 'codex' }), { ok: false, code: 'no_binding' });
    const only = await startTestSlot({ enabled: ['codex'] });
    try {
      const id = randomUUID();
      const one = { host: '127.0.0.1', port: portOf(only.url), secret: only.config.secret };
      assert.ok((await callSupervisor(one, { kind: 'bind', bindingId: id })).ok);
      assert.deepEqual(await callSupervisor(one, { kind: 'models', bindingId: id, bootId: only.config.bootId, client: 'claude_code' }), { ok: false, code: 'client_off' });
      assert.ok((await callSupervisor(one, { kind: 'models', bindingId: id, bootId: only.config.bootId, client: 'codex' })).ok);
    } finally { await only.close(); }
    assert.deepEqual((await callsOf(bindingId, 'codex')).length, 0, 'the refused ones started nothing');
  });

  test('a missing CLI is `not_installed`', async () => {
    const without = await startTestSlot({ withClis: false });
    try {
      const id = randomUUID();
      const one = { host: '127.0.0.1', port: portOf(without.url), secret: without.config.secret };
      assert.ok((await callSupervisor(one, { kind: 'bind', bindingId: id })).ok);
      assert.deepEqual(await callSupervisor(one, { kind: 'models', bindingId: id, bootId: without.config.bootId, client: 'codex' }), { ok: false, code: 'not_installed' });
    } finally { await without.close(); }
  });
});
