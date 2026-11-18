import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hasInvisibleFormat, myAgentPath, removedName, viaName, withoutInvisibleFormat, type Agent, type Decision, type MyAgent, type SearchResponse,
  type WorkReferenceRows } from '@flux/contracts';
import { notificationFactRows, returnRows } from '@flux/db';
import { profileFromClaims } from '../../apps/server/src/identity/claim-profile.js';
import { listCallLines } from '../../apps/server/src/live/discovery.js';
import { db, pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, removeMember, secondSession, workspace } from './support/people.js';
import { assistantScene } from './support/assistant-scene.js';

// Names are drawn beside other text (#1347, the audits of #1270): a direction control or an invisible character in one would reorder what
// follows it or let two names look alike. They are refused when typed, and cleaned when read (a name stored before, or one an identity provider
// or an OAuth client gave).

/** U+202A-202E, U+2066-2069, U+200E/F, U+061C, and the invisible U+200B, U+2060 and U+FEFF. */
const FORMAT = ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200e', '\u200f', '\u061c', '\u200b', '\u2060', '\ufeff'];
const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

test('the characters are the ones listed, and the joiners that emoji need are not among them', () => {
  for (const char of FORMAT) assert.ok(hasInvisibleFormat(`Ada${char}`), `U+${char.codePointAt(0)!.toString(16)}`);
  for (const fine of ['Ada Nowak', 'Zażółć gęślą jaźń', 'العربية', '👩‍💻 Ada', 'עברית', 'Ada‍', 'Ada‌']) assert.ok(!hasInvisibleFormat(fine), fine);
  assert.equal(withoutInvisibleFormat("Ada's \u202eTNATSISSA S'TREBUH\u202c\u200b"), "Ada's TNATSISSA S'TREBUH");
  assert.equal(withoutInvisibleFormat('👩‍💻'), '👩‍💻');
});

test('an agent, a workspace, a space, a sign-up and a profile refuse a name with a direction control or an invisible character', async () => {
  const owner = await person('Names owner');
  const ws = await workspace(owner, 'Names');
  for (const char of FORMAT) {
    const name = `Ada ${char}assistant`;
    assert.equal(code(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } })), 'INVALID_NAME', `agent U+${char.codePointAt(0)!.toString(16)}`);
    assert.equal(code(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name } })), 'INVALID_NAME', 'workspace');
    assert.equal(code(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name, visibility: 'workspace' } })), 'INVALID_NAME', 'space');
  }
  const stranger = new Browser();
  for (const char of ['\u202e', '\u200f', '\u061c', '\u2066']) {
    const signUp = await stranger.request('POST', '/api/auth/sign-up/email', { body: { email: `names-${randomUUID()}@example.test`, password: 'a long enough password 7', name: `Lena${char}` } });
    assert.deepEqual([signUp.status, code(signUp)], [400, 'INVALID_NAME'], 'sign-up');
    const profile = await owner.browser.request('POST', '/api/auth/update-user', { body: { name: `Hubert${char}` } });
    assert.deepEqual([profile.status, code(profile)], [400, 'INVALID_NAME'], 'profile');
  }
  // Ordinary names, and an emoji with its joiners, go through.
  expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada 👩‍💻 helper', owner: 'self' } }), 201);
  expectStatus(await owner.browser.request('POST', '/api/auth/update-user', { body: { name: 'Hubert Osypowicz' } }), 200);
});

test('an assistant renamed with a direction control is refused; a name stored with one is read clean, in the agent list and on its page', async () => {
  const scene = await assistantScene('names');
  const refused = await scene.owner.browser.request('PATCH', myAgentPath(scene.agentId), { body: { name: "\u202eTNATSISSA S'TREBUH" } });
  assert.deepEqual([refused.status, code(refused)], [400, 'INVALID_NAME']);
  expectStatus(await scene.owner.browser.request('PATCH', myAgentPath(scene.agentId), { body: { name: 'Plain name' } }), 200);
  // A name stored before the rule (the database holds what it held): every read through the schema is clean.
  await pool.query(`UPDATE agents SET name = $2 WHERE id = $1`, [scene.agentId, "Ada's \u202eTNATSISSA S'TREBUH\u200b"]);
  const listed = (expectStatus(await scene.owner.browser.request('GET', `/api/v1/workspaces/${scene.ws.id}/agents`), 200) as Agent[]).find((agent) => agent.id === scene.agentId);
  assert.equal(listed!.name, "Ada's TNATSISSA S'TREBUH");
  assert.equal((expectStatus(await scene.owner.browser.request('GET', myAgentPath(scene.agentId)), 200) as MyAgent).name, "Ada's TNATSISSA S'TREBUH");
  await pool.query(`UPDATE auth_users SET name = $2 WHERE id = $1`, [scene.owner.id, 'Hubert\u202e']);
  // A new session reads the person afresh (the cached one of the old session would still hold the name it was given).
  const me = expectStatus(await (await secondSession(scene.owner)).browser.request('GET', '/api/v1/me'), 200) as { user: { name: string } };
  assert.equal(me.user.name, 'Hubert');
});

