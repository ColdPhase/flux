import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { testFixturePersonalConnections } from '@flux/core';
import { createDatabase, personalRunRows } from '@flux/db';
import { expectStatus, person, workspace } from './support/people.js';

// #1441: the database and API side of scripts/check_model_gateway.sh. `arm` makes an owner, an agent and a run on their (fixture) API key
// working in the runtime, stores the hash of a new gateway token on it as the worker does, and prints RUN= and TOKEN= for the script,
// which hands the token to a process in the runtime. `charged <run>` prints what the run was charged through the gateway.

const { pool, db } = createDatabase(process.env.DATABASE_URL!);
const [step, arg] = process.argv.slice(2);
try {
  if (step === 'arm') {
    const owner = await person('gateway-runtime-owner');
    const ws = await workspace(owner, 'Gateway in the runtime') as { id: string };
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Gateway agent', owner: 'self' } }), 201) as { id: string }).id;
    const connection = (await testFixturePersonalConnections.resolve(owner.id))!;
    const id = randomUUID();
    await pool.query(`INSERT INTO personal_runs (id, workspace_id, owner_user_id, agent_id, client_run_id, request_fingerprint, kind, prompt, reserved_micros,
      provider, model, engine, status, connection_id) VALUES ($1, $2, $3, $4, $5, 'gateway-runtime-check', 'ask', 'gateway check', 0, 'anthropic', $6, 'runtime', 'dispatching', $7)`,
    [id, ws.id, owner.id, agentId, randomUUID(), connection.model, connection.id]);
    const token = `flux_mg_${randomBytes(32).toString('base64url')}`;
    assert.ok(await db.transaction((tx) => personalRunRows(tx).armGateway(id, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 600_000))));
    console.log(`RUN=${id}\nTOKEN=${token}\nMODEL=${connection.model}`);
  } else if (step === 'charged') {
    const { rows } = await pool.query<{ charged_micros: number; input_tokens: number | null }>('SELECT charged_micros, input_tokens FROM personal_runs WHERE id = $1', [arg]);
    console.log(`CHARGED=${rows[0]!.charged_micros}\nINPUT=${rows[0]!.input_tokens}`);
  } else throw new Error(`unknown step ${step}`);
} finally {
  await pool.end();
}
