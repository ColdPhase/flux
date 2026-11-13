import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { projectAiPolicyPath, type ProjectGrant } from '@flux/contracts';
import { coworkPlaybookReference } from '@flux/core';
import { loseSpace, pool } from './support/db.js';
import { apiUrl, Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, consentContext, decideConsent, exchangeCode, expect, mcp, oauthToken, toolValue, type OauthStart, type Tokens } from './support/mcp.js';
import { registerOauthClient, userIdOf } from './support/mcp-actions.js';
import { password } from './support/people.js';

// Signing in a local client is one click (#859, F-036 LC-1). These are the attacks on that click: nothing exists before Allow, Deny and a
// look at the page make nothing, a signed request is bound to the session that reached the page, a person outside the company cannot
// connect, and what the client is afterwards (rights, Ask me first, Disconnect) is the person's, never more. Everything goes through
// the real authorization, consent, token and `/mcp` routes.

interface Owner { browser: Browser; userId: string; workspaceId: string; projectId: string }
async function owner(label: string): Promise<Owner> {
  const { browser } = await register(uniqueEmail(label), password, label);
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: `${label} company` } }), 201);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: `${label} study`, visibility: 'restricted' } }), 201);
  return { browser, userId: await userIdOf(browser), workspaceId: String(workspace.id), projectId: String(project.id) };
}

/** What exists for a person that a sign-in could have made: agents, client connections, the bindings tokens point to. */
async function made(userId: string) {
  const count = async (sql: string) => Number((await pool.query(sql, [userId])).rows[0].n);
  return {
    agents: await count('SELECT count(*)::int AS n FROM agents WHERE owner_user_id = $1'),
    connections: await count("SELECT count(*)::int AS n FROM agent_connections WHERE owner_user_id = $1 AND compute_source <> 'owner_assistant'"),
    bindings: await count('SELECT count(*)::int AS n FROM agent_oauth_bindings WHERE owner_user_id = $1'),
  };
}
const nothing = { agents: 0, connections: 0, bindings: 0 };
const claimsOf = (tokens: Tokens) => JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { scope: string; flux_connection_id: string; flux_owner_user_id: string; azp: string };
const call = (tokens: Tokens, name: string, args: Record<string, unknown> = {}) => mcp(tokens.access_token, 1, 'tools/call', { name, arguments: args });
const listedProjects = async (tokens: Tokens) => (toolValue((await call(tokens, 'flux_list_contexts')).message).projects as { id: string }[]).map((project) => project.id);
const refused = (answer: Awaited<ReturnType<typeof call>>) => answer.status !== 200 || (answer.message?.result as { isError?: boolean } | undefined)?.isError === true;

