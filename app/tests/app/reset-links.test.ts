import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { personResetLinkPath, type ResetLink } from '@flux/contracts';
import { makeResetLink, registerResetLinkRoutes, resetIdentifier } from '../../apps/server/src/identity/reset-links.js';
import type { SessionResolver } from '../../apps/server/src/identity/session.js';
import type { SecurityLogger } from '../../apps/server/src/security-log.js';
import { db, insertedHuman, pool } from './support/db.js';
import { Browser, publicOrigin, signIn, waitForMail } from './support/http.js';
import { expectStatus, password, person, type Person } from './support/people.js';

// Password reset links (#1471, docs/development/access-policy.md#password-reset-links-1471), against the running API: an owner or admin
// makes one next to a person in Settings › Company; `./flux reset-link` makes the same kind; a mailed reset is one too.

const companyId = async () => (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
async function inCompany(label: string, role: 'owner' | 'admin' | 'member' | 'guest'): Promise<Person> {
  const someone = await person(label);
  await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, $3, $2)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [await companyId(), someone.id, role]);
  return someone;
}
const make = (maker: Person, userId: string) => maker.browser.request('POST', personResetLinkPath(userId));
const tokenOf = (link: string) => new URL(link).hash.slice(1);
const reset = (token: string, newPassword: string) => new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword } });
const rows = async (userId: string) => (await pool.query<{ via: string; made_by: string | null; used_at: Date | null; stopped_at: Date | null; verification_identifier: string }>(
  'SELECT via, made_by, used_at, stopped_at, verification_identifier FROM password_reset_links WHERE user_id = $1 ORDER BY created_at', [userId])).rows;

describe('a reset link made next to a person (#1471)', () => {
  test('an admin makes one for a member: shown once, in the fragment, stored only hashed, and it resets the password once', async () => {
    const admin = await inCompany('Reset Admin', 'admin');
    const member = await inCompany('Reset Member', 'member');
    const answer = expectStatus(await make(admin, member.id), 201) as ResetLink;
    assert.match(answer.link, new RegExp(`^${publicOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/reset-password#[A-Za-z0-9_-]{24}$`));
    const minutes = (new Date(answer.expiresAt).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 55 && minutes <= 60, `one hour by default: ${minutes}`);
    const token = tokenOf(answer.link);
    assert.equal((await pool.query('SELECT 1 FROM auth_verifications WHERE identifier LIKE $1 OR value LIKE $1', [`%${token}%`])).rowCount, 0, 'never stored as it is');
    assert.equal((await pool.query('SELECT 1 FROM auth_verifications WHERE identifier = $1', [resetIdentifier(token)])).rowCount, 1, 'Better Auth\'s hashed identifier');
    const [recorded] = await rows(member.id);
    assert.deepEqual([recorded?.via, recorded?.made_by, recorded?.used_at], ['settings', admin.id, null], 'recorded: how and by whom');
    assert.equal(recorded?.verification_identifier, resetIdentifier(token));

    const chosen = 'a member chose this new passphrase';
    expectStatus(await reset(token, chosen), 200);
    assert.equal((await member.browser.request('GET', '/api/v1/me')).status, 401, 'the reset signs the member out everywhere');
    assert.equal((await signIn(member.email, chosen)).response.status, 200);
    assert.equal((await reset(token, 'and then another passphrase')).status, 400, 'it works once');
    assert.ok((await rows(member.id))[0]?.used_at, 'and is recorded as used');
  });

  test('a newer link and the time stop a link; a change of password does not', async () => {
    const owner = await inCompany('Reset Owner', 'owner');
    const member = await inCompany('Reset Stopped', 'member');
    const first = tokenOf((expectStatus(await make(owner, member.id), 201) as ResetLink).link);
    const second = tokenOf((expectStatus(await make(owner, member.id), 201) as ResetLink).link);
    assert.equal((await reset(first, 'the first link should not work')).status, 400, 'a newer link stops the older one');
    assert.ok((await rows(member.id))[0]?.stopped_at, 'recorded as stopped');

    // Coordinator decision (2026-11-13): someone who knows the current password must not be able to cancel the owner's way back.
    const changed = await member.browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: 'changed in settings account' } });
    expectStatus(changed, 200);
    assert.equal((await rows(member.id))[1]?.stopped_at, null, 'a change of password stops no link');
    expectStatus(await reset(second, 'the link still works after a change'), 200, 'a change of password does not stop a link');
    assert.equal((await member.browser.request('GET', '/api/v1/me')).status, 401, 'using the link signs the person out everywhere');
    assert.equal((await signIn(member.email, 'changed in settings account')).response.status, 401, 'the changed password is replaced');

    const third = tokenOf((expectStatus(await make(owner, member.id), 201) as ResetLink).link);
    await pool.query("UPDATE auth_verifications SET expires_at = now() - interval '1 minute' WHERE identifier = $1", [resetIdentifier(third)]);
    assert.equal((await reset(third, 'an expired link changes nothing')).status, 400);
    assert.equal((await signIn(member.email, 'the link still works after a change')).response.status, 200, 'the password is the one the link set');
  });

  test('who may make one for whom', async () => {
    const owner = await inCompany('Reset Owner Two', 'owner');
    const admin = await inCompany('Reset Admin Two', 'admin');
    const otherAdmin = await inCompany('Reset Admin Three', 'admin');
    const member = await inCompany('Reset Member Two', 'member');
    const guest = await inCompany('Reset Guest', 'guest');
    const outsider = await person('Reset Outsider');
    const code = (response: { json: unknown }) => (response.json as { code?: string }).code;
    expectStatus(await make(admin, guest.id), 201, 'an admin, for a guest');
    expectStatus(await make(owner, otherAdmin.id), 201, 'an owner, for an admin');
    for (const [maker, target, status, expected] of [
      [admin, otherAdmin.id, 403, 'OWNER_REQUIRED'], [admin, owner.id, 403, 'OWNER_REQUIRED'], [member, guest.id, 403, 'FORBIDDEN'],
      [outsider, member.id, 403, 'FORBIDDEN'], [owner, owner.id, 409, 'OWN_ACCOUNT'], [owner, outsider.id, 404, 'PERSON_NOT_FOUND'],
    ] as const) {
      const answer = await make(maker, target);
      assert.deepEqual([answer.status, code(answer)], [status, expected], answer.text);
    }
    const noPassword = await insertedHuman('reset-no-password');
    await pool.query("INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'member', $2)", [await companyId(), noPassword.id]);
    const sso = await make(owner, noPassword.id);
    assert.deepEqual([sso.status, code(sso)], [409, 'NO_PASSWORD'], 'an account without a password has nothing to reset');
    assert.equal((await new Browser().request('POST', personResetLinkPath(member.id))).status, 401, 'signed out');
    assert.equal((await rows(otherAdmin.id)).length, 1, 'a refusal records nothing');
  });
});

