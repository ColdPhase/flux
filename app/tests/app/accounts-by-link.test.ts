import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IdentityCapabilities } from '@flux/contracts';
import { createInvite, inviteToken, revokeInvite, type Principal } from '@flux/core';
import { accessPorts } from '@flux/db';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { inviteSignUp } from '../../apps/server/src/access/invites.js';
import { createSignUpLinks } from '../../apps/server/src/identity/sign-up-links.js';
import { database, pool } from './support/db.js';

// Accounts only from a link (#1471, docs/development/access-policy.md#accounts-only-from-a-link-1471), in-process with an install's
// configuration (no test deployment): the first account from the setup link, every other one from an invite link.

const ORIGIN = 'https://flux.example.org';
// The check stack's own secret: the signing keys in its database are encrypted with it, and a session read opens them.
const SECRET = process.env.FLUX_AUTH_SECRET ?? randomBytes(32).toString('hex');
const SETUP = 'c4'.repeat(32);
const PASSWORD = 'a lantern on the harbour wall';
const signer = { secret: SECRET, publicOrigin: ORIGIN };

interface Server { instance: FastifyInstance; signUp(payload: Record<string, unknown>): Promise<{ status: number; code?: string; body: string }>; capabilities(): Promise<IdentityCapabilities> }

async function server(options: { setupToken?: string | null; open?: boolean } = {}): Promise<Server> {
  const setupToken = options.setupToken === undefined ? SETUP : options.setupToken;
  const config = loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: ORIGIN, FLUX_AUTH_SECRET: SECRET, FLUX_AUTH_RATE_LIMIT: 'false', ...(setupToken ? { FLUX_SETUP_TOKEN: setupToken } : {}) });
  const instance = Fastify();
  registerIdentity(instance, { db: database.db, config, mailer: null, openSignUp: options.open ?? false,
    invites: inviteSignUp(database.db, signer, { send: async () => null }, false) });
  await instance.ready();
  return {
    instance,
    async signUp(payload) {
      const answer = await instance.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: ORIGIN }, payload: { password: PASSWORD, name: 'Linked Person', ...payload } });
      let code: string | undefined;
      try { code = (answer.json() as { code?: string }).code; } catch { code = undefined; }
      return { status: answer.statusCode, code, body: answer.body };
    },
    async capabilities() { return (await instance.inject({ method: 'GET', url: '/api/v1/auth/capabilities' })).json() as IdentityCapabilities; },
  };
}

const email = (label: string) => `${label}-${randomUUID()}@example.test`;
const accountOf = async (address: string) => (await pool.query<{ id: string }>('SELECT id FROM auth_users WHERE email = $1', [address])).rows[0]?.id ?? null;
const company = async () => (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows;
const roleIn = async (workspaceId: string, userId: string | null) =>
  (await pool.query<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])).rows[0]?.role ?? null;

