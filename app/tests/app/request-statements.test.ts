import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { accessReader } from '@flux/db';
import { evaluateProject } from '@flux/core';
import type { Conversation, WorkItem } from '@flux/contracts';
import { nativeWorkReadUseCases } from '../../apps/server/src/work-read/adapters.js';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { withAgentConnection } from '../../apps/server/src/agent-connection/context.js';
import { registerAgentSearchReads } from '../../apps/server/src/agent-connection/search-reads.js';
import type { AgentToolRegistrar, ToolHandler } from '../../apps/server/src/agent-connection/tool-registry.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createSessionResolver } from '../../apps/server/src/identity/session.js';
import { pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';
import { recordingDatabase, type SentStatement } from './support/statements.js';

// #1429, #1191: the reads the concurrent 1-CPU phase found slow cost their CPU per statement (about 0.2 ms of the API's each, measured on
// the perf seed), so their statement counts are held here, measured 2026-11-13. A change that adds a statement to one of them fails and
// says which statements it sent. Each count is the read's own, without its session checks (the read contract makes them, and
// session-fast-path.test.ts holds what one costs in the API: one statement).
const BUDGET = {
  // One statement for a person's check of a space (were three: the space's company, the role, the space with the level).
  personCheck: 1,
  // BEGIN, the policy check, the observation with its fingerprint, the key window (page and counts in one), the rows, their prerequisites,
  // names and relation counts, the summary, COMMIT; then the final fence's policy check, fingerprint and policy check (were 23).
  workView: 13,
  // BEGIN, policy, observation, the summary, COMMIT, and the fence (were 17).
  workSummary: 8,
  // With a task made from one of the roots: the object window and its rows (4), the edge window and its edges (with the space's
  // company for sealed titles), the sources' window and counts, the edge total, the thoughts. 14 when no root has work (the perf seed; 25 before).
  rootAssociations: 21,
  // The company's standing read once for every audience: the workspaces, then one standing (a person's role; an agent, its owner's and the company's).
  humanAudiences: 2,
  agentAudiences: 4,
};

const { db, statements } = recordingDatabase();
const sessions = createSessionResolver(createAuth({ db, config: loadIdentityConfig(), mailer: null, oauthRequests: createOauthRequests() }));
const listed = (sent: SentStatement[]) => sent.map((statement, index) => `${index + 1}. ${statement.text.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
const session = (statement: SentStatement) => /auth_sessions|"email_verified"/i.test(statement.text);
const within = (label: string, all: SentStatement[], budget: number) => {
  const sent = all.filter((statement) => !session(statement));
  console.log(`${label}: ${sent.length} statements (at most ${budget})`);
  assert.ok(sent.length <= budget, `${label}: ${sent.length} statements, at most ${budget}:\n${listed(sent)}`);
};

describe('the slow reads\' statements (#1429, #1191)', () => {
  let ada: Person;
  let workspaceId: string, projectId: string;
  let roots: Conversation[] = [];

  before(async () => {
    ada = await person('Statements Ada');
    workspaceId = (await workspace(ada, 'Counted statements')).id;
    projectId = (await project(ada, workspaceId, 'Rain barrels', 'workspace')).id;
    const start = async (body: string) => expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
      { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
    roots = [await start('The overflow pipe sits low'), await start('Barrel two fills second')];
    for (let index = 0; index < 6; index++) {
      expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title: `Raise pipe ${index + 1}`,
        owner: { kind: 'human', id: ada.id }, ...(index === 0 ? { sources: [{ type: 'message', id: roots[0]!.messages[0]!.id }] } : {}) } }), 201) as WorkItem;
    }
  });

  test('a person\'s check of a space is one statement, member or not', async () => {
    await evaluateProject({ kind: 'human', id: ada.id }, 'project.read', projectId, accessReader(db)); // the first learns the workspace is not encrypted
    const member = await statements(() => evaluateProject({ kind: 'human', id: ada.id }, 'project.read', projectId, accessReader(db)));
    assert.equal(member.result.allowed, true);
    within('a member\'s check', member.sent, BUDGET.personCheck);
    const stranger = await person('Statements stranger');
    const refused = await statements(() => evaluateProject({ kind: 'human', id: stranger.id }, 'project.read', projectId, accessReader(db)));
    assert.equal(refused.result.allowed, false);
    within('a stranger\'s check', refused.sent, BUDGET.personCheck);
  });

  test('the Tasks work view, the work summary and the roots\' work associations stay within their statements', async () => {
    const headers = { cookie: ada.browser.cookieHeader() };
    const session = await sessions.requirePrincipal({ headers });
    const reads = nativeWorkReadUseCases(db, sessions, session, headers);
    const query = new URLSearchParams({ purpose: 'tasks', group: 'open', mine: 'false', limit: '50' });
    await reads.view(session.principal, projectId, query); // warm: the first read of a workspace learns that it is not encrypted
    const view = await statements(() => reads.view(session.principal, projectId, query));
    assert.equal(view.result.total, 6);
    within('work view (open)', view.sent, BUDGET.workView);
    const summary = await statements(() => reads.summary(session.principal, projectId));
    assert.equal(summary.result.all.open, 6);
    within('work summary', summary.sent, BUDGET.workSummary);
    const messageIds = roots.map((root) => root.messages[0]!.id).sort().join(',');
    const associations = await statements(() => reads.associations(session.principal, projectId, new URLSearchParams({ relation: 'source', limit: '50', messageIds })));
    assert.equal(associations.result.items.length, 1, 'the task made from the first root');
    assert.equal(associations.result.edges.items.length, 1);
    within('root work associations', associations.sent, BUDGET.rootAssociations);
    // Read-only snapshots: no row locks, so their COMMIT writes no WAL and waits for no flush.
    for (const sent of [view.sent, summary.sent, associations.sent]) assert.deepEqual(sent.filter((statement) => /\bfor share\b/i.test(statement.text)), []);
  });

  test('search reads the standing once for all its audiences, a person\'s and an agent\'s', async () => {
    const human = await statements(() => policySearchAccess(db).audiences({ kind: 'human', id: ada.id }));
    assert.ok(human.result.some((audience) => audience.type === 'project'));
    within('a person\'s audiences', human.sent, BUDGET.humanAudiences);
    const agent = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name: 'Counted agent', owner: 'self' } }), 201) as { id: string };
    const audiences = await statements(() => policySearchAccess(db).audiences({ kind: 'agent', id: agent.id }));
    assert.ok(audiences.result.some((audience) => audience.type === 'project'));
    within('an agent\'s audiences', audiences.sent, BUDGET.agentAudiences);
  });

  test('flux_search holds its locks without waiting for a flush; a tool that writes keeps a durable commit', async () => {
    const jonas = await person('Statements Jonas');
    await addMember(ada, workspaceId, jonas, 'member');
    const agent = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name: 'Searching agent', owner: 'self' } }), 201) as { id: string };
    const client = await agentConnection(pool, ada.browser, agent.id, [projectId]);
    // The claims the route builds from the verified bearer.
    const bearer = JSON.parse(Buffer.from(client.accessToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    const claims = { ownerUserId: String(bearer.flux_owner_user_id), connectionId: String(bearer.flux_connection_id), clientId: String(bearer.client_id),
      grantReferenceId: typeof bearer.flux_grant_reference === 'string' ? bearer.flux_grant_reference : null };
    const tools = new Map<string, ToolHandler<never>>();
    registerAgentSearchReads({ registerTool: (name: string, _config: unknown, handler: ToolHandler<never>) => { tools.set(name, handler); } } as unknown as AgentToolRegistrar, db);
    const search = await statements(async () => tools.get('flux_search')!({ q: 'overflow pipe', limit: 10 } as never, { claims }));
    assert.equal(search.result.isError, undefined, JSON.stringify(search.result));
    assert.match(JSON.stringify(search.result), /overflow/);
    assert.equal(search.sent.filter((statement) => /synchronous_commit = off/.test(statement.text)).length, 1, listed(search.sent));
    assert.ok(search.sent.some((statement) => /\bfor share\b/i.test(statement.text)), 'the connection and the owner\'s standing are held while it answers');
    // Whatever the write's own answer (an agent's change may wait under Ask me first), its transaction is never told to skip the flush.
    const write = await statements(() => withAgentConnection(db, claims, 'write', null, async () => 'done', { onlyReads: true }).catch((error: unknown) => error));
    assert.ok(write.sent.length > 0);
    assert.deepEqual(write.sent.filter((statement) => /synchronous_commit/.test(statement.text)), [], 'only a read commits without a flush');
  });
});
