import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createPersonalRunProcessor, type PersonalComputeRequest } from '@flux/core';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { mcpToolHost } from '../../apps/worker/src/personal-runs/mcp-session.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { PUBLIC_ONLY, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { expectStatus, type Person } from './support/people.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { chooseModel, FAKE_PRICE } from './support/personal-runs.js';
import { png } from './support/pictures.js';

// OPT-IN (#1217): the two picture journeys on a REAL model, Anthropic's Claude Sonnet 5.5 on an owner's API key, through the real worker loop,
// the real Anthropic adapter and the real /mcp route. It runs only when FLUX_EVAL_ANTHROPIC_KEY is in the test container's environment (passed
// by name, never as a value on a command line); without it every test is skipped. The stack's closed world stands: the picture to attach is
// the link mock's (`public.test`), linked in the conversation, and the provider's own web search is off, so the cost stays small (each run is
// a few requests; the connection's daily budget is 2 USD). Results are printed as RESULT lines; nothing of the key is printed.

const KEY = process.env.FLUX_EVAL_ANTHROPIC_KEY ?? '';
const MODEL = 'claude-sonnet-5-5';
const skip = KEY ? false : 'FLUX_EVAL_ANTHROPIC_KEY is not set';

async function upload(who: Person, projectId: string, name: string, body: Buffer): Promise<string> {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base),
    { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: new Uint8Array(body) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

describe('#1217 on a real model (Claude Sonnet 5.5, API key)', { skip }, () => {
  let scene: AssistantScene;
  let processor: ReturnType<typeof createPersonalRunProcessor>;
  const sent: PersonalComputeRequest[] = [];
  before(async () => {
    scene = await assistantScene('real');
    const connectionId = randomUUID();
    scene.connections.connect(scene.owner.id, connectionId, { provider: 'anthropic', model: MODEL, dailyBudgetCents: 200,
      price: { ...FAKE_PRICE } });
    await chooseModel(scene.runs, human(scene.owner), { connection: connectionId, model: MODEL }, scene.agentId);
    const real = providerPersonalCompute({ enabled: true, policy: PUBLIC_ONLY, webSearch: false, resolveKey: async () => KEY });
    // What was sent, to see that the picture went as image input (never printed: it holds only Flux's own words and the picture).
    const compute = { ...real, enabled: real.enabled, dispatch: (request: PersonalComputeRequest, signal: AbortSignal) => { sent.push(request); return real.dispatch(request, signal); },
      ...(real.countInputTokens ? { countInputTokens: real.countInputTokens.bind(real) } : {}) };
    const tokens = runTokenIssuer(db, apiUrl);
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: scene.connections, compute, stopPollMs: 50,
      tools: mcpToolHost(tokens, `${apiUrl}/mcp`), tokens });
  });

  const ask = async (prompt: string) => {
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
    const end = await processor.process(started.run.id);
    const run = (await pool.query(`SELECT status, answer_body, charged_micros, run_tools FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0] as
      { status: string; answer_body: string | null; charged_micros: number; run_tools: string[] };
    return { id: started.run.id, end, ...run };
  };

  test('vision: "what is in this picture?" on a photo a person posted is answered from the picture itself', async () => {
    const photo = await upload(scene.peer, scene.place.id, 'bed-layout.png', png(96, 64, { metadata: true }));
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`,
      { body: { body: 'Here is the layout I drew for the bed.', clientMessageId: randomUUID(), attachmentIds: [photo] } }), 201);
    const run = await ask('What\'s in the picture Jonas just posted? Describe its colours and pattern in one or two sentences.');
    const viewed = sent.flatMap((request) => request.turns ?? []).flatMap((turn) => turn.results).filter((result) => result.images?.length).length;
    console.log(`RESULT vision status=${run.status} end=${run.end} chargedMicros=${run.charged_micros} viewTool=${run.run_tools?.includes('flux_view_image')} looked=${viewed > 0}`);
    console.log(`RESULT vision answer=${JSON.stringify(run.answer_body)}`);
    assert.equal(run.status, 'completed');
    assert.ok(viewed > 0, 'the run called flux_view_image on the photo');
    assert.match((run.answer_body ?? '').toLowerCase(), /green/);
    assert.match((run.answer_body ?? '').toLowerCase(), /brown|tan|ochre|checker|grid|squares|chess/);
  });

  test('attach: "show the catalogue picture" attaches the linked picture, which Show everyone posts', async () => {
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`,
      { body: { body: 'The catalogue photo of the raised garden bed we liked is at http://public.test/pic/raised-bed.png', clientMessageId: randomUUID() } }), 201);
    const run = await ask('Find the picture of the raised garden bed from the catalogue link and show it to us.');
    const changes = (await pool.query(`SELECT state, object_title FROM assistant_changes WHERE run_id = $1 AND operation = 'answer.picture.attach'`, [run.id])).rows as
      { state: string; object_title: string }[];
    console.log(`RESULT attach status=${run.status} end=${run.end} chargedMicros=${run.charged_micros} changes=${JSON.stringify(changes)}`);
    console.log(`RESULT attach answer=${JSON.stringify(run.answer_body)}`);
    assert.equal(run.status, 'completed');
    assert.ok(changes.some((change) => change.state === 'applied'), 'a picture was attached');
    assert.ok(!/!\[[^\]]*\]\(/.test(run.answer_body ?? ''), 'no picture written in Markdown');
    const shown = expectStatus(await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${run.id}/show`), 200) as { messageId: string };
    const files = (await pool.query(`SELECT name FROM project_files WHERE message_id = $1`, [shown.messageId])).rows as { name: string }[];
    console.log(`RESULT attach shown files=${JSON.stringify(files.map((file) => file.name))}`);
    assert.equal(files.length, 1);
  });
});