describe('a link made in Settings is told and limited (#1471)', () => {
  test('it writes a reset_link_created event with who made it for whom, and never the link', async () => {
    const owner = await inCompany('Audit Owner', 'owner');
    const member = await inCompany('Audit Member', 'member');
    const lines: Record<string, unknown>[] = [];
    const log: SecurityLogger = { info: (object, message) => { lines.push({ ...object, msg: message }); }, warn: (object, message) => { lines.push({ ...object, msg: message }); } };
    const app = Fastify();
    const sessions = { requirePrincipal: async () => ({ principal: { kind: 'human', id: owner.id } }) } as unknown as SessionResolver;
    registerResetLinkRoutes(app, { db, sessions, publicOrigin: 'https://flux.example.org', ttlSeconds: 600, ssoOnly: false, log });
    try {
      const answer = await app.inject({ method: 'POST', url: personResetLinkPath(member.id) });
      assert.equal(answer.statusCode, 201, answer.body);
      assert.equal(answer.headers['cache-control'], 'no-store');
      const token = (answer.json() as ResetLink).link.split('#')[1]!;
      const events = lines.filter((line) => line.event === 'reset_link_created');
      assert.equal(events.length, 1);
      assert.deepEqual([events[0]?.channel, events[0]?.outcome, events[0]?.reason, events[0]?.userId, events[0]?.byUserId], ['security', 'success', 'settings', member.id, owner.id]);
      assert.ok(!JSON.stringify(lines).includes(token), 'the link is in no log line');
    } finally { await app.close(); }
  });

  test('making links is limited per person', async () => {
    const owner = await inCompany('Limited Owner', 'owner');
    const member = await inCompany('Limited Member', 'member');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await make(owner, member.id)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429, 'the eleventh in a minute is refused');
    assert.equal((await rows(member.id)).length, 10, 'and makes no link');
  });
});

describe('the server command and the mailed reset make the same kind of link (#1471)', () => {
  test('./flux reset-link: one link for any password account, recorded as the command\'s', async () => {
    const owner = await inCompany('Command Owner', 'owner');
    const made = await makeResetLink(db, { publicOrigin, ttlSeconds: 600, userId: owner.id, via: 'command', madeBy: null });
    const [recorded] = await rows(owner.id);
    assert.deepEqual([recorded?.via, recorded?.made_by], ['command', null]);
    expectStatus(await reset(tokenOf(made.link), 'the owner is back in'), 200);
    assert.equal((await signIn(owner.email, 'the owner is back in')).response.status, 200);
  });

  test('a mailed reset is recorded, and a newer mailed one stops a link made in Settings', async () => {
    const owner = await inCompany('Mail Owner', 'owner');
    const member = await inCompany('Mail Member', 'member');
    const settings = tokenOf((expectStatus(await make(owner, member.id), 201) as ResetLink).link);
    expectStatus(await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email: member.email, redirectTo: `${publicOrigin}/reset-password` } }), 200);
    const mail = await waitForMail(member.email);
    const mailed = mail.match(/reset-password\/([^?\s]+)/)?.[1];
    assert.ok(mailed, mail);
    const recorded = await rows(member.id);
    assert.deepEqual(recorded.map((row) => row.via), ['settings', 'email']);
    assert.equal(recorded[1]?.verification_identifier, resetIdentifier(mailed));
    assert.equal((await reset(settings, 'the settings link is stopped')).status, 400, 'the newest link is the one that works');
    expectStatus(await reset(mailed, 'the mailed link works'), 200);
  });
});
