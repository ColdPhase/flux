/* global fetch, process, console, crypto, URL, setTimeout */
// Real-data fixture for scripts/check_backup.sh (issue #123). Runs with plain Node inside the API
// container, fed on stdin like scripts/flux-demo.mjs, and uses only the public HTTP API.
//
//   FLUX_FIXTURE_MODE=seed    after ./flux demo: adds content of every kind (conversation, DM,
//                             private note, project sketch, work/decision/result with links, doc
//                             with versions, push subscription, a revoked and a live session, an
//                             outsider) and prints `FLUX_FIXTURE {json}`: logins, cookies and a
//                             snapshot read back through the API.
//   FLUX_FIXTURE_MODE=verify  with FLUX_FIXTURE_STATE={json} from seed, against a restored or
//                             upgraded instance: the same snapshot, sign-in, the sessions policy
//                             and permissions (outsider denied, private note still private).
//   FLUX_FIXTURE_MODE=demo    after an upgrade from an older version: the demo data is readable.
//
// Input: FLUX_PUBLIC_ORIGIN, FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD.

import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';

const api = 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const mode = process.env.FLUX_FIXTURE_MODE;
const WORKSPACE = 'Riverside Makers (demo)';
const PROJECT = 'Community garden sensors';
const owner = { email: 'ada@demo.flux.test', password: process.env.FLUX_DEMO_OWNER_PASSWORD };
const partner = { email: 'jonas@demo.flux.test', password: process.env.FLUX_DEMO_PARTNER_PASSWORD };
if (!origin || !owner.password || !partner.password) throw new Error('FLUX_PUBLIC_ORIGIN and both demo passwords are required');

class Session {
  constructor(cookies = {}) { this.cookies = new Map(Object.entries(cookies)); }

  async request(method, path, body, extra = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { origin, ...extra };
      if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(new URL(path, api), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value) this.cookies.set(name, value); else this.cookies.delete(name);
      }
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (response.status === 429 && attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, (Number(response.headers.get('retry-after')) || 10) * 1000));
        continue;
      }
      return { status: response.status, json, text };
    }
  }

  async expect(method, path, body, status = [200, 201], extra = {}) {
    const response = await this.request(method, path, body, extra);
    if (!status.includes(response.status)) throw new Error(`${method} ${path} answered ${response.status}: ${response.text}`);
    return response.json;
  }

  jar() { return Object.fromEntries(this.cookies); }
}

async function signIn(person) {
  const session = new Session();
  await session.expect('POST', '/api/auth/sign-in/email', { email: person.email, password: person.password }, [200]);
  return session;
}

const ids = () => crypto.randomUUID();
const all = async (session, path) => {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const page = await session.expect('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`);
    items.push(...page.items);
    if (items.length >= page.total || !page.items.length) return items;
  }
};

async function demoIds(session) {
  const ws = (await session.expect('GET', '/api/v1/workspaces')).find((item) => item.name === WORKSPACE);
  assert.ok(ws, 'the demo workspace exists');
  const project = (await all(session, `/api/v1/workspaces/${ws.id}/projects`)).find((item) => item.name === PROJECT);
  assert.ok(project, 'the demo project exists');
  return { workspaceId: ws.id, projectId: project.id };
}

/** Everything the restore must reproduce, read back through the API as the owner and partner. */
async function snapshot(ada, jonas, state) {
  const { workspaceId, projectId } = state;
  const exported = await ada.expect('GET', `/api/v1/projects/${projectId}/export`);
  delete exported.exportedAt;
  delete exported.provenance.instanceOrigin;
  const conversations = await all(ada, `/api/v1/projects/${projectId}/conversations`);
  const threads = [];
  for (const item of conversations) threads.push((await ada.expect('GET', `/api/v1/conversations/${item.id}?limit=100`)).messages.map((message) => [message.sequence, message.body]));
  const docVersions = [];
  for (const doc of await all(ada, `/api/v1/projects/${projectId}/docs`)) docVersions.push((await all(ada, `/api/v1/docs/${doc.id}/versions`)).map((version) => [version.version, version.state, version.reason]));
  const dms = await all(ada, `/api/v1/workspaces/${workspaceId}/dms`);
  const dmMessages = [];
  for (const dm of dms) dmMessages.push((await ada.expect('GET', `/api/v1/dms/${dm.id}`)).messages.map((message) => message.body));
  const adaDrafts = (await all(ada, `/api/v1/workspaces/${workspaceId}/drafts`)).map((draft) => [draft.id, draft.title, draft.visibility, draft.version]).sort();
  const jonasDrafts = (await all(jonas, `/api/v1/workspaces/${workspaceId}/drafts`)).map((draft) => draft.id).sort();
  const push = (await ada.expect('GET', '/api/v1/push/subscriptions')).map((item) => [item.endpointOrigin, item.deviceLabel]).sort();
  const members = (await ada.expect('GET', `/api/v1/workspaces/${workspaceId}/members`)).map((member) => [member.email, member.role]).sort();
  return { exported, threads, docVersions, dmMessages, adaDrafts, jonasDrafts, push, members };
}

