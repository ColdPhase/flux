import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_PATH, backgroundComputeConnectionsPath, type AgentRuntimeStatus } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { signIn } from './support/http.js';
import { expectStatus, password, person, type Person } from './support/people.js';

// F-022 T3 (#278): the API side of scripts/check_agent_runtime.sh, against a stack whose runtime profile
// runs with the TEST ONLY fake CLIs. One step per call; owners are kept in /state between steps. Steps
// print KEY=value lines the script reads. The database is read only to name slots for the script and to
// prove one owner's requests never touch another owner's slot.

const stateFile = `${process.env.FLUX_TEST_STATE_DIR ?? '/state'}/runtime-live.json`;
type State = Record<string, { email: string; id: string }>;
const load = async (): Promise<State> => JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as State;
const save = async (state: State) => writeFile(stateFile, JSON.stringify(state));
const { pool } = createDatabase(process.env.DATABASE_URL!);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function owner(label: string): Promise<Person> {
  const state = await load();
  const known = state[label];
  if (known) {
    const { browser, response } = await signIn(known.email, password);
    assert.equal(response.status, 200, `${label} signs in`);
    return { id: known.id, email: known.email, browser };
  }
  const created = await person(`Runtime ${label}`);
  state[label] = { email: created.email, id: created.id };
  await save(state);
  return created;
}

const status = async (someone: Person) => expectStatus(await someone.browser.request('GET', AGENT_RUNTIME_PATH), 200) as AgentRuntimeStatus;

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, seconds = 90): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(500);
    value = await read();
  }
  return value;
}

