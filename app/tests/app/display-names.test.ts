import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hasInvisibleFormat, myAgentPath, withoutInvisibleFormat, type Agent, type MyAgent, type SearchResponse } from '@flux/contracts';
import { profileFromClaims } from '../../apps/server/src/identity/claim-profile.js';
import { pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, person, secondSession, workspace } from './support/people.js';
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
});

test('a name from an identity provider is cleaned, never refused, so single sign-on still works', () => {
  const issuer = 'https://idp.example.test';
  const profile = profileFromClaims(issuer, { iss: issuer, sub: 'sub-9', email: 'ada@example.test', email_verified: true, name: "Ada \u202eTNATSISSA\u202c\u200b" });
  assert.deepEqual(profile, { ok: true, subject: 'sub-9', email: 'ada@example.test', name: 'Ada TNATSISSA' });
  const only = profileFromClaims(issuer, { iss: issuer, sub: 'sub-10', email: 'bo@example.test', email_verified: true, name: '\u202e\u200b' });
  assert.deepEqual(only, { ok: true, subject: 'sub-10', email: 'bo@example.test', name: null }, 'a name of nothing visible is no name');
});