describe('nothing exists before the person allows', () => {
  test('looking at the request and pressing Deny make no agent, no connection and no binding, and the client gets no code', async () => {
    const nora = await owner('nora-deny');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const begun = await beginOauth(nora.browser, clientId, redirectUri);
    assert.equal(begun.consent, true, 'a first sign-in goes to the consent page');
    const shown = await consentContext(nora.browser, begun);
    assert.equal(shown.connectionName, null, 'there is no connection to sign in again');
    assert.deepEqual(await made(nora.userId), nothing, 'looking at the page made nothing');
    const denied = await decideConsent(nora.browser, begun, false);
    const target = new URL(String((denied.json as { url?: string; redirect_uri?: string }).url ?? (denied.json as { redirect_uri?: string }).redirect_uri ?? denied.headers.get('location')));
    assert.equal(target.searchParams.get('error'), 'access_denied');
    assert.equal(target.searchParams.get('code'), null, 'a denied request carries no code');
    assert.deepEqual(await made(nora.userId), nothing, 'Deny made nothing');
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM oauth_consent WHERE user_id = $1', [nora.userId])).rows[0].n), 0, 'and no consent is remembered');
  });

  test('Allow makes one agent and one connection in the person\'s own company: theirs, at "Do it and tell me", with no grant of its own', async () => {
    const nora = await owner('nora-allow');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const tokens = await oauthToken(nora.browser, clientId, redirectUri);
    assert.deepEqual(await made(nora.userId), { agents: 1, connections: 1, bindings: 1 });
    const [connection] = (await pool.query(`SELECT c.id, c.workspace_id, c.owner_user_id, c.may_do, c.compute_source, c.name, a.owner_user_id AS agent_owner, a.workspace_id AS agent_workspace
      FROM agent_connections c JOIN agents a ON a.id = c.agent_id WHERE c.owner_user_id = $1`, [nora.userId])).rows;
    assert.deepEqual({ ...connection }, { id: claimsOf(tokens).flux_connection_id, workspace_id: nora.workspaceId, owner_user_id: nora.userId, may_do: 'act',
      compute_source: 'user_operated_external_client', name: 'Flux HTTP test client on this computer', agent_owner: nora.userId, agent_workspace: nora.workspaceId });
    assert.equal(claimsOf(tokens).scope, 'offline_access', 'the only scope there is');
    assert.equal(claimsOf(tokens).flux_owner_user_id, nora.userId);
    const grants = expect(await nora.browser.request('GET', `/api/v1/projects/${nora.projectId}/grants`), 200) as unknown as ProjectGrant[];
    assert.ok(!grants.some((grant) => (grant.principal as { kind: string }).kind === 'agent'), 'the agent holds no grant: its access is its owner\'s');
  });

  test('two Allows of the same client at the same moment make one connection, and both tokens belong to it', async () => {
    const nora = await owner('nora-race');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const [first, second] = [await beginOauth(nora.browser, clientId, redirectUri), await beginOauth(nora.browser, clientId, redirectUri)];
    assert.ok(first.consent && second.consent, 'neither request found a connection yet');
    const [a, b] = await Promise.all([decideConsent(nora.browser, first, true), decideConsent(nora.browser, second, true)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const tokens = [await exchangeCode(new URL(String((a.json as { url: string }).url)), clientId, redirectUri, first),
      await exchangeCode(new URL(String((b.json as { url: string }).url)), clientId, redirectUri, second)];
    assert.deepEqual(await made(nora.userId), { agents: 1, connections: 1, bindings: 1 }, 'one agent, one connection, one binding');
    assert.equal(claimsOf(tokens[0]!).flux_connection_id, claimsOf(tokens[1]!).flux_connection_id);
  });
});

describe('the one scope', () => {
  test('a client that sends no scope, and one that asks for an old Flux scope, are not given more than offline_access', async () => {
    const nora = await owner('nora-scope');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = (scope?: string) => {
      const url = new URL('/api/auth/oauth2/authorize', publicOrigin);
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', state: randomUUID(), resource: `${publicOrigin}/mcp`, ...(scope === undefined ? {} : { scope }) }).toString();
      return nora.browser.request('GET', `${url.pathname}${url.search}`, { headers: { accept: 'text/html' } });
    };
    const target = (response: Awaited<ReturnType<typeof authorize>>) => new URL(String(response.headers.get('location') ?? (response.json as { url?: string } | null)?.url ?? ''), publicOrigin);
    // Asking for an old scope is refused by the provider before any page; asking for none leads to the one consent page (or a plain refusal), never to a wider grant.
    const old = target(await authorize('flux.action.execute'));
    assert.notEqual(old.pathname, '/consent', 'an old Flux scope gets no consent page');
    const none = target(await authorize());
    if (none.pathname === '/consent') {
      const context = expect(await nora.browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(none.search.slice(1))}`), 200);
      assert.equal(context.connectionName, null);
    }
    assert.deepEqual(await made(nora.userId), nothing, 'neither made anything');
  });
});

describe('the signed request is the person\'s own, and only a member of the company can connect', () => {
  test('another person\'s session, no session and a changed request cannot allow it, and nothing is made', async () => {
    const nora = await owner('nora-bound');
    const mallory = await owner('mallory');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const begun = await beginOauth(nora.browser, clientId, redirectUri);
    const asOther = await decideConsent(mallory.browser, begun, true);
    assert.ok(asOther.status >= 400 && asOther.status < 500, `another session's Allow answered ${asOther.status}`);
    assert.equal((await mallory.browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(begun.oauthQuery)}`)).status, 400,
      'the page\'s data is not shown to another session either');
    const anonymous = await decideConsent(new Browser(), begun, true);
    assert.ok(anonymous.status >= 400 && anonymous.status < 500, `no session answered ${anonymous.status}`);
    for (const [key, value] of [['state', 'forged-state'], ['redirect_uri', 'http://127.0.0.1:1/callback'], ['client_id', 'someone-else'], ['scope', 'flux.action.execute']]) {
      const changed = new URLSearchParams(begun.oauthQuery); changed.set(key, value);
      const answer = await decideConsent(nora.browser, { ...begun, oauthQuery: changed.toString() } as OauthStart, true);
      assert.ok(answer.status >= 400 && answer.status < 500, `a changed ${key} answered ${answer.status}`);
    }
    for (const userId of [nora.userId, mallory.userId]) assert.deepEqual(await made(userId), nothing);
    // Negative control: the unchanged request, allowed by the person it was made for, works once.
    const allowed = await decideConsent(nora.browser, begun, true);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await made(nora.userId), { agents: 1, connections: 1, bindings: 1 });
    assert.deepEqual(await made(mallory.userId), nothing);
  });

  test('a person with no company and a guest of one are refused: no agent, no connection, no code', async () => {
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const lone = (await register(uniqueEmail('no-company'), password, 'No Company')).browser;
    const guest = (await register(uniqueEmail('a-guest'), password, 'A Guest')).browser;
    const host = await owner('host');
    expect(await host.browser.request('POST', `/api/v1/workspaces/${host.workspaceId}/members`,
      { body: { email: ((await pool.query('SELECT email FROM auth_users WHERE id = $1', [await userIdOf(guest)])).rows[0] as { email: string }).email, role: 'guest' } }), 201);
    for (const browser of [lone, guest]) {
      const begun = await beginOauth(browser, clientId, redirectUri);
      assert.equal((await browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(begun.oauthQuery)}`)).status, 403);
      const answer = await decideConsent(browser, begun, true);
      assert.ok(answer.status >= 400 && answer.status < 500, `Allow answered ${answer.status}`);
      assert.equal(JSON.stringify(answer.json ?? '').includes('code='), false);
      assert.deepEqual(await made(await userIdOf(browser)), nothing);
    }
  });

  test('a client that is disabled, or unknown, is not offered the page', async () => {
    const nora = await owner('nora-disabled');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    await pool.query('UPDATE oauth_client SET disabled = true WHERE client_id = $1', [clientId]);
    const begun = await beginOauth(nora.browser, clientId, redirectUri).catch(() => null);
    if (begun?.consent) {
      assert.notEqual((await nora.browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(begun.oauthQuery)}`)).status, 200);
      assert.ok((await decideConsent(nora.browser, begun, true)).status >= 400);
    }
    assert.deepEqual(await made(nora.userId), nothing);
  });
});

describe('the client is the person, and no more', () => {
  test('it sees and changes only what its owner can, and loses it the moment the owner does', async () => {
    const nora = await owner('nora-rights');
    const other = await owner('other-company');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const tokens = await oauthToken(nora.browser, clientId, redirectUri);
    assert.deepEqual(await listedProjects(tokens), [nora.projectId], 'exactly the owner\'s own space');
    const foreign = await call(tokens, 'flux_bootstrap', { projectId: other.projectId, clientSessionId: randomUUID() });
    assert.ok(refused(foreign), 'another person\'s space is refused');
    assert.ok(!JSON.stringify(foreign.message).includes('other-company'), 'and says nothing about it');
    const restore = await loseSpace(nora.projectId, nora.userId);
    try {
      assert.deepEqual(await listedProjects(tokens), [], 'the owner lost the space, so the client did at the next call');
      assert.ok(refused(await call(tokens, 'flux_bootstrap', { projectId: nora.projectId, clientSessionId: randomUUID() })));
    } finally { await restore(); }
    assert.deepEqual(await listedProjects(tokens), [nora.projectId], 'and gets it back with its owner');
  });

  test('a space whose AI is blocked is closed to the client, and opens again with it', async () => {
    const nora = await owner('nora-ai');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const tokens = await oauthToken(nora.browser, clientId, redirectUri);
    assert.deepEqual(await listedProjects(tokens), [nora.projectId]);
    expect(await nora.browser.request('PUT', projectAiPolicyPath(nora.projectId), { body: { state: 'blocked' } }), 200);
    assert.deepEqual(await listedProjects(tokens), [], 'a blocked space is not listed');
    assert.ok(refused(await call(tokens, 'flux_bootstrap', { projectId: nora.projectId, clientSessionId: randomUUID() })));
    expect(await nora.browser.request('PUT', projectAiPolicyPath(nora.projectId), { body: { state: 'allowed' } }), 200);
    assert.deepEqual(await listedProjects(tokens), [nora.projectId]);
  });

  test('the client cannot widen itself: Ask me first is the owner\'s alone, in a signed-in session', async () => {
    const nora = await owner('nora-widen');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const tokens = await oauthToken(nora.browser, clientId, redirectUri);
    const connectionId = claimsOf(tokens).flux_connection_id;
    expect(await nora.browser.request('PATCH', `/api/v1/agent-connections/${connectionId}`, { body: { mayDo: 'ask' } }), 200);
    const bearer = new Browser();
    const widen = await bearer.request('PATCH', `/api/v1/agent-connections/${connectionId}`, { body: { mayDo: 'act' }, headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.ok([401, 403].includes(widen.status), `the client's own token answered ${widen.status}`);
    assert.equal((await pool.query('SELECT may_do FROM agent_connections WHERE id = $1', [connectionId])).rows[0].may_do, 'ask');
  });
});

describe('Disconnect and signing in again', () => {
  test('the token dies at once; signing in again gives the same agent back on a new connection, and never the assistant\'s', async () => {
    const nora = await owner('nora-again');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const first = await oauthToken(nora.browser, clientId, redirectUri);
    const firstConnection = claimsOf(first).flux_connection_id;
    const agentOf = async (connectionId: string) => String((await pool.query('SELECT agent_id FROM agent_connections WHERE id = $1', [connectionId])).rows[0].agent_id);
    expect(await nora.browser.request('DELETE', `/api/v1/agent-connections/${firstConnection}`), 204);
    assert.notEqual((await mcp(first.access_token, 2, 'tools/list')).status, 200, 'the token stops at once');
    const begun = await beginOauth(nora.browser, clientId, redirectUri);
    assert.equal(begun.consent, true, 'a disconnected client is asked again');
    assert.equal((await consentContext(nora.browser, begun)).connectionName, null);
    const second = await oauthToken(nora.browser, clientId, redirectUri, begun);
    const secondConnection = claimsOf(second).flux_connection_id;
    assert.notEqual(secondConnection, firstConnection, 'a new connection');
    assert.equal(await agentOf(secondConnection), await agentOf(firstConnection), 'the same agent: what it did stays with one identity');
    assert.equal((await mcp(second.access_token, 3, 'tools/list')).status, 200);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM agents WHERE owner_user_id = $1', [nora.userId])).rows[0].n), 1);
    // A binding that points at the owner's assistant connection (a seeded mistake) is never carried by a sign-in.
    const assistant = randomUUID();
    await pool.query(`INSERT INTO agent_connections (id, workspace_id, owner_user_id, agent_id, name, client_designation, compute_source)
      VALUES ($1, $2, $3, $4, 'Your assistant', 'other', 'owner_assistant')`, [assistant, nora.workspaceId, nora.userId, await agentOf(secondConnection)]);
    const stranger = (await registerOauthClient(pool)).clientId;
    await pool.query('INSERT INTO agent_oauth_bindings (id, owner_user_id, connection_id, client_id) VALUES ($1, $2, $3, $4)', [randomUUID(), nora.userId, assistant, stranger]);
    const third = await oauthToken(nora.browser, stranger, redirectUri);
    assert.notEqual(claimsOf(third).flux_connection_id, assistant, 'the assistant\'s connection is never a client\'s');
  });

  test('one client of two people: the second person\'s sign-in neither finds nor changes the first person\'s connection', async () => {
    const nora = await owner('nora-two');
    const jonas = await owner('jonas-two');
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const noras = await oauthToken(nora.browser, clientId, redirectUri);
    const begun = await beginOauth(jonas.browser, clientId, redirectUri);
    assert.equal(begun.consent, true, 'Jonas is asked: Nora\'s connection is not his');
    assert.equal((await consentContext(jonas.browser, begun)).connectionName, null);
    const jonass = await oauthToken(jonas.browser, clientId, redirectUri, begun);
    assert.notEqual(claimsOf(jonass).flux_connection_id, claimsOf(noras).flux_connection_id);
    assert.equal(claimsOf(jonass).flux_owner_user_id, jonas.userId);
    assert.deepEqual(await listedProjects(jonass), [jonas.projectId]);
    assert.deepEqual(await listedProjects(noras), [nora.projectId]);
  });
});

// C-22 (review of #943, B1): a client lives only while its owner is a non-guest member of the company. The check runs in the same
// transaction as every call, before any write, and where connections are resolved, so tokens and refreshes stop as well.
describe('a client stops when its owner leaves the company or becomes a guest of it', () => {
  async function clientOfMember(label: string) {
    const host = await owner(`${label}-host`);
    const { browser } = await register(uniqueEmail(`${label}-member`), password, `${label} Member`);
    const memberId = await userIdOf(browser);
    const email = String((await pool.query('SELECT email FROM auth_users WHERE id = $1', [memberId])).rows[0].email);
    expect(await host.browser.request('POST', `/api/v1/workspaces/${host.workspaceId}/members`, { body: { email, role: 'member' } }), 201);
    expect(await host.browser.request('POST', `/api/v1/projects/${host.projectId}/grants`, { body: { principal: { kind: 'human', id: memberId }, role: 'contributor' } }), 201);
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const tokens = await oauthToken(browser, clientId, redirectUri);
    return { host, browser, memberId, clientId, redirectUri, tokens, connectionId: claimsOf(tokens).flux_connection_id };
  }
  const refresh = (tokens: Tokens, clientId: string) => fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }) });

  /** What a project-independent call (an acknowledgement, the playbook resource) must not do after the owner is gone. */
  async function assertStopped(world: Awaited<ReturnType<typeof clientOfMember>>, reference = coworkPlaybookReference()) {
    const ack = (clientSessionId: string) => call(world.tokens, 'flux_acknowledge_playbook', { clientSessionId, bundleId: reference.bundleId, version: reference.version, digest: reference.digest });
    const runtimes = async () => Number((await pool.query('SELECT count(*)::int AS n FROM agent_runtime_sessions WHERE connection_id = $1', [world.connectionId])).rows[0].n);
    const before = await runtimes();
    assert.ok(refused(await ack(randomUUID())), 'the acknowledgement is refused');
    const resource = await mcp(world.tokens.access_token, 3, 'resources/read', { uri: reference.retrievalReference });
    assert.ok(!JSON.stringify(resource.message ?? '').includes(reference.digest), 'the playbook is not delivered');
    assert.equal(await runtimes(), before, 'a refused call makes no runtime session');
    assert.ok(refused(await call(world.tokens, 'flux_bootstrap', { projectId: world.host.projectId, clientSessionId: randomUUID() })), 'and nothing in the space is reachable');
    const again = await refresh(world.tokens, world.clientId);
    assert.ok(again.status >= 400 && again.status < 500, `a refresh is refused (${again.status})`);
    // Signing in again is not silent: the person is sent to the page, and the page refuses someone outside the company.
    const begun = await beginOauth(world.browser, world.clientId, world.redirectUri);
    assert.equal(begun.consent, true, 'no silent sign-in');
    assert.equal((await world.browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(begun.oauthQuery)}`)).status, 403);
  }

  test('removed from the company: calls, resources, refreshes and a silent sign-in all stop, and no row is written', async () => {
    const world = await clientOfMember('c22-removed');
    const reference = coworkPlaybookReference();
    const first = await call(world.tokens, 'flux_acknowledge_playbook', { clientSessionId: randomUUID(), bundleId: reference.bundleId, version: reference.version, digest: reference.digest });
    assert.ok(!refused(first), 'control: a member acknowledges the playbook');
    assert.deepEqual(await listedProjects(world.tokens), [world.host.projectId], 'control: and reaches the space');
    expect(await world.host.browser.request('DELETE', `/api/v1/workspaces/${world.host.workspaceId}/members/${world.memberId}`), 204);
    await assertStopped(world, reference);
  });

  test('made a guest: the same, and a fresh sign-in gets no token without the page', async () => {
    const world = await clientOfMember('c22-guest');
    expect(await world.host.browser.request('PATCH', `/api/v1/workspaces/${world.host.workspaceId}/members/${world.memberId}`, { body: { role: 'guest' } }), 200);
    await assertStopped(world);
  });

  // #978: the role that counts is the company's. A member of some other workspace (an encrypted space) who is a guest of the company
  // has no AI: the client they had stops, and a person who never connected gets no page and no agent.
  const makeCompanyGuest = async (userId: string) => {
    const company = String((await pool.query('SELECT id FROM workspaces WHERE company')).rows[0].id);
    await pool.query("INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'guest', $2) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'guest'", [company, userId]);
  };

  test('a guest of the company stops a client they had, though they are still a member of the workspace it was made in', async () => {
    const world = await clientOfMember('c22-company-guest');
    assert.deepEqual(await listedProjects(world.tokens), [world.host.projectId], 'control: a member of that workspace reaches it');
    await makeCompanyGuest(world.memberId);
    assert.equal(String((await pool.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [world.host.workspaceId, world.memberId])).rows[0].role), 'member', 'their role there is unchanged');
    await assertStopped(world);
  });

  test('a guest of the company who is a member of another workspace cannot connect: no page, no agent, no connection, no code', async () => {
    const host = await owner('c22-company-guest-host');
    const { browser } = await register(uniqueEmail('c22-company-guest-new'), password, 'Company Guest New');
    const userId = await userIdOf(browser);
    const email = String((await pool.query('SELECT email FROM auth_users WHERE id = $1', [userId])).rows[0].email);
    expect(await host.browser.request('POST', `/api/v1/workspaces/${host.workspaceId}/members`, { body: { email, role: 'member' } }), 201);
    await makeCompanyGuest(userId);
    const { clientId, redirectUri } = await registerOauthClient(pool);
    const begun = await beginOauth(browser, clientId, redirectUri);
    assert.equal((await browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(begun.oauthQuery)}`)).status, 403);
    const answer = await decideConsent(browser, begun, true);
    assert.ok(answer.status >= 400 && answer.status < 500, `Allow answered ${answer.status}`);
    assert.equal(JSON.stringify(answer.json ?? '').includes('code='), false);
    assert.deepEqual(await made(userId), nothing);
  });
});