async function bindingOf(id: string) {
  const { rows } = await pool.query<{ id: string; slot: string; state: string }>(`SELECT id, slot, state FROM agent_runtime_bindings WHERE owner_user_id = $1 AND state <> 'released'`, [id]);
  return rows[0] ?? null;
}
const slotRow = async (slot: string) => (await pool.query<{ state: string; boot_id: string | null }>('SELECT state, boot_id FROM agent_runtime_slots WHERE slot = $1', [slot])).rows[0];
const readySlots = async () => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_runtime_slots s WHERE state = 'ready'
  AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.slot = s.slot AND b.state <> 'released')`)).rows[0]!.n;

async function bind(label: string) {
  const someone = await owner(label);
  const answer = await someone.browser.request('POST', AGENT_RUNTIME_BINDING_PATH);
  assert.equal(answer.status, 200, `${label} binds: ${answer.text}`);
  assert.equal((answer.json as AgentRuntimeStatus).binding?.state, 'active');
  const binding = (await bindingOf(someone.id))!;
  console.log(`SLOT=${binding.slot}`);
  console.log(`BINDING=${binding.id}`);
  return { someone, binding };
}

const steps: Record<string, (...args: string[]) => Promise<void>> = {
  /** Switch off: the API reports the feature disabled. */
  async off() {
    const someone = await owner(`off-${randomUUID().slice(0, 6)}`);
    const off = await status(someone);
    assert.equal(off.enabled, false);
    assert.equal(off.pool, 'off');
    expectStatus(await someone.browser.request('POST', AGENT_RUNTIME_BINDING_PATH), 409);
    console.log('OFF=reported');
  },
  /** Waits until `count` slots are bound or bindable (the worker saw them through runtime-manager). */
  async 'wait-ready'(count) {
    const n = Number(count);
    await until(`${n} ready slots`, readySlots, (ready) => ready >= n, 180);
    const someone = await owner('watcher');
    const on = await status(someone);
    assert.equal(on.enabled, true);
    assert.deepEqual(on.clients, { claude_code: 'available', codex: 'off' });
    assert.equal(on.commercialTerms?.agreedOn, '2026-10-05', 'the Commercial Terms statement is recorded with its date');
    assert.equal(on.pool, 'available');
    console.log(`READY=${await readySlots()}`);
  },
  async bind(label) { await bind(label!); },
  /** Two owners get two slots; A cannot reach, start, inspect or sign in to B's slot by any API input. */
  async 'two-owners'() {
    const a = await bind('A');
    const b = await bind('B');
    assert.notEqual(a.binding.slot, b.binding.slot, 'two owners, two slots');
    const before = await pool.query('SELECT id, slot, state, owner_user_id FROM agent_runtime_bindings ORDER BY id');
    const attempts: [string, string, unknown][] = [
      ['POST', AGENT_RUNTIME_BINDING_PATH, { slot: b.binding.slot }], ['POST', AGENT_RUNTIME_BINDING_PATH, { bindingId: b.binding.id }],
      ['POST', AGENT_RUNTIME_BINDING_PATH, { ownerId: b.someone.id }], ['POST', AGENT_RUNTIME_BINDING_PATH, { owner: b.someone.email }],
      ['DELETE', AGENT_RUNTIME_BINDING_PATH, { bindingId: b.binding.id }], ['GET', `${AGENT_RUNTIME_PATH}?slot=${b.binding.slot}`, undefined],
      ['GET', `${AGENT_RUNTIME_PATH}?ownerId=${b.someone.id}`, undefined], ['POST', `${AGENT_RUNTIME_BINDING_PATH}?slot=${b.binding.slot}`, undefined],
      ['GET', `${AGENT_RUNTIME_BINDING_PATH}/${b.binding.id}`, undefined], ['POST', `/api/v1/agent-runtime/slots/${b.binding.slot}/login`, { client: 'claude_code', method: 'sso' }],
      ['POST', `/api/v1/agent-runtime/slots/${b.binding.slot}/status`, {}], ['GET', `/api/v1/agent-runtime/${b.binding.slot}`, undefined],
      ['POST', '/api/v1/agent-runtime/login', { slot: b.binding.slot, client: 'claude_code', method: 'sso' }],
    ];
    for (const [method, path, body] of attempts) {
      const answer = await a.someone.browser.request(method, path, body === undefined ? {} : { body });
      assert.ok([400, 404].includes(answer.status), `${method} ${path} answered ${answer.status}`);
    }
    // The headers a caller might try are ignored: A's own requests act on A only.
    const own = await a.someone.browser.request('POST', AGENT_RUNTIME_BINDING_PATH, { headers: { 'x-flux-slot': b.binding.slot, 'x-flux-owner': b.someone.id } });
    assert.equal(own.status, 200);
    assert.equal((await bindingOf(a.someone.id))!.slot, a.binding.slot);
    const after = await pool.query('SELECT id, slot, state, owner_user_id FROM agent_runtime_bindings ORDER BY id');
    assert.deepEqual(after.rows, before.rows, 'no binding changed');
    const bView = await status(b.someone);
    assert.equal(bView.binding?.state, 'active');
    console.log(`A_SLOT=${a.binding.slot}`);
    console.log(`B_SLOT=${b.binding.slot}`);
  },
  /** With every slot bound, another owner sees the pool full and keeps server connections and mode (b). */
  async 'pool-full'(label) {
    const someone = await owner(label!);
    const full = await status(someone);
    assert.equal(full.pool, 'full');
    assert.equal(full.binding, null);
    const refused = expectStatus(await someone.browser.request('POST', AGENT_RUNTIME_BINDING_PATH), 409) as { code: string };
    assert.equal(refused.code, 'AGENT_RUNTIME_POOL_FULL');
    expectStatus(await someone.browser.request('GET', backgroundComputeConnectionsPath), 200);
    expectStatus(await someone.browser.request('GET', '/api/v1/agent-connections'), 200);
    console.log('POOL=full');
  },
  /** Prints the owner's slot and binding for the script. */
  async 'slot-of'(label) {
    const binding = await bindingOf((await owner(label!)).id);
    console.log(`SLOT=${binding?.slot ?? ''}`);
    console.log(`BINDING=${binding?.id ?? ''}`);
    console.log(`STATE=${binding?.state ?? ''}`);
  },
  async boot(slot) { console.log(`BOOT=${(await slotRow(slot!))?.boot_id ?? ''}`); },
  /** Remove runtime: wait for the release to finish and the slot to come back with a new boot id. */
  async remove(label, slot, bootBefore) {
    const someone = await owner(label!);
    assert.equal((await someone.browser.request('DELETE', AGENT_RUNTIME_BINDING_PATH)).status, 202);
    const released = await until(`${label}'s release`, () => status(someone), (view) => view.binding === null && view.lastRelease?.reason === 'owner');
    const row = await until(`${slot} back in the pool on a new boot`, () => slotRow(slot!), (value) => value?.state === 'ready' && value.boot_id !== bootBefore, 120);
    console.log(`SIGN_OUT_FAILED=${released.lastRelease!.signOutFailed}`);
    console.log(`NEW_BOOT=${row!.boot_id}`);
  },
  async 'expect-slot-state'(slot, state) {
    await until(`${slot} ${state}`, () => slotRow(slot!), (value) => value?.state === state, 120);
    console.log(`SLOT_STATE=${state}`);
  },
  async 'expect-release'(label, reason) {
    const someone = await owner(label!);
    const view = await until(`${label} released (${reason})`, () => status(someone), (value) => value.binding === null && value.lastRelease?.reason === reason, 120);
    console.log(`RELEASED=${view.lastRelease!.reason}`);
  },
  async 'expect-binding'(label, state) {
    const someone = await owner(label!);
    const view = await until(`${label} ${state}`, () => status(someone), (value) => value.binding?.state === state, 120);
    console.log(`BINDING_STATE=${view.binding!.state}`);
  },
  /** Seeded-secret absence: the fake login's marker never reaches the database. */
  async 'no-secret-in-db'(marker) {
    const { rows } = await pool.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM agent_runtime_connections c WHERE c::text LIKE $1)
      OR EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b::text LIKE $1) OR EXISTS (SELECT 1 FROM agent_runtime_slots s WHERE s::text LIKE $1) AS found`, [`%${marker}%`]);
    assert.equal(rows[0]!.found, false);
    console.log('SECRET_IN_DB=no');
  },
};

const [name, ...args] = process.argv.slice(2);
try {
  const step = steps[name ?? ''];
  if (!step) throw new Error(`unknown step ${name}; steps: ${Object.keys(steps).join(', ')}`);
  await step(...args);
} finally {
  await pool.end();
}
