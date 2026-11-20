import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { dmAiOffPath, dmAssistantRunsPath, dmPath, type Dm, type DmSummary, type SearchResponse } from '@flux/contracts';
import { pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { expectStatus, type Person } from './support/people.js';
import { assistantScene, human, result, type AssistantScene, type Message } from './support/assistant-scene.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';

// C-73 (#1591, founder decisions 2026-11-20): a person's agent reads their direct messages from its private chat, and leaves the AG-4 line
// "Hubert used AI here (Claude)" once for that run in each it read; any participant turns AI off in a direct message, it stays off while
// anyone keeps it, each withdraws only their own, and while it is off no agent of anyone reads the conversation by any path: `/ai`, the
// private chat's search, read around, summaries, a local client over MCP, a run already in flight. People's own search still finds it. An
// API-key agent runs in pi; its model is a scripted stand-in for Flux's model gateway, which records every model request it is sent.

const rename = (who: Person, name: string) => pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', [name, who.id]);
type Hit = { kind: string; id: string; place: { type: string; id: string } | null; snippet?: string; title?: string };
type Found = { results: Hit[] };

describe('AI off in a direct message, and the private chat reading its owner\'s direct messages (C-73, #1591)', () => {
  let scene: AssistantScene;
  let pi: PiRuntime;
  let hubert: Person; let marek: Person;
  let dm: string; let invoice: string; let fileId: string;
  const INVOICE = 'Faktura FV-8841 za lampy wysłana, termin płatności piątek.';
  const FILE_WORD = 'SZAFIR7788';

  const offBy = async (who: Person) => ((expectStatus(await who.browser.request('GET', dmPath(dm)), 200) as Dm).aiOff ?? []).map((person) => person.id);
  const turn = async (who: Person, off: boolean) => expectStatus(await who.browser.request(off ? 'PUT' : 'DELETE', dmAiOffPath(dm)), 200) as DmSummary;
  const lines = async () => (await pool.query(`SELECT kind, author_id, body, client_message_id FROM dm_messages WHERE dm_id = $1 AND kind <> 'text' ORDER BY sequence`, [dm])).rows as
    { kind: string; author_id: string; body: string; client_message_id: string }[];
  const chatRun = async () => (await scene.runs.invoke(human(hubert), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Znajdź fakturę od Marka' })).run.id;
  const dmRun = async () => (await scene.runs.invoke(human(hubert), { kind: 'dm', dmId: dm, threadRootId: null }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Podsumuj' })).run.id;
  const value = (message: Message) => toolValue(message) as unknown as Found;
  const refused = (message: Message) => !!message?.error || result(message)?.isError === true;

  before(async () => {
    pi = await startPiRuntime();
    scene = await assistantScene('dmai', { pi });
    hubert = scene.owner; marek = scene.peer;
    await rename(hubert, 'Hubert Osa'); await rename(marek, 'Marek Lis');
    const opened = await hubert.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [marek.id] } });
    assert.ok(opened.status === 201 || opened.status === 200, opened.text);
    dm = (opened.json as { id: string }).id;
    invoice = (expectStatus(await marek.browser.request('POST', `${dmPath(dm)}/messages`, { body: { body: INVOICE, clientMessageId: randomUUID() } }), 201) as { id: string }).id;
    // The text of a file Marek sent there, as #1590 indexes it: a search row of the conversation's own audience (`dm:<id>`, no space).
    fileId = randomUUID();
    await pool.query(`SELECT search_put($1, 'file', $2, $3, NULL, $4, $5, 1, NULL, 'faktura.pdf', $6, 'human', $7, now())`,
      [`file:${fileId}:1`, scene.ws.id, `dm:${dm}`, fileId, dm, `Numer konta do przelewu ${FILE_WORD}.`, marek.id]);
  });
  beforeEach(async () => {
    await scene.reset();
    await pool.query('DELETE FROM dm_ai_off WHERE dm_id = $1', [dm]);
    await pool.query(`DELETE FROM dm_messages WHERE dm_id = $1 AND kind <> 'text'`, [dm]);
  });
  after(async () => { await pi.close(); });

  test('with AI on, the private chat finds a word of a DM and of a file sent there, reads around it, and the DM shows the line once for the run', async () => {
    const live = await scene.liveOf(await chatRun());
    const found = value((await live.call('flux_search', { q: 'FV-8841 faktura' })).message);
    assert.ok(found.results.some((hit) => hit.id === invoice && hit.place?.type === 'dm' && hit.place.id === dm), JSON.stringify(found));
    const file = value((await live.call('flux_search', { q: FILE_WORD })).message);
    assert.ok(file.results.some((hit) => hit.kind === 'file' && hit.id === fileId && JSON.stringify(hit).includes(FILE_WORD)), JSON.stringify(file));
    const around = toolValue((await live.call('flux_read_around', { messageId: invoice })).message) as { dmId: string; messages: { body: string }[] };
    assert.deepEqual([around.dmId, around.messages.map((message) => message.body)], [dm, [INVOICE]]);
    const digest = toolValue((await live.call('flux_summarize', { in: dm, after: '2020-01-01' })).message) as { place: { type: string; id: string }; messages: number };
    assert.deepEqual([digest.place.type, digest.place.id, digest.messages], ['dm', dm, 1]);
    // AG-4: one line for the run, however many times it read, by Hubert, naming the company; Marek sees it.
    const shown = await lines();
    assert.deepEqual(shown.map((line) => [line.kind, line.author_id, line.client_message_id]), [['ai_used', hubert.id, live.runId]]);
    const seen = (expectStatus(await marek.browser.request('GET', dmPath(dm)), 200) as Dm).messages.filter((message) => message.notice === 'ai_used');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.authorId, hubert.id);
    assert.ok(seen[0]!.body.length > 0, 'it names who receives the conversation');
    await scene.complete(live.runId);
  });

  test('with AI on, an API-key agent in pi finds the DM\'s word in its private chat: the result is in its model request', async () => {
    const runId = await chatRun();
    pi.gateway.requests.length = 0;
    pi.gateway.script([{ tool: 'mcp__flux__flux_search', args: { q: 'faktura FV-8841' } }, { text: 'Marek wysłał fakturę.' }]);
    assert.equal(await scene.processor!.process(runId), 'completed', JSON.stringify(pi.lastPi()));
    assert.ok(pi.gateway.requests[1]!.results.join('\n').includes(invoice), `the search result carried the DM to the model: ${pi.gateway.requests[1]!.results.join('\n')}`);
    assert.equal((await lines()).filter((line) => line.kind === 'ai_used' && line.client_message_id === runId).length, 1);
  });

  test('anyone turns AI off, it stays off while anyone keeps it, each withdraws only their own, and every change is a line', async () => {
    const off = await turn(marek, true);
    assert.deepEqual(off.aiOff?.map((who) => who.name), ['Marek Lis']);
    assert.deepEqual(await offBy(hubert), [marek.id], 'Hubert sees who turned it off');
    // Hubert cannot turn Marek's off back on: his DELETE withdraws only his own, which he has not set.
    await turn(hubert, false);
    assert.deepEqual(await offBy(hubert), [marek.id]);
    await turn(hubert, true);
    assert.deepEqual(await offBy(marek), [marek.id, hubert.id]);
    await turn(hubert, true);
    await turn(hubert, false);
    assert.deepEqual(await offBy(marek), [marek.id], 'Hubert took back his; Marek\'s stays');
    await turn(marek, false);
    assert.deepEqual(await offBy(marek), [], 'only Marek could turn his back on');
    assert.deepEqual((await lines()).map((line) => [line.kind, line.author_id, line.body]), [
      ['ai_off', marek.id, ''], ['ai_off', hubert.id, ''], ['ai_on', hubert.id, 'Marek'], ['ai_on', marek.id, '']], 'a line for each change, none for a repeat');
    // Someone who is not in it gets the conversation's 404.
    assert.equal((await scene.outsider.browser.request('PUT', dmAiOffPath(dm))).status, 404);
    // Leaving the conversation takes the person's choice with it.
    await turn(marek, true);
    await pool.query('DELETE FROM dm_participants WHERE dm_id = $1 AND user_id = $2', [dm, marek.id]);
    try { assert.equal((await pool.query('SELECT 1 FROM dm_ai_off WHERE dm_id = $1', [dm])).rowCount, 0); }
    finally { await pool.query('INSERT INTO dm_participants (workspace_id, dm_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [scene.ws.id, dm, marek.id]); }
  });

  test('with AI off by Marek: Hubert\'s /ai is refused, his private chat finds nothing of the DM in any model request, his MCP client reads none, and people still find it', async () => {
    await turn(marek, true);
    // `/ai` in the DM and in its threads.
    const ask = await hubert.browser.request('POST', dmAssistantRunsPath(dm), { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Podsumuj' } });
    assert.equal(ask.status, 409, ask.text);
    assert.equal((ask.json as { code: string }).code, 'DM_AI_OFF');
    assert.match((ask.json as { error?: string; message?: string }).error ?? (ask.json as { message?: string }).message ?? '', /turned off by Marek/);
    await assert.rejects(dmRun(), (error: { code?: string }) => error.code === 'DM_AI_OFF');
    // The private chat, through pi: a search, a read around the invoice and a summary of the DM, and nothing of it in any model request.
    const runId = await chatRun();
    pi.gateway.requests.length = 0;
    pi.gateway.script([{ tool: 'mcp__flux__flux_search', args: { q: 'FV-8841 faktura' } }, { tool: 'mcp__flux__flux_search', args: { q: FILE_WORD } },
      { tool: 'mcp__flux__flux_read_around', args: { messageId: invoice } }, { tool: 'mcp__flux__flux_summarize', args: { in: dm, after: '2020-01-01' } },
      { text: 'Nie znalazłem faktury.' }]);
    assert.equal(await scene.processor!.process(runId), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests.length, 5);
    // What every model request carried: the brief, the system text and each tool result.
    const sent = JSON.stringify(pi.gateway.requests.map((request) => [request.system, request.prompt, request.results]));
    for (const word of ['FV-8841', FILE_WORD, 'termin płatności']) assert.ok(!sent.includes(word), `${word} reached a model request`);
    assert.equal((await lines()).filter((line) => line.kind === 'ai_used').length, 0, 'nothing was read, so no line');
    // The same calls on a live token, and the owner's own Claude Code over MCP.
    const live = await scene.liveOf(await chatRun());
    assert.deepEqual(value((await live.call('flux_search', { q: 'FV-8841 faktura' })).message).results.filter((hit) => hit.place?.type === 'dm'), []);
    assert.ok(refused((await live.call('flux_search', { q: 'faktura', in: dm })).message), 'nor may it name the DM');
    assert.ok(refused((await live.call('flux_read_around', { messageId: invoice })).message));
    assert.ok(refused((await live.call('flux_summarize', { in: dm, after: '2020-01-01' })).message));
    await scene.complete(live.runId);
    const code = (expectStatus(await hubert.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, hubert.browser, code, [scene.place.id]);
    let id = 1;
    const viaClient = (name: string, args: Record<string, unknown>) => mcp(client.accessToken, ++id, 'tools/call', { name, arguments: args });
    assert.ok(!JSON.stringify((await viaClient('flux_search', { q: 'FV-8841 faktura' })).message).includes('FV-8841'));
    assert.ok(refused((await viaClient('flux_read_around', { messageId: invoice })).message));
    assert.ok(refused((await viaClient('flux_summarize', { in: dm, after: '2020-01-01' })).message));
    // People's own search is local and calls no model: both still find the message and the file's text.
    for (const who of [hubert, marek]) {
      const found = expectStatus(await who.browser.request('GET', `/api/v1/search?q=${encodeURIComponent('faktura')}`), 200) as SearchResponse;
      assert.ok(JSON.stringify(found).includes(invoice), 'people find the message');
    }
    // Back on when Marek withdraws: the private chat reads it again.
    await turn(marek, false);
    const again = await scene.liveOf(await chatRun());
    assert.ok(value((await again.call('flux_search', { q: 'faktura FV-8841' })).message).results.some((hit) => hit.id === invoice));
    await scene.complete(again.runId);
  });

  test('a turn-off stops what is in flight: a run in the DM and a private chat\'s run that read it are refused at their next call and asked to stop', async () => {
    const stopped = async (runId: string) => (await pool.query('SELECT stop_requested_at, run_token_closed_at FROM personal_runs WHERE id = $1', [runId])).rows[0] as
      { stop_requested_at: Date | null; run_token_closed_at: Date | null };
    // One run of the owner's works at a time: each in turn.
    for (const start of [dmRun, chatRun]) {
      const live = await scene.liveOf(await start());
      assert.ok(value((await live.call('flux_search', { q: 'faktura FV-8841' })).message).results.some((hit) => hit.id === invoice));
      await turn(marek, true);
      const next = (await live.call('flux_search', { q: 'lampy' })).message;
      assert.ok(refused(next), JSON.stringify(next));
      assert.ok(!JSON.stringify(next).includes('FV-8841'));
      const row = await stopped(live.runId);
      assert.ok(row.stop_requested_at && row.run_token_closed_at, 'asked to stop, its token closed');
      await scene.complete(live.runId);
      await turn(marek, false);
    }
    // A private chat run that read nothing of it goes on, and still finds the spaces.
    const untouched = await scene.liveOf(await chatRun());
    assert.ok(!refused((await untouched.call('flux_search', { q: 'sensor' })).message));
    await turn(marek, true);
    assert.ok(!refused((await untouched.call('flux_search', { q: 'sensor' })).message), 'a run that read nothing of it is not stopped');
    assert.equal((await stopped(untouched.runId)).stop_requested_at, null);
    await scene.complete(untouched.runId);
  });

  test('a run in a space and a task never read a DM, and nothing of a DM reaches a run whose DM went off between its check and its brief', async () => {
    const inSpace = await scene.liveRun();
    assert.deepEqual(value((await inSpace.call('flux_search', { q: 'faktura FV-8841' })).message).results.filter((hit) => hit.place?.type === 'dm'), []);
    assert.ok(refused((await inSpace.call('flux_read_around', { messageId: invoice })).message));
    await scene.complete(inSpace.runId);
    // A DM run admitted while AI was on, then turned off before the worker took it: it ends as AI off and its model is never asked.
    const runId = await dmRun();
    await turn(marek, true);
    pi.gateway.requests.length = 0;
    pi.gateway.script([{ text: 'Podsumowanie.' }]);
    const outcome = await scene.processor!.process(runId);
    assert.notEqual(outcome, 'completed');
    assert.ok(!JSON.stringify(pi.gateway.requests.map((request) => [request.system, request.prompt, request.results])).includes('FV-8841'));
    const row = (await pool.query('SELECT status, end_reason FROM personal_runs WHERE id = $1', [runId])).rows[0] as { status: string; end_reason: string | null };
    assert.equal(row.end_reason, 'ai_off', JSON.stringify(row));
  });
});
