import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { password as localPassword } from '../support/people.js';

/**
 * Human single sign-on (#113) through a real browser authorization-code flow against the disposable
 * Keycloak of scripts/check_oidc.sh. No account rows are written directly: every identity comes from
 * the provider's verified ID token, and every Flux effect goes through the public API.
 */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const providerId = process.env.FLUX_OIDC_PROVIDER_ID!;
const idpPassword = process.env.FLUX_OIDC_TEST_PASSWORD!;
const adminPassword = process.env.FLUX_OIDC_TEST_ADMIN_PASSWORD!;
const mailpit = process.env.FLUX_MAILPIT_URL ?? 'http://mailpit:8025';
const keycloak = 'http://keycloak:8080';

const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
const { pool } = createDatabase(process.env.DATABASE_URL!);
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(providerId && idpPassword && adminPassword, 'check_oidc.sh supplies the provider id and test secrets');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  proxy.close();
  await pool.end();
});

async function fresh() {
  const context = await browser.newContext();
  contexts.push(context);
  return context;
}

/** Runs the visible "Sign in with Keycloak" flow and returns the page where it ends. */
async function sso(context: BrowserContext, username: string, capture?: (url: string) => void): Promise<Page> {
  const page = await context.newPage();
  if (capture) page.on('request', (request) => { if (request.url().includes(`/api/auth/callback/${providerId}`)) capture(request.url()); });
  await page.goto(`${origin}/sign-in`);
  await ssoFrom(page, username);
  return page;
}

