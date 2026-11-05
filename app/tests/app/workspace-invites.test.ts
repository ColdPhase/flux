import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { AcceptInviteResult, InvitePreview, WorkspaceInvite, WorkspaceMember } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { codeOf, createSealed, lock, passphrase } from './support/encryption.js';
import { addMember, expectStatus, password, person, workspace, type Person } from './support/people.js';

// F-035 (#763 PE-2; docs/development/access-policy.md#invite-links-f-035): one-time invite links that join a workspace.
// Create, accept as a new and an existing account, expiry, revoke, single use, wrong email, role limits, the creator
// losing the role, encrypted workspaces, no token at rest and the uniform 404 for anything without the link.

const key = () => ({ 'idempotency-key': randomUUID() });
const tokenOf = (invite: WorkspaceInvite) => {
  const [base, token] = invite.link.split('#');
  assert.equal(base, `${publicOrigin}/join`);
  return token!;
};

async function create(who: Person, workspaceId: string, body: Record<string, unknown>, status = 201, headers = key()) {
  return expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/invites`, { body, headers }), status, 'create invite') as WorkspaceInvite & { code?: string };
}
const preview = (browser: Browser, token: string) => browser.request('POST', '/api/v1/invites/preview', { body: { token } });
const accept = (who: { browser: Browser }, token: string) => who.browser.request('POST', '/api/v1/invites/accept', { body: { token }, headers: key() });
const roleOf = async (owner: Person, workspaceId: string, userId: string) =>
  ((expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${workspaceId}/members`), 200) as WorkspaceMember[]).find((m) => m.userId === userId)?.role ?? null);

let ada: Person; let ben: Person; let cleo: Person;
let space: string;

before(async () => {
  ada = await person('Ada Invites');
  ben = await person('Ben Invites');
  cleo = await person('Cleo Invites');
  space = (await workspace(ada, 'Riverside Makers')).id;
  await addMember(ada, space, ben, 'admin');
});

