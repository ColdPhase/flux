import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NEEDS_YOU_PATH, type NeedsYouResponse } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, project as createProject } from './support/people.js';
import { assistantScene, changesOf, text, type AssistantScene } from './support/assistant-scene.js';

// An agent copies the cite marks of its tool results (`[task:ID]`, C-62) into what it writes. In its answer they become numbered sources; in a change
// (a decision's reasons, its title, a task, a page) they named every reader an id (v0.2.1 real-model gate rows 28 and 37). A change's words now name
// what a mark cites as a person writes it in that space (`#12`, `[[Page]]`, a decision's title), and nothing of a message or of another space. The run
// is the scene's own, through the real `/mcp` route with its token; no model is called.

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('cite marks in what an agent writes (C-62, v0.2.1 real-model gate)', () => {
  let scene: AssistantScene;
  before(async () => { scene = await assistantScene('cite'); });
  after(async () => { await scene.setMayDo('act'); });

  async function objects() {
    const task = await scene.task(scene.owner, 'Order 200 printed flyers');
    const page = await scene.doc(scene.owner, 'Fair contacts');
    const earlier = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${scene.place.id}/decisions`, { body: { title: 'Shop opens at 6:30' } }), 201) as { id: string };
    const message = (await pool.query('SELECT id FROM project_messages WHERE conversation_id = $1 ORDER BY sequence LIMIT 1', [scene.thread.id])).rows[0].id as string;
    const other = await createProject(scene.lead, scene.ws.id, `Elsewhere ${Date.now()}`, 'restricted');
    const outside = await scene.task(scene.lead, 'A task of another space', other.id);
    const rationale = `Why 200:\n- It fits the budget [message:${message}] and #${task.number} is the order [task:${task.id}].\n`
      + `- [[Fair contacts]] names it [doc:${page.id}].\n- Not as [decision:${earlier.id}] said.\n- Elsewhere [task:${outside.id}].`;
    const readable = `Why 200:\n- It fits the budget and #${task.number} is the order.\n- [[Fair contacts]] names it.\n- Not as “Shop opens at 6:30” said.\n- Elsewhere.`;
    return { task, page, rationale, readable };
  }

  test('a decision\'s title and reasons name a task, a page and a decision of the space in words, and never an id', async () => {
    await scene.setMayDo('act');
    const { task, rationale, readable } = await objects();
    const live = await scene.liveRun();
    const made = JSON.parse(text((await live.call('flux_propose_decision', { decision: { title: `Print 200 flyers [task:${task.id}]`, rationale } })).message)) as { decisionId: string };
    assert.ok(made.decisionId);
    await scene.complete(live.runId);
    const decision = expectStatus(await scene.peer.browser.request('GET', `/api/v1/decisions/${made.decisionId}`), 200) as { title: string; rationale: string };
    assert.equal(decision.title, `Print 200 flyers #${task.number}`);
    assert.equal(decision.rationale, readable);
    assert.doesNotMatch(`${decision.title} ${decision.rationale}`, ID);
    // The Inbox's one line of the reasons is plain words: no `[[`, no id.
    const inbox = expectStatus(await scene.owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    const item = inbox.items.find((entry) => entry.key === `decision:${made.decisionId}`);
    assert.ok(item, 'the agent\'s decision waits for its owner');
    assert.equal(item.detail, `Why 200: - It fits the budget and #${task.number} is the order. - Fair contacts names it. - Not as “Shop opens at 6:30” said. - Elsewhere.`);
  });

  test('a change that waits for the owner\'s OK keeps the readable words, and Approve writes them', async () => {
    await scene.setMayDo('ask');
    const { rationale, readable } = await objects();
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_propose_decision', { decision: { title: 'Print 300 flyers', rationale } })).message), /^Waiting for /);
    const [held] = await changesOf(live.runId);
    const saved = (await pool.query('SELECT prepared_command FROM assistant_changes WHERE id = $1', [held!.id])).rows[0].prepared_command as { args: { decision: { rationale: string } } };
    assert.equal(saved.args.decision.rationale, readable);
    assert.doesNotMatch(JSON.stringify(saved), /\[(task|doc|decision|message):/);
  });
});
