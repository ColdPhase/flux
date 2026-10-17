import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { AGENT_RUNTIME_PATH, type AgentRuntimeStatus } from '@flux/contracts';
import { loadAgentRuntimeConfig } from '@flux/core';
import { createDatabase } from '@flux/db';
import { agentRuntimeRoutes } from '../../apps/server/src/agent-runtime/routes.js';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { connectionString } from './support/db.js';
import { Browser } from './support/http.js';
import { expectStatus, password, person } from './support/people.js';

// F-027 AST-1.3, the database half (#493): after the launcher's typed `y`, an actual app and database run shows exactly
// one operator statement row with today's date. The launcher half (what ./flux up and ./flux ai on write to docker/.env
// for Enter/Enter, Enter/y and n, with a fake TTY and a fake host check) is tests/test_flux_subscription_question.py. Here
// the API's own start path reads those same lines through loadAgentRuntimeConfig and registers its real runtime routes
// (recordCommercialTerms) on the normal test stack's PostgreSQL, as the API container does at start.

const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
const origin = 'http://127.0.0.1:18279';
const authSecret = process.env.FLUX_AUTH_SECRET ?? `operator-statement-${'x'.repeat(40)}`;
const TODAY = new Date().toISOString().slice(0, 10);
// docker/compose.yaml hands the API these two values and FLUX_RUNTIME_MANAGER_SECRET, which ./flux generates.
const generated = { FLUX_RUNTIME_MANAGER_SECRET: `launcher-generated-${'x'.repeat(32)}` };
const AFTER_ANSWER = {
  'Enter, Enter (Codex only)': { ...generated, FLUX_AGENT_RUNTIME: 'codex', FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: '' },
  'Enter, y (Codex and Claude Code, with the statement)': { ...generated, FLUX_AGENT_RUNTIME: 'codex,claude_code', FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: TODAY },
  'n (nothing written)': { ...generated, FLUX_AGENT_RUNTIME: '', FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: '' },
};
const apps: FastifyInstance[] = [];

/** One start of the API with the environment the launcher left; returns the running app (the real routes, its own Better Auth). */
async function start(env: Record<string, string>): Promise<{ app: FastifyInstance; url: string }> {
  const config = loadAgentRuntimeConfig(env);
  const app = Fastify({ logger: false });
  apps.push(app);
  const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: origin, FLUX_AUTH_SECRET: authSecret, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(agentRuntimeRoutes, { db, sessions: identity, config, secret: authSecret, publicOrigin: origin });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

const statements = async (agreedOn?: string) => {
  const { rows } = await pool.query<{ statement: string; agreed_on: string; recorded_at: Date }>(
    `SELECT statement, agreed_on::text AS agreed_on, recorded_at FROM agent_runtime_operator_statements ${agreedOn ? 'WHERE agreed_on = $1::date' : ''} ORDER BY agreed_on`, agreedOn ? [agreedOn] : []);
  return rows;
};

describe('the operator statement after the launcher question (AST-1.3, database half)', () => {
  after(async () => {
    for (const app of apps) await app.close();
    // The test owns today's row; it leaves none behind for the next file.
    await pool.query(`DELETE FROM agent_runtime_operator_statements WHERE agreed_on = $1::date`, [TODAY]);
  });

  test('Enter, Enter and n leave no statement row', async () => {
    await pool.query(`DELETE FROM agent_runtime_operator_statements WHERE agreed_on = $1::date`, [TODAY]);
    const before = await statements();
    for (const answer of ['Enter, Enter (Codex only)', 'n (nothing written)'] as const) {
      const { app } = await start(AFTER_ANSWER[answer]);
      await app.close();
      assert.deepEqual(await statements(), before, `${answer} writes no statement`);
    }
    assert.deepEqual(await statements(TODAY), [], 'and none for today in particular');
  });

  test('Enter, y: the start records exactly one statement row with today\'s date, and starting again keeps it at one', async () => {
    const answer = AFTER_ANSWER['Enter, y (Codex and Claude Code, with the statement)'];
    assert.deepEqual(await statements(TODAY), [], 'the table starts without a row for today');
    const first = await start(answer);
    const rows = await statements(TODAY);
    assert.equal(rows.length, 1, 'exactly one statement row for today');
    assert.equal(rows[0]!.statement, 'anthropic_commercial_terms');
    assert.equal(rows[0]!.agreed_on, TODAY);
    // The owner sees the same statement and date in Settings (the status the Connect AI page reads).
    const ada = await person('Operator Statement Ada');
    const signedIn = new Browser(first.url, origin);
    expectStatus(await signedIn.request('POST', '/api/auth/sign-in/email', { body: { email: ada.email, password } }), 200);
    const status = expectStatus(await signedIn.request('GET', AGENT_RUNTIME_PATH), 200) as AgentRuntimeStatus;
    assert.equal(status.enabled, true);
    assert.deepEqual(status.clients, { claude_code: 'available', codex: 'available' });
    assert.equal(status.commercialTerms?.agreedOn, TODAY);
    // A restart of the API (./flux up again, an upgrade) does not record the same statement twice.
    await first.app.close();
    const second = await start(answer);
    assert.equal((await statements(TODAY)).length, 1, 'still exactly one row after a restart');
    await second.app.close();
  });
});