/** Clicks "Sign in with Keycloak" on the sign-in page already open and completes the provider login. */
async function ssoFrom(page: Page, username: string) {
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await page.waitForURL((url) => url.origin === keycloak);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(idpPassword);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === origin, { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

async function me(context: BrowserContext) {
  const response = await context.request.get(`${origin}/api/v1/me`);
  return { status: response.status(), body: response.ok() ? await response.json() as { user: { id: string; email: string; name: string } } : null };
}

async function api<T>(context: BrowserContext, method: string, path: string, body?: unknown): Promise<T> {
  const response = await context.request.fetch(`${origin}${path}`, { method, data: body, headers: { origin, 'idempotency-key': randomUUID() } });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return (response.status() === 204 ? null : await response.json()) as T;
}

async function keycloakAdmin() {
  const token = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: adminPassword }) });
  assert.equal(token.status, 200, await token.clone().text());
  const { access_token: accessToken } = await token.json() as { access_token: string };
  const call = async (method: string, path: string, body?: unknown) => fetch(`${keycloak}/admin/realms/flux${path}`, {
    method, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    async setEmail(username: string, email: string) {
      const [user] = await (await call('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)).json() as { id: string }[];
      assert.ok(user, `the IdP user ${username}`);
      const updated = await call('PUT', `/users/${user.id}`, { email, emailVerified: true });
      assert.equal(updated.status, 204, await updated.text());
    },
  };
}

async function mailsTo(address: string) {
  const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  return ((await search.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

async function waitFor<T>(check: () => Promise<T | null | false>, what: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function verifyExtra(context: BrowserContext, address: string) {
  await api(context, 'POST', '/api/v1/notification-address', { email: address });
  const [mail] = await waitFor(async () => { const found = await mailsTo(address); return found.length ? found : null; }, 'the verification email');
  const text = await (await fetch(`${mailpit}/api/v1/message/${mail!.ID}`)).json() as { Text: string };
  const token = new URL(/(http\S+verify\?token=\S+)/.exec(text.Text)![1]!).searchParams.get('token')!;
  await api(context, 'POST', '/api/v1/notification-address/verify', { token });
}

async function mailText(id: string) {
  return (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json() as { Text: string; Subject: string; To: { Address: string }[] });
}

async function status(context: BrowserContext, path: string) {
  return (await context.request.get(`${origin}${path}`)).status();
}

async function inboxItem(context: BrowserContext, match: (item: { id: string; url: string | null }) => boolean, what: string) {
  return waitFor(async () => {
    const inbox = await api<{ items: { id: string; url: string | null }[] }>(context, 'GET', '/api/v1/inbox');
    return inbox.items.find(match) ?? null;
  }, what);
}

const state: { aliceId?: string; bobId?: string; workspace?: string; extra?: string; bobExtra?: string } = {};
let aliceContext: BrowserContext;
let bobContext: BrowserContext;

test('a person signs in with the operator identity provider and gets a Flux account without any grants', async () => {
  aliceContext = await fresh();
  const page = await sso(aliceContext, 'alice');
  assert.equal(new URL(page.url()).pathname, '/', 'single sign-on lands on Home');
  const alice = await me(aliceContext);
  assert.equal(alice.status, 200);
  assert.deepEqual({ email: alice.body!.user.email, name: alice.body!.user.name }, { email: 'alice@acme.test', name: 'Alice Nowak' });
  state.aliceId = alice.body!.user.id;
  const accounts = (await pool.query('SELECT provider_id, account_id FROM auth_accounts WHERE user_id = $1', [state.aliceId])).rows;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider_id, providerId, 'the account is keyed by the issuer-derived provider id');
  assert.match(accounts[0].account_id, /^[0-9a-f-]{36}$/, 'and the stable subject, not the email');
  assert.deepEqual(await api(aliceContext, 'GET', '/api/v1/workspaces'), [], 'identity provider claims grant nothing in Flux');
  const capabilities = await api<{ sso: { providerId: string; label: string } | null }>(aliceContext, 'GET', '/api/v1/auth/capabilities');
  assert.deepEqual(capabilities.sso, { providerId, label: 'Keycloak' });
});

test('mail goes to the chosen mailboxes of a single sign-on person', async () => {
  state.workspace = (await api<{ id: string }>(aliceContext, 'POST', '/api/v1/workspaces', { name: 'Acme lab' })).id;
  bobContext = await fresh();
  await sso(bobContext, 'bob');
  // Bob creates the projects that mention Alice; only workspace admins create projects.
  await api(aliceContext, 'POST', `/api/v1/workspaces/${state.workspace}/members`, { email: 'bob@acme.test', role: 'admin' });
  state.extra = `alice.private-${randomUUID()}@gmail.test`;
  await verifyExtra(aliceContext, state.extra);
  await api(aliceContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: 'both' });
  const before = { account: (await mailsTo('alice@acme.test')).length, extra: (await mailsTo(state.extra)).length };
  const room = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${state.workspace}/projects`, { name: 'Lamp sensors', visibility: 'workspace' });
  await api(bobContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Alice Nowak the sensor arrived', clientMessageId: randomUUID() });
  await waitFor(async () => (await mailsTo('alice@acme.test')).length === before.account + 1 && (await mailsTo(state.extra!)).length === before.extra + 1, 'one email per chosen mailbox');
});

test('each single sign-on person gets exactly the mailboxes they chose: account only, extra only, in-app only', async () => {
  // Alice had BOTH above. Bob gets his own verified private address; each phase checks all four mailboxes.
  state.bobId = (await me(bobContext)).body!.user.id;
  state.bobExtra = `bob.private-${randomUUID()}@gmail.test`;
  await verifyExtra(bobContext, state.bobExtra);
  const mailboxes = { aliceAccount: 'alice@acme.test', aliceExtra: state.extra!, bobAccount: 'bob@acme.test', bobExtra: state.bobExtra };
  const counts = async () => Object.fromEntries(await Promise.all(Object.entries(mailboxes)
    .map(async ([key, address]) => [key, (await mailsTo(address)).length] as const))) as Record<keyof typeof mailboxes, number>;
  const phases = [['account', 'extra'], ['extra', 'both'], ['none', 'account']] as const;
  for (const [aliceChoice, bobChoice] of phases) {
    await api(aliceContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: aliceChoice });
    await api(bobContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: bobChoice });
    const before = await counts();
    // A new project per phase: the calm window allows one email per person and place.
    const room = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${state.workspace}/projects`, { name: `Bench ${aliceChoice}-${bobChoice}`, visibility: 'workspace' });
    const toAlice = await api<{ messages: { id: string }[] }>(bobContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Alice Nowak the calibration log is ready', clientMessageId: randomUUID() });
    const toBob = await api<{ messages: { id: string }[] }>(aliceContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Bob Lis please check the probe', clientMessageId: randomUUID() });
    // The in-app record arrives whatever the email choice, "none" included.
    await inboxItem(aliceContext, (item) => item.url?.endsWith(toAlice.messages[0]!.id) === true, `Alice's in-app record (${aliceChoice})`);
    await inboxItem(bobContext, (item) => item.url?.endsWith(toBob.messages[0]!.id) === true, `Bob's in-app record (${bobChoice})`);
    const gets = (choice: string, kind: 'account' | 'extra') => (choice === kind || choice === 'both' ? 1 : 0);
    const want = {
      aliceAccount: before.aliceAccount + gets(aliceChoice, 'account'), aliceExtra: before.aliceExtra + gets(aliceChoice, 'extra'),
      bobAccount: before.bobAccount + gets(bobChoice, 'account'), bobExtra: before.bobExtra + gets(bobChoice, 'extra'),
    };
    await waitFor(async () => JSON.stringify(await counts()) === JSON.stringify(want), `mail for ${aliceChoice}/${bobChoice}`).catch(async () => {
      assert.deepEqual(await counts(), want, `mailboxes for ${aliceChoice}/${bobChoice}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Exactly these: neither person's private address ever receives the other's notifications.
    assert.deepEqual(await counts(), want, `no other mail for ${aliceChoice}/${bobChoice}`);
  }
  // The notices are the generic one, addressed to the mailbox they reached.
  for (const address of [mailboxes.aliceAccount, mailboxes.aliceExtra, mailboxes.bobAccount, mailboxes.bobExtra]) {
    const [latest] = await mailsTo(address);
    const mail = await mailText(latest!.ID);
    assert.equal(mail.Subject, 'New activity in Flux');
    assert.deepEqual(mail.To.map((to) => to.Address.toLowerCase()), [address.toLowerCase()]);
    assert.ok(!/calibration|probe|Bench|Alice|Bob/.test(mail.Text), 'no private text in the email');
  }
});

test('another single sign-on person cannot claim or receive at someone else\'s verified private address', async () => {
  const aliceExtraBefore = (await mailsTo(state.extra!)).length;
  // Bob verified his own address moments ago; let this send pass the 60 s per-person cooldown.
  await pool.query("UPDATE notification_verification_sends SET last_sent_at = now() - interval '2 minutes' WHERE user_id = $1", [state.bobId]);
  // Bob names Alice's verified private address as his own. It stays an unverified address of his.
  const added = await api<{ email: { extra: { email: string; verified: boolean } | null } }>(bobContext, 'POST', '/api/v1/notification-address', { email: state.extra });
  assert.deepEqual({ email: added.email.extra?.email, verified: added.email.extra?.verified }, { email: state.extra, verified: false });
  // Its verification link goes to that mailbox (Alice's), never to Bob, and only Bob's session could use it.
  const [verification] = await waitFor(async () => { const found = await mailsTo(state.extra!); return found.length === aliceExtraBefore + 1 ? found : null; }, 'the verification email');
  const token = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(verification!.ID)).Text)![1]!).searchParams.get('token')!;
  const aliceTries = await aliceContext.request.post(`${origin}/api/v1/notification-address/verify`, { data: { token }, headers: { origin } });
  assert.equal(aliceTries.status(), 400, 'Alice\'s session cannot verify the address Bob added');
  const alicePrefs = await api<{ email: { extra: { email: string; verified: boolean } | null } }>(aliceContext, 'GET', '/api/v1/notification-preferences');
  assert.deepEqual({ email: alicePrefs.email.extra?.email, verified: alicePrefs.email.extra?.verified }, { email: state.extra, verified: true }, 'Alice keeps her verified address');
  const rows = (await pool.query('SELECT user_id, verified_at IS NOT NULL AS verified FROM notification_addresses WHERE lower(email) = lower($1) ORDER BY user_id', [state.extra])).rows;
  assert.deepEqual(rows.sort((a, b) => Number(b.verified) - Number(a.verified)), [{ user_id: state.aliceId, verified: true }, { user_id: state.bobId, verified: false }]);
  // Bob chooses that address for his email: his notifications still never reach it.
  await api(bobContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: 'extra' });
  const before = { aliceExtra: (await mailsTo(state.extra!)).length, bobAccount: (await mailsTo('bob@acme.test')).length };
  const room = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${state.workspace}/projects`, { name: 'Probe drawer', visibility: 'workspace' });
  const toBob = await api<{ messages: { id: string }[] }>(aliceContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Bob Lis the drawer key is with me', clientMessageId: randomUUID() });
  const notice = await inboxItem(bobContext, (item) => item.url?.endsWith(toBob.messages[0]!.id) === true, 'Bob\'s notification');
  await waitFor(async () => (await pool.query("SELECT 1 FROM notification_emails WHERE notification_id = $1 AND status IN ('queued', 'sending')", [notice.id])).rowCount === 0, 'Bob\'s email to settle');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual({ aliceExtra: (await mailsTo(state.extra!)).length, bobAccount: (await mailsTo('bob@acme.test')).length }, before, 'nothing of Bob\'s reaches Alice\'s mailbox');
  // Bob withdraws the address; Alice's stays verified.
  await api(bobContext, 'DELETE', '/api/v1/notification-address');
  await api(bobContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: 'account' });
  assert.equal((await pool.query('SELECT verified_at IS NOT NULL AS verified FROM notification_addresses WHERE user_id = $1', [state.aliceId])).rows[0].verified, true);
});

test('a single sign-on session can be revoked or signed out, and an email link opens only while its reader is authorized', async () => {
  const second = await fresh();
  await sso(second, 'alice');
  const secondSession = (await second.request.get(`${origin}/api/v1/me`).then((response) => response.json()) as { session: { id: string } }).session.id;
  const sessions = await api<{ id: string; current: boolean }[]>(aliceContext, 'GET', '/api/v1/sessions');
  assert.ok(sessions.some((session) => session.id === secondSession && !session.current), 'Alice sees her other single sign-on session');
  // Revocation takes effect on the next request: no cookie cache.
  await api(aliceContext, 'DELETE', `/api/v1/sessions/${secondSession}`);
  for (const path of ['/api/v1/me', '/api/v1/inbox', '/api/v1/notification-preferences', '/api/v1/workspaces']) assert.equal(await status(second, path), 401, `revoked: ${path}`);
  assert.equal((await me(aliceContext)).status, 200, 'the other session is unaffected');

  // A notification in Bob's own workspace, emailed to Alice's private address.
  await api(aliceContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: 'extra' });
  const bench = (await api<{ id: string }>(bobContext, 'POST', '/api/v1/workspaces', { name: 'Bob bench' })).id;
  await api(bobContext, 'POST', `/api/v1/workspaces/${bench}/members`, { email: 'alice@acme.test', role: 'member' });
  const room = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${bench}/projects`, { name: 'Oscilloscope', visibility: 'workspace' });
  const before = (await mailsTo(state.extra!)).length;
  const thread = await api<{ messages: { id: string }[] }>(bobContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Alice Nowak the scope trace is attached', clientMessageId: randomUUID() });
  const item = await inboxItem(aliceContext, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Alice\'s in-app record');
  const [mail] = await waitFor(async () => { const found = await mailsTo(state.extra!); return found.length === before + 1 ? found : null; }, 'the email to Alice\'s private address');
  const link = /(http\S+\/inbox\/\S+)/.exec((await mailText(mail!.ID)).Text)![1]!;
  assert.equal(link, `${origin}/inbox/${item.id}`, 'the email links to the notification, which rechecks access');
  const target = new URL(item.url!, origin).pathname;

  // Signed in and authorized: the link opens the exact message.
  const page = await aliceContext.newPage();
  await page.goto(link);
  await page.waitForURL((url) => url.pathname === target, { timeout: 15_000 });
  assert.equal(await status(aliceContext, `/api/v1/inbox/${item.id}`), 200);
  // Another person, the revoked session and a browser without a session: nothing opens.
  assert.equal(await status(bobContext, `/api/v1/inbox/${item.id}`), 404, 'not Bob\'s notification');
  const bobPage = await bobContext.newPage();
  await bobPage.goto(link);
  await bobPage.getByText('This is not available to you').waitFor();
  assert.equal(await status(second, `/api/v1/inbox/${item.id}`), 401);
  const revokedPage = await second.newPage();
  await revokedPage.goto(link);
  await revokedPage.waitForURL((url) => url.pathname === '/sign-in');
  assert.equal(new URL(revokedPage.url()).searchParams.get('next'), `/inbox/${item.id}`);
  // Signing in again with single sign-on from that page leads back to the message.
  const returning = await fresh();
  const returningPage = await returning.newPage();
  await returningPage.goto(link);
  await returningPage.waitForURL((url) => url.pathname === '/sign-in');
  await ssoFrom(returningPage, 'alice');
  await returningPage.waitForURL((url) => url.pathname === target, { timeout: 15_000 });
  // Removed from Bob's workspace, Alice can no longer open the same link anywhere.
  await api(bobContext, 'DELETE', `/api/v1/workspaces/${bench}/members/${state.aliceId}`);
  assert.equal(await status(aliceContext, `/api/v1/inbox/${item.id}`), 404, 'access is rechecked when the link is opened');
  const afterRemoval = await aliceContext.newPage();
  await afterRemoval.goto(link);
  await afterRemoval.getByText('This is not available to you').waitFor();
  assert.notEqual(new URL(afterRemoval.url()).pathname, target);

  // Signing out ends the session; Alice's mail keeps going only to her own private address.
  await api(aliceContext, 'POST', '/api/auth/sign-out', {});
  for (const path of ['/api/v1/me', '/api/v1/inbox', '/api/v1/notification-preferences']) assert.equal(await status(aliceContext, path), 401, `signed out: ${path}`);
  await api(returning, 'POST', '/api/auth/sign-out', {});
  const counts = async () => ({ aliceAccount: (await mailsTo('alice@acme.test')).length, aliceExtra: (await mailsTo(state.extra!)).length, bobExtra: (await mailsTo(state.bobExtra!)).length });
  const quiet = await counts();
  const later = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${state.workspace}/projects`, { name: 'After hours', visibility: 'workspace' });
  await api(bobContext, 'POST', `/api/v1/projects/${later.id}/conversations`, { body: '@Alice Nowak the door code changed', clientMessageId: randomUUID() });
  await waitFor(async () => (await counts()).aliceExtra === quiet.aliceExtra + 1, 'the email while Alice has no session');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(await counts(), { ...quiet, aliceExtra: quiet.aliceExtra + 1 }, 'only Alice\'s private address, once');

  // Single sign-on again: the same person, her grants and her verified address.
  aliceContext = await fresh();
  await sso(aliceContext, 'alice');
  const alice = await me(aliceContext);
  assert.equal(alice.body!.user.id, state.aliceId);
  assert.deepEqual((await api<{ id: string }[]>(aliceContext, 'GET', '/api/v1/workspaces')).map((entry) => entry.id), [state.workspace]);
  const preferences = await api<{ email: { destination: string; extra: { email: string; verified: boolean } | null } }>(aliceContext, 'GET', '/api/v1/notification-preferences');
  assert.deepEqual({ email: preferences.email.extra?.email, verified: preferences.email.extra?.verified }, { email: state.extra, verified: true });
  // Back to both mailboxes for the email-change check that follows.
  await api(aliceContext, 'PATCH', '/api/v1/notification-preferences', { emailDestination: 'both' });
});

test('the same subject keeps the same person, grants and verified address when the provider changes the email', async () => {
  const admin = await keycloakAdmin();
  // The provider now reports her already verified private address as the sign-in email.
  await admin.setEmail('alice', state.extra!);
  const again = await fresh();
  await sso(again, 'alice');
  const alice = await me(again);
  assert.equal(alice.body!.user.id, state.aliceId, 'the same Flux person');
  assert.equal(alice.body!.user.email, state.extra, 'with the provider\'s new verified email');
  const workspaces = await api<{ id: string }[]>(again, 'GET', '/api/v1/workspaces');
  assert.deepEqual(workspaces.map((item) => item.id), [state.workspace], 'grants stay with the person');
  const preferences = await api<{ email: { extra: { email: string; verified: boolean } | null } }>(again, 'GET', '/api/v1/notification-preferences');
  assert.deepEqual({ email: preferences.email.extra?.email, verified: preferences.email.extra?.verified }, { email: state.extra, verified: true });
  // Account and extra are now one mailbox: one message, not two.
  const before = (await mailsTo(state.extra!)).length;
  const room = await api<{ id: string }>(bobContext, 'POST', `/api/v1/workspaces/${state.workspace}/projects`, { name: 'Shared mailbox', visibility: 'workspace' });
  await api(bobContext, 'POST', `/api/v1/projects/${room.id}/conversations`, { body: '@Alice Nowak one notice, please', clientMessageId: randomUUID() });
  await waitFor(async () => (await mailsTo(state.extra!)).length >= before + 1, 'the email to the shared mailbox');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await mailsTo(state.extra!)).length, before + 1, 'exactly one message reaches the shared mailbox');
});

test('a new identity with an existing account\'s email cannot take that account', async () => {
  const local = await fresh();
  const signUp = await local.request.post(`${origin}/api/auth/sign-up/email`, { data: { name: 'Dave Local', email: 'dave@acme.test', password: localPassword }, headers: { origin } });
  assert.ok(signUp.ok(), await signUp.text());
  const localId = (await me(local)).body!.user.id;
  const attempt = await fresh();
  const page = await sso(attempt, 'dave');
  assert.equal(new URL(page.url()).pathname, '/sign-in');
  assert.equal(new URL(page.url()).searchParams.get('sso'), 'failed');
  await page.getByText('Single sign-on didn’t complete').waitFor();
  assert.equal((await me(attempt)).status, 401, 'no session for the provider identity');
  const accounts = (await pool.query('SELECT provider_id FROM auth_accounts WHERE user_id = $1', [localId])).rows.map((row) => row.provider_id);
  assert.deepEqual(accounts, ['credential'], 'the local account was not linked to the new identity');
});

test('an email the provider has not verified does not sign in', async () => {
  const context = await fresh();
  const page = await sso(context, 'carol');
  assert.equal(new URL(page.url()).searchParams.get('sso'), 'failed');
  assert.equal((await me(context)).status, 401);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE email = $1', ['carol@acme.test'])).rows[0].n, 0);
});

test('a replayed or forged callback signs nobody in', async () => {
  let callback = '';
  const first = await fresh();
  await sso(first, 'bob', (url) => { callback = url; });
  assert.ok(callback.includes('code='), 'the real callback was observed');
  const replay = await fresh();
  const replayed = await replay.newPage();
  await replayed.goto(callback);
  assert.equal((await me(replay)).status, 401, 'a used authorization response cannot be replayed in another browser');
  const forged = await fresh();
  const page = await forged.newPage();
  const url = new URL(callback);
  url.searchParams.set('state', 'forged-state');
  await page.goto(url.toString());
  assert.equal((await me(forged)).status, 401, 'an unknown state is refused');
});

test('a raw ID token presented directly does not sign in', async () => {
  const context = await fresh();
  const forgedToken = ['{"alg":"none"}', JSON.stringify({ iss: 'http://keycloak:8080/realms/flux', sub: 'forged', email: 'alice@acme.test', email_verified: true })]
    .map((part) => Buffer.from(part).toString('base64url')).join('.') + '.';
  const response = await context.request.post(`${origin}/api/auth/sign-in/social`, { data: { provider: providerId, idToken: { token: forgedToken } }, headers: { origin } });
  assert.equal(response.status(), 400);
  assert.equal((await response.json() as { code: string }).code, 'ID_TOKEN_SIGN_IN_DISABLED');
  assert.equal((await me(context)).status, 401);
});
