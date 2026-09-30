import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Browser, register, uniqueEmail } from './support/http.js';

// Two-phase check run by scripts/check_application.sh around `docker compose restart api`:
//   prepare: create an account and store its session cookie; verify: reuse it after restart.
const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'session-restart.json');
const phase = process.argv[2];

interface State { cookie: string; userId: string; conversationId: string; materialId: string }

if (phase === 'prepare') {
  const { browser } = await register(uniqueEmail('restart'), 'correct horse battery staple');
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  const cookie = browser.cookies.get('flux.session_token');
  assert.ok(cookie);
  const workspace = await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Restart check' } });
  assert.equal(workspace.status, 201);
  const workspaceId = (workspace.json as { id: string }).id;
  const project = await browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name: 'Persistent project' } });
  assert.equal(project.status, 201);
  const projectId = (project.json as { id: string }).id;
  const published = await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Persistence', body: 'Stored material' } });
  assert.equal(published.status, 201, published.text);
  const materialId = (published.json as { materialId: string }).materialId;
  const conversation = await browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
    { body: { body: 'Stored message', clientMessageId: randomUUID(), source: { materialId, version: 1 } } });
  assert.equal(conversation.status, 201, conversation.text);
  const conversationId = (conversation.json as { id: string }).id;
  await writeFile(stateFile, JSON.stringify({ cookie, userId: (me.json as { user: { id: string } }).user.id,
    conversationId, materialId } satisfies State));
  console.log('session-restart: session and project content stored before API restart');
} else if (phase === 'verify') {
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as State;
  const browser = new Browser();
  browser.cookies.set('flux.session_token', state.cookie);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200, `session survives API restart (got ${me.status})`);
  assert.equal((me.json as { user: { id: string } }).user.id, state.userId);
  const material = await browser.request('GET', `/api/v1/materials/${state.materialId}`);
  assert.equal(material.status, 200, material.text);
  assert.equal((material.json as { body: string }).body, 'Stored material');
  const conversation = await browser.request('GET', `/api/v1/conversations/${state.conversationId}`);
  assert.equal(conversation.status, 200, conversation.text);
  assert.equal((conversation.json as { messages: { body: string; source: { materialId: string; version: number } }[] }).messages[0]?.body, 'Stored message');
  assert.deepEqual((conversation.json as { messages: { source: { materialId: string; version: number } }[] }).messages[0]?.source,
    { materialId: state.materialId, version: 1 });
  console.log('session-restart: session, material and linked conversation still valid after API restart');
} else {
  throw new Error('Usage: session-restart.ts prepare|verify');
}
