import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Browser, register, uniqueEmail } from './support/http.js';

// Two-phase check run by scripts/check_application.sh around `docker compose restart api`:
//   prepare: create an account and store its session cookie; verify: reuse it after restart.
const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'session-restart.json');
const phase = process.argv[2];

interface State { cookie: string; userId: string }

if (phase === 'prepare') {
  const { browser } = await register(uniqueEmail('restart'), 'correct horse battery staple');
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  const cookie = browser.cookies.get('flux.session_token');
  assert.ok(cookie);
  await writeFile(stateFile, JSON.stringify({ cookie, userId: (me.json as { user: { id: string } }).user.id } satisfies State));
  console.log('session-restart: session stored before API restart');
} else if (phase === 'verify') {
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as State;
  const browser = new Browser();
  browser.cookies.set('flux.session_token', state.cookie);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200, `session survives API restart (got ${me.status})`);
  assert.equal((me.json as { user: { id: string } }).user.id, state.userId);
  console.log('session-restart: session still valid after API restart');
} else {
  throw new Error('Usage: session-restart.ts prepare|verify');
}
