import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openField, WorkspaceKey } from '@flux/core';
import { workspaceUnlockGrantsPath, workspaceUnlockPasswordPath } from '@flux/contracts';
import { Browser, register, uniqueEmail } from './support/http.js';
import { createSealed, passphrase, unlock } from './support/encryption.js';
import { deksOf, endOffline, holderRows, offlinePool as pool, openHolder, wrapRows } from './support/encryption-offline.js';

// AC-13 of F-030 (#655, S2c): a rotation survives a worker crash and a keyring restart. Phases run by
// scripts/check_encryption.sh around `docker kill` and restarts; the worker runs with FLUX_TEST_ROTATION_HOLD_AFTER_PAGES=3
// (it stops after its third page) where a phase says so.
//   crash-prepare    a club with 60 messages; Ben (admin) removed; wait until the worker holds after page 3
//   crash-resumed    after `docker kill worker` and a start without the hold: finishes from the cursor, each message once at v2
//   keyring-prepare  (worker held again) a second club; Ben removed; wait until held
//   keyring-locked   after restarting only `keyring`: locked, the rotation paused (progress frozen)
//   keyring-resumed  (worker without the hold) still paused while locked; Ada unlocks; it finishes
const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'encryption-rotation.json');
const phase = process.argv[2];
interface Club { cookie: string; ws: string; ownerId: string; password: string; bodies: string[]; progress?: unknown }
interface State { crash?: Club; keyring?: Club }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const load = async (): Promise<State> => { try { return JSON.parse(await readFile(stateFile, 'utf8')) as State; } catch { return {}; } };
const save = (state: State) => writeFile(stateFile, JSON.stringify(state));
const browserOf = (c: Club) => { const browser = new Browser(); browser.cookies.set('flux.session_token', c.cookie); return browser; };
const keys = async (ws: string) => (await pool.query('SELECT current_version, live_versions, rotation FROM workspace_keys WHERE workspace_id = $1', [ws])).rows[0];
const progress = async (ws: string) => (await pool.query('SELECT step, cursor, rows_done, passes FROM workspace_rotation_progress WHERE workspace_id = $1', [ws])).rows[0] ?? null;
async function waitFor<T>(label: string, probe: () => Promise<T | null | false | undefined>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}
/** Progress that has moved and then stopped for two seconds: the worker holds. */
async function held(ws: string) {
  return waitFor('the worker holds mid-rotation', async () => {
    const first = await progress(ws);
    if (!first || Number(first.rows_done) === 0) return null;
    await sleep(2_000);
    const again = await progress(ws);
    return JSON.stringify(again) === JSON.stringify(first) && (await keys(ws)).rotation === 'reencrypting' ? first : null;
  });
}

async function prepare(name: string): Promise<Club> {
  const email = uniqueEmail('rotation-owner');
  const { browser } = await register(email, 'correct horse battery staple', 'Ada');
  const me = (await browser.request('GET', '/api/v1/me')).json as { user: { id: string } };
  const password = passphrase();
  const owner = { id: me.user.id, email, browser };
  const { workspace } = await createSealed(owner, name, password);
  const benEmail = uniqueEmail('rotation-admin');
  const ben = await register(benEmail, 'correct horse battery staple', 'Ben');
  const benId = ((await ben.browser.request('GET', '/api/v1/me')).json as { user: { id: string } }).user.id;
  assert.equal((await browser.request('POST', `/api/v1/workspaces/${workspace.id}/members`, { body: { email: benEmail, role: 'admin' } })).status, 201);
  assert.equal((await browser.request('POST', workspaceUnlockGrantsPath(workspace.id), { body: { userId: benId, password } })).status, 201);
  assert.equal((await ben.browser.request('PUT', workspaceUnlockPasswordPath(workspace.id), { body: { newPassword: passphrase() } })).status, 200);
  const post = async (path: string, body: unknown) => {
    const answer = await browser.request('POST', path, { body, headers: { 'idempotency-key': randomUUID() } });
    assert.equal(answer.status, 201, answer.text);
    return answer.json as { id: string };
  };
  const project = await post(`/api/v1/workspaces/${workspace.id}/projects`, { name: `canary-${randomUUID()}` });
  const bodies = [`canary-${randomUUID()}`];
  const conversation = await post(`/api/v1/projects/${project.id}/conversations`, { body: bodies[0], clientMessageId: randomUUID() });
  for (let i = 1; i < 60; i += 1) {
    bodies.push(`canary-${randomUUID()}`);
    await post(`/api/v1/conversations/${conversation.id}/messages`, { body: bodies[i], clientMessageId: randomUUID() });
  }
  assert.equal((await browser.request('DELETE', `/api/v1/workspaces/${workspace.id}/members/${benId}`)).status, 204);
  const c: Club = { cookie: browser.cookies.get('flux.session_token')!, ws: workspace.id, ownerId: me.user.id, password, bodies };
  c.progress = await held(c.ws);
  return c;
}