test('a name stored with a direction control is read clean where raw SQL reads it too: a search hit\'s author and its direct message (review of #1347)', async () => {
  const owner = await person('Raw names owner');
  const ws = await workspace(owner, 'Raw names');
  const ada = await person('Ada Raw');
  await addMember(owner, ws.id, ada, 'member');
  const dm = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [owner.id] } }), 201) as { id: string };
  const word = `quokka${randomUUID().slice(0, 8)}`;
  expectStatus(await ada.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: `the ${word} plan`, clientMessageId: randomUUID() } }), 201);
  // Stored before the rule, as v0.2.0 could: a direction control in the range and one after it, and an invisible one.
  await pool.query(`UPDATE auth_users SET name = $2 WHERE id = $1`, [ada.id, 'Ada\u202e Raw\u2067\u200b']);
  const found = expectStatus(await owner.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse;
  const hit = found.items.find((item) => item.kind === 'dm_message');
  assert.ok(hit, JSON.stringify(found.items));
  assert.equal(hit.author, 'Ada Raw');
  assert.deepEqual(hit.place, { type: 'dm', id: dm.id, name: 'Ada Raw' });
  // Removed from the company she is "Ada Raw (removed)", read clean as before (founder decision, Hubert, 2026-11-17, #1424).
  await removeMember(owner, ws.id, ada);
  const later = (expectStatus(await owner.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'dm_message');
  assert.equal(later?.author, 'Ada Raw (removed)');
});

test('a name from an identity provider is cleaned, never refused, so single sign-on still works', () => {
  const issuer = 'https://idp.example.test';
  const profile = profileFromClaims(issuer, { iss: issuer, sub: 'sub-9', email: 'ada@example.test', email_verified: true, name: "Ada \u202eTNATSISSA\u202c\u200b" });
  assert.deepEqual(profile, { ok: true, subject: 'sub-9', email: 'ada@example.test', name: 'Ada TNATSISSA' });
  const only = profileFromClaims(issuer, { iss: issuer, sub: 'sub-10', email: 'bo@example.test', email_verified: true, name: '\u202e\u200b' });
  assert.deepEqual(only, { ok: true, subject: 'sub-10', email: 'bo@example.test', name: null }, 'a name of nothing visible is no name');
});

test('an answer a removed person showed everyone is named with the mark, "Marek Zieliński (removed)\'s Assistant" (train 37 row 33, C-56)', () => {
  assert.equal(viaName('Marek Zieliński', 'Assistant', true), 'Marek\'s Assistant', 'a member: their first name');
  assert.equal(viaName(removedName('Marek Zieliński'), 'Assistant', true), 'Marek Zieliński (removed)\'s Assistant', 'a removed person: the whole marked name');
  assert.equal(viaName(removedName('Marek Zieliński'), 'Claude Code'), 'Marek Zieliński (removed) · via Claude Code', 'a local client\'s post keeps its form');
});

