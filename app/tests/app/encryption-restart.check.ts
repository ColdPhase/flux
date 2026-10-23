import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '@flux/db';
import { Browser, register, uniqueEmail } from './support/http.js';
import { createSealed, contentCall, passphrase, readWorkspace, unlock } from './support/encryption.js';

// AC-3 of F-030 (#655, S1): restarts and the lock. Phases run by scripts/check_application.sh and
// scripts/check_encryption.sh around Compose restarts:
//   prepare        create an encrypted workspace (unlocked) with content
//   stack-locked   after `compose restart` of the whole stack: content 423, state locked; unlock works again
//   api-unlocked   after restarting only `api`: still unlocked
//   mark           the newest event, before restarting only `keyring`
//   keyring-locked after restarting only `keyring`: locked within 5 s, with exactly one workspace.locked.v1 { reason: 'restart' }
const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'encryption-restart.json');
const phase = process.argv[2];
interface State { cookie: string; workspaceId: string; password: string; mark?: number }

const browserOf = (state: State) => { const browser = new Browser(); browser.cookies.set('flux.session_token', state.cookie); return browser; };
const save = (state: State) => writeFile(stateFile, JSON.stringify(state));
const load = async () => JSON.parse(await readFile(stateFile, 'utf8')) as State;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function query<T>(text: string, values: unknown[]): Promise<T[]> {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  try { return (await pool.query(text, values)).rows as T[]; } finally { await pool.end(); }
}

if (phase === 'prepare') {
  const email = uniqueEmail('encryption-restart');
  const { browser } = await register(email, 'correct horse battery staple', 'Ada');
  const password = passphrase();
  const owner = { id: '', email, browser };
  const { workspace } = await createSealed(owner, 'Garden club', password);
  const project = await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Seed swap' } });
  assert.equal(project.status, 201, project.text);
  await save({ cookie: browser.cookies.get('flux.session_token')!, workspaceId: workspace.id, password });
  console.log('encryption-restart: encrypted workspace unlocked with content');
} else if (phase === 'stack-locked') {
  const state = await load();
  const browser = browserOf(state);
  const refused = await contentCall(browser, state.workspaceId);
  assert.equal(refused.status, 423, `content after a whole-stack restart: ${refused.text}`);
  assert.equal((await readWorkspace(browser, state.workspaceId)).encryption?.state, 'locked');
  const opened = await unlock(browser, state.workspaceId, { password: state.password });
  assert.equal(opened.status, 200, opened.text);
  assert.equal((await contentCall(browser, state.workspaceId)).status, 200);
  console.log('encryption-restart: the whole-stack restart locked it; unlock works again');
} else if (phase === 'api-unlocked') {
  const state = await load();
  const browser = browserOf(state);
  assert.equal((await contentCall(browser, state.workspaceId)).status, 200, 'restarting only the API keeps it unlocked');
  assert.equal((await readWorkspace(browser, state.workspaceId)).encryption?.state, 'unlocked');
  console.log('encryption-restart: an API restart kept it unlocked');
} else if (phase === 'mark') {
  const state = await load();
  const [row] = await query<{ seq: string | null }>('SELECT max(seq)::text AS seq FROM events WHERE workspace_id = $1', [state.workspaceId]);
  await save({ ...state, mark: Number(row?.seq ?? 0) });
} else if (phase === 'keyring-locked') {
  const state = await load();
  const browser = browserOf(state);
  const started = Date.now();
  let status = 0;
  // The keyring was restarted before this phase; the heartbeat (5 s) of the API notices the new boot.
  while (Date.now() - started < 8_000) {
    status = (await contentCall(browser, state.workspaceId)).status;
    if (status === 423) break;
    await sleep(250);
  }
  assert.equal(status, 423, 'locked after the keyring restarted');
  await sleep(6_000); // every API and worker heartbeat has run since; concurrent deleters must still record one event
  const locks = await query<{ data: { reason: string } }>(`SELECT data FROM events WHERE workspace_id = $1 AND kind = 'workspace.locked.v1' AND seq > $2`,
    [state.workspaceId, state.mark ?? 0]);
  assert.deepEqual(locks.map((row) => row.data), [{ reason: 'restart' }]);
  assert.equal((await query<{ n: number }>('SELECT count(*)::int AS n FROM workspace_unlocks WHERE workspace_id = $1', [state.workspaceId]))[0]!.n, 0);
  assert.equal((await unlock(browser, state.workspaceId, { password: state.password })).status, 200);
  console.log(`encryption-restart: the keyring restart locked it within ${Date.now() - started - 6_000} ms, with one restart event`);
} else {
  throw new Error(`unknown phase ${phase}`);
}