async function seed() {
  const tag = ids().slice(0, 8);
  const token = (what) => `${what}-${tag}`;
  const ada = await signIn(owner);
  const jonas = await signIn(partner);
  const { workspaceId, projectId } = await demoIds(ada);
  const adaId = (await ada.expect('GET', '/api/v1/me')).user.id;
  const jonasId = (await jonas.expect('GET', '/api/v1/me')).user.id;

  const thread = await ada.expect('POST', `/api/v1/projects/${projectId}/conversations`, { body: token('BACKUP-message'), clientMessageId: ids() });
  await jonas.expect('POST', `/api/v1/conversations/${thread.id}/messages`, { body: token('BACKUP-reply'), clientMessageId: ids() });
  const sketch = await ada.expect('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { title: token('BACKUP-sketch'), scope: 'project', projectId });
  const root = await ada.expect('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { text: token('BACKUP-thought'), x: 0, y: 0 });
  await jonas.expect('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { text: token('BACKUP-leaf'), x: 240, y: 0, linkFrom: { thoughtId: root.thought.id, label: 'next' } });
  const work = await ada.expect('POST', `/api/v1/projects/${projectId}/work`, { title: token('BACKUP-work'), owner: { kind: 'human', id: jonasId }, sources: [{ type: 'thought', id: root.thought.id }] });
  const decision = await jonas.expect('POST', `/api/v1/projects/${projectId}/decisions`, { title: token('BACKUP-decision'), affects: [work.id] });
  await ada.expect('POST', `/api/v1/decisions/${decision.id}/accept`, {}, [200], { 'if-match': `"${decision.version}"` });
  await jonas.expect('POST', `/api/v1/projects/${projectId}/results`, { title: token('BACKUP-result'), finding: 'positive', work: [work.id], finishes: { id: work.id, expectedVersion: work.version } });
  const doc = await ada.expect('POST', `/api/v1/projects/${projectId}/docs`, { title: token('BACKUP-doc'), body: token('BACKUP-doc-v1') }, [201], { 'idempotency-key': ids() });
  await jonas.expect('PATCH', `/api/v1/docs/${doc.id}`, { body: `${token('BACKUP-doc-v2')} [work](flux:work/${work.id})`, state: 'published', reason: 'Second version' }, [200], { 'if-match': `"${doc.version}"` });
  const note = await ada.expect('POST', `/api/v1/workspaces/${workspaceId}/drafts`, { title: token('BACKUP-private-note'), body: token('BACKUP-private-body'), projectId });
  const dm = (await all(ada, `/api/v1/workspaces/${workspaceId}/dms`))[0];
  assert.ok(dm, 'the demo DM exists');
  await jonas.expect('POST', `/api/v1/dms/${dm.id}/messages`, { body: token('BACKUP-dm'), clientMessageId: ids() });

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  await ada.expect('POST', '/api/v1/push/subscriptions', {
    endpoint: `https://push.example.test/backup/${tag}`, expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, deviceLabel: 'Backup test phone',
  });

  // Sessions policy: a second session of Ada is revoked before the backup and must stay revoked.
  const revoked = await signIn(owner);
  const revokedId = (await revoked.expect('GET', '/api/v1/me')).session.id;
  await ada.expect('DELETE', `/api/v1/sessions/${revokedId}`, undefined, [204]);
  assert.equal((await revoked.request('GET', '/api/v1/me')).status, 401);

  // An outsider: an account that is not a member of the demo workspace.
  const outsider = { email: `outsider-${tag}@example.test`, password: `outsider-${tag}-password` };
  await new Session().expect('POST', '/api/auth/sign-up/email', { ...outsider, name: 'Olga Outsider' }, [200]);

  const state = { tag, workspaceId, projectId, adaId, jonasId, dmId: dm.id, noteId: note.id, docId: doc.id, outsider };
  const expected = await snapshot(ada, jonas, state);
  assert.ok(expected.adaDrafts.some(([id]) => id === note.id), 'Ada sees her private note');
  assert.ok(!expected.jonasDrafts.includes(note.id), 'Jonas cannot see Ada\'s private note');
  console.log(`FLUX_FIXTURE ${JSON.stringify({ ...state, cookies: { jonas: jonas.jar(), revoked: revoked.jar() }, expected })}`);
}

async function verify() {
  const state = JSON.parse(process.env.FLUX_FIXTURE_STATE ?? '');
  const { workspaceId, projectId, dmId, noteId } = state;

  // Sessions: a session from before the backup still works, the revoked one stays revoked.
  const jonas = new Session(state.cookies.jonas);
  assert.equal((await jonas.expect('GET', '/api/v1/me')).user.id, state.jonasId, 'the live session survived the restore');
  assert.equal((await new Session(state.cookies.revoked).request('GET', '/api/v1/me')).status, 401, 'the revoked session stays revoked');
  // Sign-in with the old password works; a wrong password does not.
  const ada = await signIn(owner);
  assert.equal((await new Session().request('POST', '/api/auth/sign-in/email', { email: owner.email, password: 'wrong password' })).status, 401);

  const actual = await snapshot(ada, jonas, state);
  assert.deepEqual(actual, state.expected, 'the restored data equals the data before the backup');
  const text = JSON.stringify(actual.exported);
  for (const word of ['BACKUP-message', 'BACKUP-thought', 'BACKUP-work', 'BACKUP-decision', 'BACKUP-result', 'BACKUP-doc-v1', 'BACKUP-doc-v2']) {
    assert.ok(text.includes(`${word}-${state.tag}`), `restored export has ${word}`);
  }
  assert.ok(!text.includes('BACKUP-private') && !text.includes('BACKUP-dm'), 'the export still leaves out the private note and the DM');
  assert.equal(actual.exported.docs.find((doc) => doc.id === state.docId).versions.length, 2, 'both doc versions restored');
  assert.ok(actual.exported.links.some((link) => link.from.type === 'doc' && link.role === 'mentions' && link.to.type === 'work'), 'doc link restored');
  assert.deepEqual(actual.push, [['https://push.example.test', 'Backup test phone']], 'push subscription restored');

  // Permissions: the private note is still private, and an outsider is still denied.
  assert.equal((await jonas.request('GET', `/api/v1/drafts/${noteId}`)).status, 404, 'Jonas cannot open Ada\'s private note');
  assert.equal((await ada.request('GET', `/api/v1/drafts/${noteId}`)).status, 200, 'Ada still opens her private note');
  const outsider = await signIn(state.outsider);
  assert.ok(!(await outsider.expect('GET', '/api/v1/workspaces')).some((ws) => ws.id === workspaceId), 'outsider sees no demo workspace');
  for (const path of [`/api/v1/projects/${projectId}`, `/api/v1/projects/${projectId}/export`, `/api/v1/dms/${dmId}`, `/api/v1/drafts/${noteId}`]) {
    assert.equal((await outsider.request('GET', path)).status, 404, `outsider is denied ${path}`);
  }
  assert.equal((await jonas.request('GET', `/api/v1/projects/${projectId}/export`)).status, 403, 'a member without project.manage cannot export');

  // The restored instance accepts new writes.
  const after = await jonas.expect('POST', `/api/v1/dms/${dmId}/messages`, { body: 'Written after the restore', clientMessageId: ids() });
  assert.ok(after.sequence > 0);
  console.log(`verified: ${actual.threads.length} conversations, ${actual.exported.docs.length} docs, ${actual.exported.sketches.length} sketches, `
    + `${actual.exported.work.length} work items, ${actual.exported.links.length} links, ${actual.dmMessages.flat().length} DM messages, sessions and permissions`);
}

/** After an upgrade from an older Flux: the demo seeded by that version is intact and readable. */
async function demo() {
  const ada = await signIn(owner);
  const jonas = await signIn(partner);
  const { workspaceId, projectId } = await demoIds(ada);
  const conversations = await all(ada, `/api/v1/projects/${projectId}/conversations`);
  assert.equal(conversations.length, 1);
  assert.equal((await ada.expect('GET', `/api/v1/conversations/${conversations[0].id}`)).messages.length, 4, 'the four demo messages survived');
  const dms = await all(jonas, `/api/v1/workspaces/${workspaceId}/dms`);
  assert.equal((await jonas.expect('GET', `/api/v1/dms/${dms[0].id}`)).messages.length, 4, 'the four demo DM messages survived');
  const drafts = await all(ada, `/api/v1/workspaces/${workspaceId}/drafts`);
  assert.ok(drafts.some((draft) => draft.title === 'Before Thursday (private)'), 'the private note survived');
  assert.ok(!(await all(jonas, `/api/v1/workspaces/${workspaceId}/drafts`)).some((draft) => draft.title === 'Before Thursday (private)'), 'and is still private');
  const sketches = await all(ada, `/api/v1/workspaces/${workspaceId}/sketches?projectId=${projectId}`);
  assert.equal((await ada.expect('GET', `/api/v1/sketches/${sketches[0].id}`)).thoughts.length, 4, 'the demo sketch survived');
  // Features of the new version work on the upgraded data.
  const doc = await ada.expect('POST', `/api/v1/projects/${projectId}/docs`, { title: 'Written after the upgrade', body: 'Upgrade check' }, [201]);
  assert.equal(doc.version, 1);
  const exported = await ada.expect('GET', `/api/v1/projects/${projectId}/export`);
  assert.equal(exported.conversations[0].messages.length, 4);
  assert.ok(!JSON.stringify(exported).includes('Before Thursday'), 'the export leaves out the private note');
  console.log(`verified upgraded demo: 4 messages, 4 DM messages, private note, sketch, new doc and export (schema ${exported.provenance.schemaVersion})`);
}

if (mode === 'seed') await seed();
else if (mode === 'verify') await verify();
else if (mode === 'demo') await demo();
else throw new Error(`unknown FLUX_FIXTURE_MODE ${mode}`);