test('"Stan Kowal (removed)" in the readers that still named him plainly: an agent\'s label in Search, Home and a notice, a decision\'s rows and a call\'s line (pre-review P2-3)', async () => {
  const lead = await person('Removed readers lead');
  const ws = await workspace(lead, 'Removed readers');
  const [stan, gina] = [await person('Stan Kowal'), await person('Gina Guest')];
  await addMember(lead, ws.id, stan, 'member');
  await addMember(lead, ws.id, gina, 'guest');
  const place = await project(lead, ws.id, 'Kiln', 'restricted');
  await grant(lead, place.id, stan, 'contributor');
  await grant(lead, place.id, gina, 'contributor');
  // Stan's agent wrote in the space; Stan proposed one decision and accepted another; Stan was in a call of the space.
  const agent = (expectStatus(await stan.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Planner', owner: 'self' } }), 201) as { id: string }).id;
  const thread = expectStatus(await lead.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, { body: { body: 'Kiln schedule', clientMessageId: randomUUID() } }), 201) as { id: string };
  const word = `glaze${randomUUID().slice(0, 8)}`;
  const line = randomUUID();
  await pool.query(`INSERT INTO project_messages (id, workspace_id, project_id, conversation_id, author_agent_id, client_message_id, request_fingerprint, sequence, body)
    VALUES ($1, $2, $3, $4, $5, $6, 'test', 2, $7)`, [line, ws.id, place.id, thread.id, agent, randomUUID(), `The ${word} firing is at noon`]);
  await pool.query('UPDATE project_conversations SET next_sequence = 3 WHERE id = $1', [thread.id]);
  const proposed = expectStatus(await stan.browser.request('POST', `/api/v1/projects/${place.id}/decisions`, { body: { title: 'Fire on Fridays' } }), 201) as Decision;
  const asked = expectStatus(await lead.browser.request('POST', `/api/v1/projects/${place.id}/decisions`, { body: { title: 'Buy cone 6 clay' } }), 201) as Decision;
  expectStatus(await stan.browser.request('POST', `/api/v1/decisions/${asked.id}/accept`, { body: {}, headers: { 'if-match': `"${asked.version}"` } }), 200);
  const call = randomUUID();
  await pool.query(`INSERT INTO live_sessions (id, workspace_id, project_id, created_by, client_session_id, room_id, state, joined_by, ended_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'ended', $7, now())`, [call, ws.id, place.id, stan.id, randomUUID(), `live_${randomUUID()}`, [stan.id, lead.id]]);

  const label = async () => (expectStatus(await gina.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'message')?.author;
  const rowOf = async (id: string) => (expectStatus(await lead.browser.request('GET', `/api/v1/projects/${place.id}/work-reference-rows?objects=decision:${id}`), 200) as WorkReferenceRows).items[0];
  const proposer = async () => { const row = await rowOf(proposed.id); return row?.kind === 'decision' ? row.proposedBy.name : null; };
  const accepter = async () => { const row = await rowOf(asked.id); return row?.kind === 'decision' ? row.decidedBy?.name : null; };
  // The space's call lines as its conversation reads them (the route is the live server's; no media is needed for an ended call).
  const removedInCall = async () => ((await listCallLines(db, { participants: async () => [] }, { kind: 'human', id: lead.id }, place.id, null)).items
    .find((item) => item.id === call) as { removed?: Record<string, string> } | undefined)?.removed;
  assert.equal(await label(), 'Stan\'s Planner');
  assert.deepEqual([await proposer(), await accepter(), await removedInCall()], ['Stan Kowal', 'Stan Kowal', undefined]);
  // Out of the space only: his name is not told to the guest, who no longer shares the space with him (the space's rule, `projectAuthorOwners`).
  await removeFromSpace(lead, place.id, stan);
  assert.equal(await label(), 'a former member\'s Planner');
  await grant(lead, place.id, stan, 'contributor');
  // Out of the company: "Stan Kowal (removed)" in every one of these readers (founder decision, Hubert, 2026-11-17, #1424).
  await removeMember(lead, ws.id, stan);
  assert.equal(await label(), 'Stan Kowal (removed)\'s Planner', 'Search');
  assert.equal((await returnRows(db).names([`agent:${agent}`])).get(`agent:${agent}`), 'Stan Kowal (removed)\'s Planner', 'Home\'s lines');
  assert.equal(((await notificationFactRows(db).projectMessage(line)) as { authorOwnerRemoved?: boolean } | null)?.authorOwnerRemoved, true, 'a notice\'s label');
  assert.deepEqual([await proposer(), await accepter()], ['Stan Kowal (removed)', 'Stan Kowal (removed)'], 'a decision\'s proposer and accepter in its rows');
  assert.deepEqual(await removedInCall(), { [stan.id]: 'Stan Kowal (removed)' }, 'the call\'s line, which the space\'s people no longer list');
});

test('Home\'s "since you left" lines name a person removed from the company by the whole marked name, "Stefan Kowal (removed)" (delta review N2)', async () => {
  const lead = await person('Away lines lead');
  const ws = await workspace(lead, 'Away lines');
  const stefan = await person('Stefan Kowal');
  await addMember(lead, ws.id, stefan, 'member');
  const place = await project(lead, ws.id, 'Kiln room', 'restricted');
  await grant(lead, place.id, stefan, 'contributor');
  expectStatus(await stefan.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, { body: { body: 'Kiln firing plan', clientMessageId: randomUUID() } }), 201);
  const line = async () => {
    const summary = expectStatus(await lead.browser.request('GET', `/api/v1/return?place=project&id=${place.id}`), 200) as { items: { actor: string | null; text: string }[] };
    const found = summary.items.find((item) => item.text.includes('Kiln firing plan'));
    assert.ok(found, JSON.stringify(summary.items));
    return [found.actor, found.text];
  };
  assert.deepEqual(await line(), ['Stefan', 'Stefan started “Kiln firing plan”'], 'a member: by first name, as in conversation');
  // Out of the space only: no mark, the space's people just no longer list him.
  await removeFromSpace(lead, place.id, stefan);
  assert.deepEqual((await line())[0], 'Stefan', 'leaving one space is not leaving the company');
  // Out of the company: the whole marked name (founder decision, Hubert, 2026-11-17, #1424).
  await removeMember(lead, ws.id, stefan);
  assert.deepEqual(await line(), ['Stefan Kowal (removed)', 'Stefan Kowal (removed) started “Kiln firing plan”']);
});