describe('an account comes only from a link (#1471)', () => {
  let flux: Server;
  let companyId: string;
  let owner: Principal;
  before(async () => {
    flux = await server();
    companyId = (await company())[0]!.id;
    const [row] = (await pool.query<{ user_id: string }>("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1", [companyId])).rows;
    owner = { kind: 'human', id: row!.user_id };
  });
  after(async () => { await flux.instance.close(); });

  test('a sign-up without a link makes no account, and the capabilities say so', async () => {
    const address = email('no-link');
    const refused = await flux.signUp({ email: address });
    assert.deepEqual([refused.status, refused.code], [403, 'SIGNUP_NEEDS_LINK'], refused.body);
    assert.equal(await accountOf(address), null);
    const said = await flux.capabilities();
    assert.deepEqual([said.setup, said.signup], [false, 'link'], 'a Flux with its company: no setup, accounts from links');
  });

  test('the setup link once the company exists is refused', async () => {
    const address = email('late-setup');
    const refused = await flux.signUp({ email: address, setupToken: SETUP });
    assert.deepEqual([refused.status, refused.code], [409, 'SETUP_DONE'], refused.body);
    assert.equal(await accountOf(address), null);
  });

  test('an invite link makes the account, which joins with the link\'s role as it is made', async () => {
    const invite = await createInvite(owner, companyId, { role: 'guest' }, database.db, accessPorts, signer);
    const address = email('invited');
    const made = await flux.signUp({ email: address, inviteToken: inviteToken(signer, invite.id) });
    assert.equal(made.status, 200, made.body);
    const id = await accountOf(address);
    assert.equal(await roleIn(companyId, id), 'guest', 'in the company at once');
    const used = (await pool.query<{ accepted_by: string }>('SELECT accepted_by FROM workspace_invites WHERE id = $1', [invite.id])).rows[0];
    assert.equal(used?.accepted_by, id, 'the link is used by the new account');
    const again = await flux.signUp({ email: email('second'), inviteToken: inviteToken(signer, invite.id) });
    assert.deepEqual([again.status, again.code], [410, 'INVITE_USED'], 'one link, one account');
    assert.match(made.body, /"user"/);
    assert.doesNotMatch(made.body, new RegExp(inviteToken(signer, invite.id)), 'the token is not echoed');
  });

  test('a link for one address makes an account only for that address', async () => {
    const locked = email('locked');
    const invite = await createInvite(owner, companyId, { role: 'member', email: locked }, database.db, accessPorts, signer);
    const token = inviteToken(signer, invite.id);
    const other = email('other');
    const wrong = await flux.signUp({ email: other, inviteToken: token });
    assert.deepEqual([wrong.status, wrong.code], [403, 'INVITE_WRONG_ACCOUNT'], wrong.body);
    assert.equal(await accountOf(other), null, 'no account is made for another address');
    const right = await flux.signUp({ email: locked.toUpperCase(), inviteToken: token });
    assert.equal(right.status, 200, right.body);
    assert.equal(await roleIn(companyId, await accountOf(locked)), 'member');
  });

  test('a revoked, expired, forged or unknown invite link makes nothing', async () => {
    const revoked = await createInvite(owner, companyId, { role: 'member' }, database.db, accessPorts, signer);
    await revokeInvite(owner, companyId, revoked.id, database.db, accessPorts);
    const expired = await createInvite(owner, companyId, { role: 'member' }, database.db, accessPorts, signer);
    await pool.query("UPDATE workspace_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [expired.id]);
    const cases: [string, number, string][] = [
      [inviteToken(signer, revoked.id), 410, 'INVITE_REVOKED'],
      [inviteToken(signer, expired.id), 410, 'INVITE_EXPIRED'],
      [inviteToken({ ...signer, secret: 'another secret that is long enough to sign' }, expired.id), 404, 'INVITE_NOT_FOUND'],
      ['not-a-token', 404, 'INVITE_NOT_FOUND'],
    ];
    for (const [token, status, code] of cases) {
      const address = email('dead-link');
      const answer = await flux.signUp({ email: address, inviteToken: token });
      assert.deepEqual([answer.status, answer.code], [status, code], answer.body);
      assert.equal(await accountOf(address), null, code);
    }
  });

  test('a test deployment also makes an account without a link', async () => {
    const open = await server({ open: true });
    try {
      const address = email('test-deployment');
      assert.equal((await open.signUp({ email: address })).status, 200);
      assert.equal((await open.capabilities()).signup, 'open');
      const wrong = await open.signUp({ email: email('test-deployment-wrong'), inviteToken: 'not-a-token' });
      assert.equal(wrong.status, 404, 'a link it is given is still checked');
    } finally { await open.instance.close(); }
  });

  test('an account that reaches the join step without a link on an install is undone, not trusted', async () => {
    const open = await server({ open: true });
    try {
      const address = email('skipped-check');
      assert.equal((await open.signUp({ email: address })).status, 200);
      const id = await accountOf(address);
      assert.ok(id);
      const install = createSignUpLinks({ db: database.db, setupToken: SETUP, invites: null, open: false });
      await assert.rejects(install.made(id, {}), (error: { body?: { code?: string } }) => error.body?.code === 'SIGNUP_NEEDS_LINK');
      assert.equal(await accountOf(address), null, 'the account is removed');
    } finally { await open.instance.close(); }
  });
});

// Setup itself: the company this server already has steps aside for these tests, and comes back after them.
describe('the setup link makes the first account, the owner (#1471)', () => {
  let existing: string;
  before(async () => {
    existing = (await company())[0]!.id;
    await pool.query('UPDATE workspaces SET company = false WHERE id = $1', [existing]);
  });
  after(async () => {
    await pool.query('DELETE FROM workspaces WHERE company');
    await pool.query('UPDATE workspaces SET company = true WHERE id = $1', [existing]);
  });

  test('a Flux with no company says setup; a missing or wrong token makes nothing; the right one makes the owner, once', async () => {
    const flux = await server();
    const unset = await server({ setupToken: null });
    try {
      assert.equal((await flux.capabilities()).setup, true, 'the sign-in page opens Setup');
      const none = await flux.signUp({ email: email('setup-none') });
      assert.deepEqual([none.status, none.code], [403, 'SIGNUP_NEEDS_LINK']);
      const wrongAddress = email('setup-wrong');
      const wrong = await flux.signUp({ email: wrongAddress, setupToken: 'd5'.repeat(32) });
      assert.deepEqual([wrong.status, wrong.code], [403, 'SETUP_LINK_INVALID']);
      assert.equal(await accountOf(wrongAddress), null);
      const missing = await unset.signUp({ email: email('setup-missing'), setupToken: SETUP });
      assert.deepEqual([missing.status, missing.code], [403, 'SETUP_LINK_MISSING'], 'without FLUX_SETUP_TOKEN no first account exists');
      assert.deepEqual(await company(), []);

      const ownerAddress = email('setup-owner');
      const made = await flux.signUp({ email: ownerAddress, setupToken: SETUP });
      assert.equal(made.status, 200, made.body);
      assert.doesNotMatch(made.body, new RegExp(SETUP), 'the token is not echoed');
      const [created, ...more] = await company();
      assert.deepEqual(more, []);
      assert.equal(await roleIn(created!.id, await accountOf(ownerAddress)), 'owner');
      assert.equal((await flux.capabilities()).setup, false);
      const second = await flux.signUp({ email: email('setup-second'), setupToken: SETUP });
      assert.deepEqual([second.status, second.code], [409, 'SETUP_DONE'], 'the link stops mattering once the company exists');
    } finally { await flux.instance.close(); await unset.instance.close(); }
  });

  test('two sign-ups from the setup link at once make one owner, and the other account is undone', async () => {
    await pool.query('DELETE FROM workspaces WHERE company');
    const flux = await server();
    try {
      const addresses = [email('setup-race-a'), email('setup-race-b'), email('setup-race-c')];
      const answers = await Promise.all(addresses.map((address) => flux.signUp({ email: address, setupToken: SETUP })));
      assert.equal(answers.filter((answer) => answer.status === 200).length, 1, answers.map((answer) => answer.body).join(' | '));
      assert.ok(answers.filter((answer) => answer.status !== 200).every((answer) => answer.code === 'SETUP_DONE'));
      const accounts = (await Promise.all(addresses.map(accountOf))).filter(Boolean);
      assert.equal(accounts.length, 1, 'only the owner has an account');
      const [made] = await company();
      assert.equal(await roleIn(made!.id, accounts[0]!), 'owner');
    } finally { await flux.instance.close(); }
  });
});
