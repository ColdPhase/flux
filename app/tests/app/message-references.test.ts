import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, ConversationMessage, ConversationRootWindow, CreatedThought, Dm, DmMessage, Project, Sketch, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// Message references (#469, F-026 §6): a message cites a map thought or another message. Only the kind and the id are stored; the
// card (title, author, place, where it opens) is made for each reader after that reader's own access to the target is decided, so a
// reference never reveals a thought or a message its reader cannot read, whether the target is in another project, a direct message
// or a private sketch.

const REFUSED = { code: 'REFERENCE_UNAVAILABLE', status: 404 };

describe('message references', () => {
  let ada: Person;       // owns the workspace; reads everything below
  let jonas: Person;     // contributor on the open project; no grant on the restricted one
  let marek: Person;     // member with a contributor grant on the restricted project only
  let kai: Person;       // member of the workspace, in no DM and on no restricted project
  let dave: Person;      // owner of another workspace
  let ws: Workspace;
  let other: Workspace;
  let open: Project;       // workspace-visible: every member reads and writes it
  let secret: Project;     // restricted: Ada and Marek
  let dmAdaJonas: Dm;

  const sketch = async (who: Person, body: Record<string, unknown>, workspaceId = ws.id) =>
    expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { body }), 201, 'create sketch') as Sketch;
  const thought = async (who: Person, sketchId: string, text: string) =>
    (expectStatus(await who.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body: { text, x: 10, y: 10 } }), 201, 'add thought') as CreatedThought).thought;
  const start = async (who: Person, projectId: string, body: string, references?: unknown[]) =>
    who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID(), ...(references ? { references } : {}) } });
  const reply = async (who: Person, conversationId: string, body: string, references?: unknown[], clientMessageId = randomUUID()) =>
    who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId, ...(references ? { references } : {}) } });
  const started = async (who: Person, projectId: string, body: string, references?: unknown[]) =>
    expectStatus(await start(who, projectId, body, references), 201, 'start') as Conversation;
  const read = async (who: Person, conversationId: string) =>
    expectStatus(await who.browser.request('GET', `/api/v1/conversations/${conversationId}`), 200, 'read') as Conversation;
  const say = async (who: Person, dmId: string, body: string, references?: unknown[]) =>
    who.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID(), ...(references ? { references } : {}) } });

  before(async () => {
    [ada, jonas, marek, kai, dave] = await Promise.all(['ref-ada', 'ref-jonas', 'ref-marek', 'ref-kai', 'ref-dave'].map(person));
    ws = await workspace(ada, 'Community garden');
    other = await workspace(dave, 'Elsewhere');
    for (const member of [jonas, marek, kai]) await addMember(ada, ws.id, member, 'member');
    open = await project(ada, ws.id, 'Garden sensors', 'workspace');
    secret = await project(ada, ws.id, 'Board matters', 'restricted');
    await grant(ada, secret.id, marek, 'contributor');
    dmAdaJonas = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [jonas.id] } }), 201) as Dm;
  });

  test('a message cites a thought: the card is made for the reader, with its title, author, place and where it opens', async () => {
    const map = await sketch(ada, { title: 'Enclosure ideas', scope: 'project', projectId: open.id });
    const idea = await thought(ada, map.id, 'Solar panel on the enclosure?\nSecond line stays out of the title');
    const conversation = await started(jonas, open.id, 'What about this one?', [{ kind: 'thought', id: idea.id }]);
    const card = conversation.messages[0]!.references![0]!;
    assert.deepEqual(card, { kind: 'thought', state: 'available', title: 'Solar panel on the enclosure?', author: 'ref-ada', at: card.state === 'available' ? card.at : '',
      place: 'Enclosure ideas', target: { type: 'thought', sketchId: map.id, thoughtId: idea.id, dmId: null } });
    // The same card in the project's stream and the thread, for another reader of the project.
    const roots = expectStatus(await kai.browser.request('GET', `/api/v1/projects/${open.id}/conversation-roots`), 200) as ConversationRootWindow;
    assert.deepEqual(roots.roots.find((root) => root.conversationId === conversation.id)!.message.references, [card]);
    assert.deepEqual((await read(kai, conversation.id)).messages[0]!.references, [card]);
    const stored = await pool.query('SELECT kind, target_id, position FROM message_references WHERE project_message_id = $1', [conversation.messages[0]!.id]);
    assert.deepEqual(stored.rows, [{ kind: 'thought', target_id: idea.id, position: 0 }], 'only the kind and the id are stored, nothing of the target');
  });

  test('a reply cites a message of another project: its place is that project, and it opens that exact message', async () => {
    const root = await started(ada, secret.id, 'The deposit for the plot is due on the 12th.');
    const cited = root.messages[0]!;
    const thread = await started(ada, open.id, 'Start of the thread');
    const sent = expectStatus(await reply(ada, thread.id, 'See the board note', [{ kind: 'message', id: cited.id }]), 201) as ConversationMessage;
    assert.equal(sent.references![0]!.state, 'available');
    assert.deepEqual(sent.references![0], { kind: 'message', state: 'available', title: 'The deposit for the plot is due on the 12th.', author: 'ref-ada',
      at: (sent.references![0] as { at: string }).at, place: 'Board matters', target: { type: 'message', projectId: secret.id, conversationId: root.id, messageId: cited.id } });
    // Marek reads both projects; Jonas reads only the open one: for Jonas the card says nothing about the board note.
    const forMarek = (await read(marek, thread.id)).messages.at(-1)!;
    assert.equal(forMarek.references![0]!.state, 'available');
    const forJonas = (await read(jonas, thread.id)).messages.at(-1)!;
    assert.deepEqual(forJonas.references, [{ kind: 'message', state: 'unavailable' }]);
    assert.equal(JSON.stringify(forJonas).includes('deposit'), false);
    assert.equal(JSON.stringify(forJonas).includes(cited.id), false);
    assert.equal(JSON.stringify(forJonas).includes(secret.id), false);
  });

  test('the sender must be able to read the target now: every other answer is the same 404, so it tells nothing about the target', async () => {
    const root = await started(ada, secret.id, 'Only the board reads this');
    const map = await sketch(ada, { title: 'Private notes', scope: 'private' });
    const mine = await thought(ada, map.id, 'My own private thought');
    const body = (references: unknown[]) => ({ body: 'Trying to cite', clientMessageId: randomUUID(), references });
    const refused: string[] = [];
    // Jonas has no grant on the restricted project: its message, a thought of someone else's private sketch and an id that does not exist.
    for (const reference of [{ kind: 'message', id: root.messages[0]!.id }, { kind: 'thought', id: mine.id }, { kind: 'message', id: randomUUID() }, { kind: 'thought', id: randomUUID() }]) {
      const response = await jonas.browser.request('POST', `/api/v1/projects/${open.id}/conversations`, { body: body([reference]) });
      assert.equal(response.status, REFUSED.status, response.text);
      assert.equal((response.json as { code: string }).code, REFUSED.code);
      refused.push(response.text);
    }
    assert.equal(new Set(refused).size, 1, 'the four answers are identical');
    assert.equal(refused[0]!.includes(root.messages[0]!.id), false);
    // Another workspace's thought is not citable either, even by its own reader.
    const elsewhere = await sketch(dave, { title: 'Elsewhere map', scope: 'private' }, other.id);
    const foreign = await thought(dave, elsewhere.id, 'Another workspace');
    const foreignProject = await project(dave, other.id, 'Elsewhere project', 'workspace');
    const foreignMessage = ((await started(dave, foreignProject.id, 'Another workspace speaking')).messages[0]!).id;
    const absentAnswer = (await start(jonas, open.id, 'Cite absent', [{ kind: 'message', id: randomUUID() }])).text;
    for (const reference of [{ kind: 'thought', id: foreign.id }, { kind: 'message', id: foreignMessage }]) {
      const response = await start(jonas, open.id, 'Cite foreign', [reference]);
      assert.equal(response.status, 404);
      assert.equal(response.text, absentAnswer, 'another workspace\'s id answers exactly like an absent one');
    }
    assert.equal((await start(dave, open.id, 'Dave is not in this workspace', [])).status, 404);
    const crossWorkspace = await sketch(ada, { title: 'Mine', scope: 'private' });
    const own = await thought(ada, crossWorkspace.id, 'Mine');
    // A person cites their own private thought; nobody else sees it.
    const sent = await started(ada, open.id, 'Thinking about this one', [{ kind: 'thought', id: own.id }]);
    assert.equal(sent.messages[0]!.references![0]!.state, 'available');
    const forKai = await read(kai, sent.id);
    assert.deepEqual(forKai.messages[0]!.references, [{ kind: 'thought', state: 'unavailable' }]);
    assert.equal(JSON.stringify(forKai).includes('Mine'), false);
    assert.equal(JSON.stringify(forKai).includes(own.id), false);
  });

  test('access is decided again at every read: a revoked grant, a removed thought and an erased message turn the card unavailable', async () => {
    const map = await sketch(ada, { title: 'Board sketch', scope: 'project', projectId: secret.id });
    const idea = await thought(ada, map.id, 'Raise the fee by 5%');
    const root = await started(ada, secret.id, 'Fee discussion');
    const sent = expectStatus(await reply(marek, root.id, 'Citing the sketch and the root', [{ kind: 'thought', id: idea.id }, { kind: 'message', id: root.messages[0]!.id }]), 201) as ConversationMessage;
    assert.deepEqual(sent.references!.map((card) => card.state), ['available', 'available']);
    assert.deepEqual((await read(ada, root.id)).messages.at(-1)!.references!.map((card) => card.kind), ['thought', 'message'], 'in the order attached');
    // Marek's access goes: he no longer reads the project at all.
    await grant(ada, secret.id, marek, 'denied');
    expectStatus(await marek.browser.request('GET', `/api/v1/conversations/${root.id}`), 404);
    // The thought is removed from its map: the card is unavailable, the message beside it is not.
    await pool.query('DELETE FROM sketch_thoughts WHERE id = $1', [idea.id]);
    assert.deepEqual((await read(ada, root.id)).messages.at(-1)!.references!.map((card) => card.state), ['unavailable', 'available']);
    // The citing message owns its rows.
    await pool.query('DELETE FROM project_conversations WHERE id = $1', [root.id]);
    const left = await pool.query('SELECT count(*)::int AS n FROM message_references WHERE project_message_id = $1', [sent.id]);
    assert.equal(left.rows[0].n, 0);
  });

  test('a direct message is a target only for its participants, and it may cite too', async () => {
    const dmMessage = expectStatus(await say(ada, dmAdaJonas.id, 'Call me before you answer the landlord'), 201) as DmMessage;
    const conversation = await started(ada, open.id, 'Quoting our private chat', [{ kind: 'message', id: dmMessage.id }]);
    const card = conversation.messages[0]!.references![0]!;
    assert.deepEqual(card, { kind: 'message', state: 'available', title: 'Call me before you answer the landlord', author: 'ref-ada', at: (card as { at: string }).at,
      place: 'Direct message', target: { type: 'dm_message', dmId: dmAdaJonas.id, messageId: dmMessage.id } });
    // Jonas is in the DM, Kai is not: the same message, two cards.
    assert.equal((await read(jonas, conversation.id)).messages[0]!.references![0]!.state, 'available');
    const forKai = await read(kai, conversation.id);
    assert.deepEqual(forKai.messages[0]!.references, [{ kind: 'message', state: 'unavailable' }]);
    assert.equal(JSON.stringify(forKai).includes('landlord'), false);
    // Kai cannot cite what he cannot read.
    assert.equal((await start(kai, open.id, 'Cite the DM', [{ kind: 'message', id: dmMessage.id }])).status, 404);
    // A DM message cites a project message and a thought; each participant reads the cards through the DM's own route.
    const map = await sketch(ada, { title: 'Enclosure ideas', scope: 'project', projectId: open.id });
    const idea = await thought(ada, map.id, 'Vent on the north wall');
    const sent = expectStatus(await say(jonas, dmAdaJonas.id, 'Both of these', [{ kind: 'message', id: conversation.messages[0]!.id }, { kind: 'thought', id: idea.id }]), 201) as DmMessage;
    assert.deepEqual(sent.references!.map((item) => item.state), ['available', 'available']);
    const page = expectStatus(await ada.browser.request('GET', `/api/v1/dms/${dmAdaJonas.id}`), 200) as Dm;
    assert.deepEqual(page.messages.find((item) => item.id === sent.id)!.references, sent.references);
    // Marek reads none of the DM; and a reply thread in the DM carries cards too.
    expectStatus(await marek.browser.request('GET', `/api/v1/dms/${dmAdaJonas.id}`), 404);
    const threadReply = expectStatus(await ada.browser.request('POST', `/api/v1/dms/${dmAdaJonas.id}/threads/${sent.id}/replies`,
      { body: { body: 'In the thread', clientMessageId: randomUUID(), references: [{ kind: 'thought', id: idea.id }] } }), 201) as DmMessage;
    assert.equal(threadReply.references![0]!.state, 'available');
    const thread = expectStatus(await jonas.browser.request('GET', `/api/v1/dms/${dmAdaJonas.id}/threads/${sent.id}`), 200) as { root: DmMessage; replies: DmMessage[] };
    assert.equal(thread.root.references!.length, 2);
    assert.equal(thread.replies[0]!.references![0]!.state, 'available');
    // A thought in a DM's sketch opens inside the DM and is read by its participants only.
    const dmMap = await sketch(ada, { title: 'Our sketch', scope: 'dm', dmId: dmAdaJonas.id });
    const dmIdea = await thought(ada, dmMap.id, 'Ask the landlord about the roof');
    const cited = await started(ada, open.id, 'From our sketch', [{ kind: 'thought', id: dmIdea.id }]);
    const dmCard = cited.messages[0]!.references![0]!;
    assert.deepEqual(dmCard.state === 'available' ? dmCard.target : null, { type: 'thought', sketchId: dmMap.id, thoughtId: dmIdea.id, dmId: dmAdaJonas.id });
    assert.equal((await read(kai, cited.id)).messages[0]!.references![0]!.state, 'unavailable');
    assert.equal((await read(jonas, cited.id)).messages[0]!.references![0]!.state, 'available');
    // A person who leaves the DM no longer reads what it cited.
    expectStatus(await jonas.browser.request('POST', `/api/v1/dms/${dmAdaJonas.id}/leave`), 204);
    assert.equal((await read(jonas, cited.id)).messages[0]!.references![0]!.state, 'unavailable');
  });

  test('a task\'s discussion cites too, with the same rules, and its bound conversation shows the card', async () => {
    const map = await sketch(ada, { title: 'Task map', scope: 'project', projectId: open.id });
    const idea = await thought(ada, map.id, 'Vent on the north wall');
    const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${open.id}/work`, { body: { title: 'Check the vent' } }), 201) as { id: string };
    const contribute = (who: Person, references: unknown[], clientMessageId = randomUUID()) =>
      who.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: { body: 'See the map idea', clientMessageId, kind: 'text', references } });
    const first = expectStatus(await contribute(jonas, [{ kind: 'thought', id: idea.id }]), 201) as ConversationMessage;
    assert.deepEqual(first.references!.map((card) => [card.kind, card.state]), [['thought', 'available']]);
    const conversation = await read(ada, first.conversationId);
    assert.deepEqual(conversation.messages.at(-1)!.references, first.references, 'the bound conversation reads the same card');
    // The same refusal as everywhere else: Jonas cannot cite the board's message.
    const board = await started(ada, secret.id, 'Board-only note');
    const refused = await contribute(jonas, [{ kind: 'message', id: board.messages[0]!.id }]);
    assert.equal(refused.status, 404);
    assert.equal((refused.json as { code: string }).code, 'REFERENCE_UNAVAILABLE');
    // A retry replays the stored message with its card.
    const retryId = randomUUID();
    const sent = expectStatus(await contribute(jonas, [{ kind: 'thought', id: idea.id }], retryId), 201) as ConversationMessage;
    const again = expectStatus(await contribute(jonas, [{ kind: 'thought', id: idea.id }], retryId), 201) as ConversationMessage;
    assert.equal(again.id, sent.id);
    assert.deepEqual(again.references, sent.references);
  });

  test('a retry repeats the same message with its cards; another set of references under the same id is a conflict', async () => {
    const map = await sketch(ada, { title: 'Retry map', scope: 'project', projectId: open.id });
    const one = await thought(ada, map.id, 'First');
    const two = await thought(ada, map.id, 'Second');
    const root = await started(ada, open.id, 'Thread for retries');
    const clientMessageId = randomUUID();
    const first = expectStatus(await reply(ada, root.id, 'Cites one', [{ kind: 'thought', id: one.id }], clientMessageId), 201) as ConversationMessage;
    const again = expectStatus(await reply(ada, root.id, 'Cites one', [{ kind: 'thought', id: one.id.toUpperCase() }], clientMessageId), 201) as ConversationMessage;
    assert.equal(again.id, first.id);
    assert.deepEqual(again.references, first.references);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_references WHERE project_message_id = $1', [first.id])).rows[0].n, 1);
    assert.equal((await reply(ada, root.id, 'Cites one', [{ kind: 'thought', id: two.id }], clientMessageId)).status, 409);
    assert.equal((await reply(ada, root.id, 'Cites one', undefined, clientMessageId)).status, 409);
  });

  test('the list is bounded, distinct and exact', async () => {
    const map = await sketch(ada, { title: 'Bounds', scope: 'project', projectId: open.id });
    const ideas = [];
    for (let index = 0; index < 5; index++) ideas.push(await thought(ada, map.id, `Idea ${index}`));
    const refs = ideas.map((idea) => ({ kind: 'thought', id: idea.id }));
    assert.equal((await start(ada, open.id, 'Five is too many', refs)).status, 400);
    assert.equal((await start(ada, open.id, 'Four is the limit', refs.slice(0, 4))).status, 201);
    assert.equal((await start(ada, open.id, 'Twice', [refs[0]!, refs[0]!])).status, 400);
    assert.equal((await start(ada, open.id, 'Wrong kind', [{ kind: 'task', id: ideas[0]!.id }])).status, 400);
    assert.equal((await start(ada, open.id, 'Not an id', [{ kind: 'thought', id: 'nope' }])).status, 400);
    assert.equal((await start(ada, open.id, 'Extra key', [{ kind: 'thought', id: ideas[0]!.id, title: 'forged' }])).status, 400);
    assert.equal((await start(ada, open.id, 'Not a list', undefined)).status, 201, 'a message without references is unchanged');
    const plain = await started(ada, open.id, 'Plain');
    assert.equal('references' in plain.messages[0]!, false, 'no empty list is added to a message that cites nothing');
  });
});