/** Each message exactly once, at v2, opened offline with Ada's DEK v2. */
async function exactlyOnce(c: Club) {
  const holder = (await holderRows(c.ws)).find((row) => row.user_id === c.ownerId)!;
  const privateKey = await openHolder(holder, c.password);
  assert.ok(privateKey);
  const dek = deksOf(holder, privateKey, await wrapRows(c.ws)).get(2)!;
  const key = WorkspaceKey.fromDek(c.ws, 2, dek);
  const rows = (await pool.query('SELECT id::text, body FROM project_messages WHERE workspace_id = $1', [c.ws])).rows as { id: string; body: string }[];
  const bodies = rows.map((row) => {
    assert.match(row.body, /^fx1\.2\./);
    return openField((v) => (v === 2 ? key : undefined), { workspaceId: c.ws, field: 'project_messages.body', identity: [row.id] }, row.body);
  });
  assert.deepEqual([...bodies].sort(), [...c.bodies].sort(), 'every message exactly once, none lost');
}
const settled = (ws: string) => waitFor('the rotation finishes', async () => {
  const k = await keys(ws);
  return k.rotation === 'none' && k.current_version === 2;
});

try {
  const state = await load();
  if (phase === 'crash-prepare') {
    state.crash = await prepare('Crash club');
    await save(state);
    console.log(`encryption-rotation: held mid-rotation at ${JSON.stringify(state.crash.progress)}`);
  } else if (phase === 'crash-resumed') {
    const c = state.crash!;
    await settled(c.ws);
    await exactlyOnce(c);
    console.log('encryption-rotation: after the worker was killed, the rotation finished from its cursor');
  } else if (phase === 'keyring-prepare') {
    state.keyring = await prepare('Keyring club');
    await save(state);
    console.log(`encryption-rotation: held mid-rotation at ${JSON.stringify(state.keyring.progress)}`);
  } else if (phase === 'keyring-locked') {
    const c = state.keyring!;
    await waitFor('the keyring restart locks it', async () => (await pool.query('SELECT count(*)::int AS n FROM workspace_unlocks WHERE workspace_id = $1', [c.ws])).rows[0].n === 0, 30_000);
    assert.equal((await keys(c.ws)).rotation, 'reencrypting');
    console.log('encryption-rotation: the keyring restart locked the workspace mid-rotation');
  } else if (phase === 'keyring-resumed') {
    const c = state.keyring!;
    const before = await progress(c.ws);
    await sleep(3_000);
    assert.deepEqual(await progress(c.ws), before, 'paused while locked, with a worker free to run');
    assert.equal((await keys(c.ws)).rotation, 'reencrypting');
    const opened = await unlock(browserOf(c), c.ws, { password: c.password });
    assert.equal(opened.status, 200, opened.text);
    await settled(c.ws);
    await exactlyOnce(c);
    console.log('encryption-rotation: unlocked after the keyring restart, the rotation resumed and finished');
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
} finally {
  await endOffline();
}