describe('F-035 invite links', () => {
  test('an owner creates a link; a new account signs up through it and joins with its role', async () => {
    const invite = await create(ada, space, { role: 'member' });
    assert.equal(invite.role, 'member');
    assert.equal(invite.email, null);
    assert.equal(invite.createdBy.id, ada.id);
    const days = (Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)) / 86_400_000;
    assert.ok(Math.abs(days - 7) < 0.01, `7 days by default (${days})`);
    const token = tokenOf(invite);

    // A visitor with the link, not signed in, sees what it is for, but never an address.
    const anonymous = new Browser();
    const seen = expectStatus(await preview(anonymous, token), 200) as InvitePreview;
    assert.deepEqual({ ...seen, expiresAt: undefined }, { workspaceName: 'Riverside Makers', invitedBy: 'Ada Invites', role: 'member', expiresAt: undefined,
      emailLocked: false, encrypted: false, state: 'pending' });
    assert.equal((await anonymous.request('POST', '/api/v1/invites/accept', { body: { token } })).status, 401, 'accept needs a session');

    const email = uniqueEmail('dan-invites');
    const { browser } = await register(email, password, 'Dan Invites');
    const dan = { browser };
    const danId = ((await browser.request('GET', '/api/v1/me')).json as { user: { id: string } }).user.id;
    const joined = expectStatus(await accept(dan, token), 200) as AcceptInviteResult;
    assert.deepEqual(joined, { status: 'joined', workspaceId: space, workspaceName: 'Riverside Makers', role: 'member', encrypted: false, needsUnlockPassword: false });
    assert.equal(await roleOf(ada, space, danId), 'member');
    // Idempotent for the account that used it; the preview says joined.
    assert.equal((expectStatus(await accept(dan, token), 200) as AcceptInviteResult).status, 'joined');
    assert.equal((expectStatus(await preview(browser, token), 200) as InvitePreview).state, 'joined');
    // Single use: another account, or a visitor, gets 410 INVITE_USED.
    const second = await accept(cleo, token);
    assert.equal(second.status, 410); assert.equal(codeOf(second), 'INVITE_USED');
    assert.equal(codeOf(await preview(anonymous, token)), 'INVITE_USED');
    assert.equal(await roleOf(ada, space, cleo.id), null);
    // The used link is no longer listed; the join is audited by the person who joined, with the invite.
    const listed = expectStatus(await ada.browser.request('GET', `/api/v1/workspaces/${space}/invites`), 200) as WorkspaceInvite[];
    assert.ok(!listed.some((item) => item.id === invite.id));
    const events = (await pool.query<{ kind: string; actor_id: string; data: Record<string, unknown> }>(
      `SELECT kind, actor_id, data FROM events WHERE workspace_id = $1 AND (data->>'inviteId') = $2 ORDER BY seq`, [space, invite.id])).rows;
    assert.deepEqual(events.map((e) => e.kind), ['workspace.invite_created.v1', 'workspace.member_added.v1']);
    assert.equal(events[1]!.actor_id, `human:${danId}`);
    assert.deepEqual(events[1]!.data, { userId: danId, role: 'member', inviteId: invite.id });
  });

  test('the token is not at rest: only its SHA-256 is stored, and no event or stored answer holds it', async () => {
    const headers = key();
    const invite = await create(ada, space, { role: 'guest', expiresInDays: 1 }, 201, headers);
    const token = tokenOf(invite);
    const [row] = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM workspace_invites WHERE id = $1', [invite.id])).rows;
    assert.equal(row!.token_hash, createHash('sha256').update(token).digest('hex'));
    for (const [table, column] of [['events', 'data::text'], ['idempotency_keys', 'response_body::text'], ['workspace_invites', 'row_to_json(workspace_invites)::text']] as const) {
      const found = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} LIKE $1`, [`%${token}%`]);
      assert.equal(found.rowCount, 0, `no token in ${table}`);
    }
    // A retry with the same Idempotency-Key answers the same invite and the same link.
    const again = await create(ada, space, { role: 'guest', expiresInDays: 1 }, 201, headers);
    assert.equal(again.id, invite.id); assert.equal(again.link, invite.link);
    // Listed for owners and admins, with the link to copy again.
    const listedByBen = expectStatus(await ben.browser.request('GET', `/api/v1/workspaces/${space}/invites`), 200) as WorkspaceInvite[];
    assert.equal(listedByBen.find((item) => item.id === invite.id)?.link, invite.link);
  });

  test('anything without the genuine link is one 404, and nothing is learned', async () => {
    const invite = await create(ada, space, { role: 'member' });
    const token = tokenOf(invite);
    const forged = `${token.slice(0, 30)}${token[30] === 'A' ? 'B' : 'A'}${token.slice(31)}`;
    const anonymous = new Browser();
    const guesser = await person('Guesser Invites');
    for (const bad of [forged, 'x'.repeat(54), 'not-a-token', '', randomUUID()]) {
      const response = await preview(anonymous, bad);
      assert.ok(response.status === 404 || response.status === 400, `${bad}: ${response.status}`);
      if (response.status === 404) assert.deepEqual(response.json, { error: 'Invite not found', code: 'INVITE_NOT_FOUND' });
      const accepted = await accept(guesser, bad);
      assert.ok(accepted.status === 404 || accepted.status === 400);
    }
    assert.equal(await roleOf(ada, space, cleo.id), null);
    // A member who may not manage people cannot list, create or revoke.
    const eve = await person('Eve Invites');
    await addMember(ada, space, eve, 'member');
    assert.equal((await eve.browser.request('GET', `/api/v1/workspaces/${space}/invites`)).status, 403);
    assert.equal((await eve.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'guest' }, headers: key() })).status, 403);
    assert.equal((await eve.browser.request('DELETE', `/api/v1/workspaces/${space}/invites/${invite.id}`)).status, 403);
    // Someone outside the workspace cannot tell it exists.
    assert.equal((await cleo.browser.request('GET', `/api/v1/workspaces/${space}/invites`)).status, 404);
  });

  test('an existing account joins; someone already here leaves the link unused', async () => {
    const invite = await create(ben, space, { role: 'guest' });
    const token = tokenOf(invite);
    const here = expectStatus(await accept(ada, token), 200) as AcceptInviteResult;
    assert.equal(here.status, 'already_member'); assert.equal(here.role, 'owner');
    assert.equal((expectStatus(await preview(ada.browser, token), 200) as InvitePreview).state, 'member');
    const joined = expectStatus(await accept(cleo, token), 200) as AcceptInviteResult;
    assert.equal(joined.status, 'joined'); assert.equal(joined.role, 'guest');
    assert.equal(await roleOf(ada, space, cleo.id), 'guest');
    expectStatus(await ada.browser.request('DELETE', `/api/v1/workspaces/${space}/members/${cleo.id}`), 204);
    // Having left, the used link does not bring them back.
    assert.equal(codeOf(await accept(cleo, token)), 'INVITE_USED');
  });

  test('expiry, revoke and the creator losing the role end a link', async () => {
    const expired = await create(ada, space, { role: 'member' });
    await pool.query(`UPDATE workspace_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1`, [expired.id]);
    const late = await accept(cleo, tokenOf(expired));
    assert.equal(late.status, 410); assert.equal(codeOf(late), 'INVITE_EXPIRED');
    assert.equal(codeOf(await preview(new Browser(), tokenOf(expired))), 'INVITE_EXPIRED');

    const revoked = await create(ada, space, { role: 'member' });
    expectStatus(await ben.browser.request('DELETE', `/api/v1/workspaces/${space}/invites/${revoked.id}`), 204);
    assert.equal(codeOf(await accept(cleo, tokenOf(revoked))), 'INVITE_REVOKED');
    assert.equal((await ben.browser.request('DELETE', `/api/v1/workspaces/${space}/invites/${revoked.id}`)).status, 404, 'revoked twice');
    assert.ok(!(expectStatus(await ada.browser.request('GET', `/api/v1/workspaces/${space}/invites`), 200) as WorkspaceInvite[]).some((i) => i.id === revoked.id));

    // Ben, an admin, makes a link and is then made a member: his link stops working.
    const bens = await create(ben, space, { role: 'member' });
    expectStatus(await ada.browser.request('PATCH', `/api/v1/workspaces/${space}/members/${ben.id}`, { body: { role: 'member' }, headers: key() }), 200);
    assert.equal(codeOf(await accept(cleo, tokenOf(bens))), 'INVITE_REVOKED');
    expectStatus(await ada.browser.request('PATCH', `/api/v1/workspaces/${space}/members/${ben.id}`, { body: { role: 'admin' }, headers: key() }), 200);
    assert.equal(await roleOf(ada, space, cleo.id), null);
  });

  test('an email lock admits only that address', async () => {
    const invite = await create(ada, space, { role: 'member', email: `  ${cleo.email.toUpperCase()} ` });
    assert.equal(invite.email, cleo.email.toLowerCase());
    const seen = expectStatus(await preview(new Browser(), tokenOf(invite)), 200) as InvitePreview;
    assert.equal(seen.emailLocked, true);
    assert.ok(!JSON.stringify(seen).includes(cleo.email.toLowerCase()), 'the preview never names the address');
    const eve = await person('Fay Invites');
    const wrong = await accept(eve, tokenOf(invite));
    assert.equal(wrong.status, 403); assert.equal(codeOf(wrong), 'INVITE_WRONG_ACCOUNT');
    assert.equal((expectStatus(await accept(cleo, tokenOf(invite)), 200) as AcceptInviteResult).status, 'joined');
    expectStatus(await ada.browser.request('DELETE', `/api/v1/workspaces/${space}/members/${cleo.id}`), 204);
    assert.equal((await create(ada, space, { role: 'member', email: 'not an address' }, 400)).code, 'INVALID_INPUT');
  });

  test('role limits: never owner, admin only from an owner, expiry only 1, 7 or 30 days', async () => {
    await create(ada, space, { role: 'owner' }, 400);
    assert.equal((await create(ben, space, { role: 'admin' }, 403)).code, 'OWNER_REQUIRED');
    await create(ada, space, { role: 'member', expiresInDays: 3 }, 400);
    const thirty = await create(ada, space, { role: 'member', expiresInDays: 30 });
    assert.ok(Math.abs((Date.parse(thirty.expiresAt) - Date.parse(thirty.createdAt)) / 86_400_000 - 30) < 0.01);
    const admin = await create(ada, space, { role: 'admin' });
    // An admin may not revoke an owner's admin link.
    assert.equal(codeOf(await ben.browser.request('DELETE', `/api/v1/workspaces/${space}/invites/${admin.id}`)), 'OWNER_REQUIRED');
    const gus = await person('Gus Invites');
    const joined = expectStatus(await accept(gus, tokenOf(admin)), 200) as AcceptInviteResult;
    assert.equal(joined.role, 'admin'); assert.equal(joined.needsUnlockPassword, false);
  });

  test('accepting is rate-limited per person', async () => {
    const hal = await person('Hal Invites');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await accept(hal, 'x'.repeat(54))).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
    assert.equal(statuses[10], 429);
  });

  test('encrypted workspace: the person joins (also while locked); an admin gets an unlock password only through a holder', async () => {
    const owner = await person('Ivy Invites');
    const sealed = (await createSealed(owner, 'Garden club', passphrase())).workspace.id;
    const memberLink = await create(owner, sealed, { role: 'member' });
    const adminLink = await create(owner, sealed, { role: 'admin' });
    const spare = await create(owner, sealed, { role: 'guest' });
    assert.equal((expectStatus(await preview(new Browser(), tokenOf(adminLink)), 200) as InvitePreview).encrypted, true);
    const jo = await person('Jo Invites');
    const joined = expectStatus(await accept(jo, tokenOf(adminLink)), 200) as AcceptInviteResult;
    assert.deepEqual({ status: joined.status, role: joined.role, encrypted: joined.encrypted, needsUnlockPassword: joined.needsUnlockPassword },
      { status: 'joined', role: 'admin', encrypted: true, needsUnlockPassword: true });
    // The existing holder flow still decides: no grant, no unlock password.
    const setting = await jo.browser.request('PUT', `/api/v1/workspaces/${sealed}/unlock-password`, { body: { newPassword: passphrase() }, headers: key() });
    assert.equal(setting.status, 403); assert.equal(codeOf(setting), 'UNLOCK_PASSWORD_GRANT_REQUIRED');
    // Membership is metadata: listing, revoking and joining work while the workspace is locked; creating needs it
    // unlocked, because the command's stored answer is sealed.
    expectStatus(await lock(owner.browser, sealed), 200);
    const listed = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${sealed}/invites`), 200) as WorkspaceInvite[];
    assert.ok(listed.some((item) => item.id === memberLink.id));
    assert.equal((await create(owner, sealed, { role: 'guest' }, 423)).code, 'WORKSPACE_LOCKED');
    const kim = await person('Kim Invites');
    const member = expectStatus(await accept(kim, tokenOf(memberLink)), 200) as AcceptInviteResult;
    assert.deepEqual({ status: member.status, role: member.role, needsUnlockPassword: member.needsUnlockPassword }, { status: 'joined', role: 'member', needsUnlockPassword: false });
    expectStatus(await owner.browser.request('DELETE', `/api/v1/workspaces/${sealed}/invites/${spare.id}`), 204, 'revoke while locked');
    // Content stays locked for the new member, as for everyone.
    assert.equal((await kim.browser.request('GET', `/api/v1/workspaces/${sealed}/projects`)).status, 423);
  });
});
