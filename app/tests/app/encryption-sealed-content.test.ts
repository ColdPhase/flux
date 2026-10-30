import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { PgBoss } from 'pg-boss';
import { projectObjectNoticesPath, type Project } from '@flux/contracts';
import { connectionString, pool } from './support/db.js';
import { apiUrl, Browser, publicOrigin } from './support/http.js';
import { createSealed, lock, passphrase, unlock } from './support/encryption.js';
import { addMember, expectStatus, person, workspace, type Person } from './support/people.js';

// F-030 S2a-1 (#655; docs/product/encrypted-workspaces.md#enforcement): the repositories of S2a-1 seal what they write
// in an encrypted workspace A and open it on read; the plain workspace B is unchanged. Every write carries an
// Idempotency-Key, so the stored responses are covered too. The database (every row of every public table, as text)
// is then scanned for each canary of A, raw, JSON-escaped and as its SHA-256 hex: zero hits. B's canaries are found
// (positive control).

let ada: Person; let ben: Person; let cy: Person;
let A: string; let B: string;
const pw = passphrase();
const kinds = ['project', 'goal', 'message', 'reply', 'large', 'dmTitle', 'dmMessage', 'decision', 'rationale', 'result', 'evidence', 'draft', 'draftBody', 'draftEdit', 'task', 'outcome', 'criterion', 'blocker', 'taskRename',
  'docTitle', 'docBody', 'docEdit', 'materialTitle', 'materialBody', 'materialUrl', 'mapTitle', 'thought', 'linkLabel', 'fileName', 'mention'] as const;
type Kind = typeof kinds[number];
const canaries: Record<'A' | 'B', Record<Kind, string>> = { A: {} as Record<Kind, string>, B: {} as Record<Kind, string> };
for (const side of ['A', 'B'] as const) {
  for (const kind of kinds) canaries[side][kind] = `canary-${side}-${kind}-${randomUUID()}`;
  // Over 8 KiB of repetitive text, so PostgreSQL TOASTs and compresses it (the dump decompresses; the scan reads values).
  canaries[side].large = `${canaries[side].large} ${'garden '.repeat(1500).trim()}`;
}
const ids: Record<'A' | 'B', { project: string; conversation: string; dm: string; decision: string; result: string; draft: string; task: string; doc: string; material: string; sketch: string }> = {} as never;
const key = () => ({ 'idempotency-key': randomUUID() });

async function post(who: Person, path: string, body: unknown, status: number, headers: Record<string, string> = {}) {
  return expectStatus(await who.browser.request('POST', path, { body, headers: { ...key(), ...headers } }), status, path) as Record<string, unknown>;
}

async function writeEverything(side: 'A' | 'B', ws: string) {
  const c = canaries[side];
  const project = await post(ada, `/api/v1/workspaces/${ws}/projects`, { name: c.project, visibility: 'workspace' }, 201) as unknown as Project;
  expectStatus(await ada.browser.request('PUT', `/api/v1/projects/${project.id}/goal`, { body: { title: c.goal }, headers: { ...key(), 'if-match': `"${project.version}"` } }), 200, 'goal');
  const conversation = await post(ada, `/api/v1/projects/${project.id}/conversations`, { body: c.message, clientMessageId: randomUUID() }, 201);
  // #469: the reply cites the opening message, so the cards of a sealed workspace are covered by the same canary scan.
  const opening = (conversation.messages as { id: string }[])[0]!.id;
  await post(ben, `/api/v1/conversations/${conversation.id}/messages`, { body: c.reply, clientMessageId: randomUUID(), references: [{ kind: 'message', id: opening }] }, 201);
  await post(ben, `/api/v1/conversations/${conversation.id}/messages`, { body: c.large, clientMessageId: randomUUID() }, 201);
  const dm = await post(ada, `/api/v1/workspaces/${ws}/dms`, { participantIds: [ben.id, cy.id], title: c.dmTitle }, 201);
  await post(ada, `/api/v1/dms/${dm.id}/messages`, { body: c.dmMessage, clientMessageId: randomUUID() }, 201);
  const decision = await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: c.decision, rationale: c.rationale }, 201);
  await post(ada, `/api/v1/decisions/${decision.id}/accept`, {}, 200, { 'if-match': `"${decision.version}"` });
  const result = await post(ada, `/api/v1/projects/${project.id}/results`, { title: c.result, finding: 'positive', evidence: c.evidence }, 201);
  const draft = await post(ada, `/api/v1/workspaces/${ws}/drafts`, { title: c.draft, body: c.draftBody }, 201);
  expectStatus(await ada.browser.request('PATCH', `/api/v1/drafts/${draft.id}`, { body: { body: c.draftEdit }, headers: { ...key(), 'if-match': `"${draft.version}"` } }), 200, 'draft edit');
  // S2a-2: a task with every text field, a rename (activity), a move into Blocked with its reason (an update), all by PATCH with a key.
  const task = await post(ada, `/api/v1/projects/${project.id}/work`, { title: c.task, outcome: c.outcome, criteria: [c.criterion] }, 201);
  const renamed = expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { title: c.taskRename },
    headers: { ...key(), 'if-match': `"${task.version}"` } }), 200, 'task rename') as { version: number };
  expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'blocked', blocker: c.blocker },
    headers: { ...key(), 'if-match': `"${renamed.version}"` } }), 200, 'task blocked');
  // S2a-2b: a doc with a PATCH and an added section, a material with an edit-free link, and a map with a thought and a labelled link.
  const doc = await post(ada, `/api/v1/projects/${project.id}/docs`, { title: c.docTitle, body: c.docBody }, 201);
  const patched = expectStatus(await ada.browser.request('PATCH', `/api/v1/docs/${doc.id}`, { body: { body: `${c.docBody}\n\n${c.docEdit}` },
    headers: { ...key(), 'if-match': `"${doc.currentVersion ?? doc.version}"` } }), 200, 'doc PATCH') as { currentVersion?: number; version?: number };
  await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: decision.id } }, 200, { 'if-match': `"${patched.currentVersion ?? patched.version}"` });
  const material = await post(ada, `/api/v1/projects/${project.id}/materials`, { clientMutationId: randomUUID(), title: c.materialTitle, body: c.materialBody,
    url: `https://example.test/${c.materialUrl}` }, 201);
  const sketch = await post(ada, `/api/v1/workspaces/${ws}/sketches`, { title: c.mapTitle, scope: 'project', projectId: project.id }, 201);
  const one = await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: c.thought, x: 0, y: 0 }, 201);
  const two = await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: `${c.thought} two`, x: 200, y: 0 }, 201);
  await post(ada, `/api/v1/sketches/${sketch.id}/links`, { fromId: (one.thought as { id: string }).id, toId: (two.thought as { id: string }).id, label: c.linkLabel.slice(0, 60) }, 201);
  ids[side] = { project: project.id, conversation: String(conversation.id), dm: String(dm.id), decision: String(decision.id), result: String(result.id), draft: String(draft.id),
    task: String(task.id), doc: String(doc.id), material: String(material.materialId ?? material.id), sketch: String(sketch.id) };
}

/** Every row of every table of the public schema, as text. */
async function databaseText() {
  const tables = (await pool.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows;
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = await pool.query(`SELECT row_to_json(t)::text AS row FROM ${JSON.stringify(name)} t`);
    for (const row of rows.rows) parts.push(row.row as string);
  }
  return parts.join('\n');
}
const encodings = (value: string) => [value, JSON.stringify(value).slice(1, -1), createHash('sha256').update(value).digest('hex'),
  Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')];

before(async () => {
  [ada, ben, cy] = [await person('Ada'), await person('Ben'), await person('Cy')];
  A = (await createSealed(ada, 'Garden club', pw)).workspace.id;
  B = (await workspace(ada, 'Book club')).id;
  for (const ws of [A, B]) {
    await addMember(ada, ws, ben, 'admin');
    await addMember(ada, ws, cy, 'member');
  }
  await writeEverything('A', A);
  await writeEverything('B', B);
});

describe('F-030 S2a-1: sealed content in the repositories', () => {
  test('A reads back every canary through the API, as B does', async () => {
    for (const side of ['A', 'B'] as const) {
      const c = canaries[side]; const id = ids[side];
      const project = expectStatus(await ben.browser.request('GET', `/api/v1/projects/${id.project}`), 200) as Project & { goal: { title: string } | null };
      assert.equal(project.name, c.project, side);
      assert.equal(project.goal?.title, c.goal, side);
      const projects = expectStatus(await ben.browser.request('GET', `/api/v1/workspaces/${side === 'A' ? A : B}/projects`), 200) as { items: Project[] };
      assert.ok(projects.items.some((item) => item.name === c.project), `${side}: the project list`);
      const conversation = expectStatus(await ben.browser.request('GET', `/api/v1/conversations/${id.conversation}`), 200) as { firstMessageBody: string; messages: { body: string }[] };
      assert.deepEqual(conversation.messages.map((m) => m.body), [c.message, c.reply, c.large], side);
      assert.equal(conversation.firstMessageBody, c.message);
      const roots = expectStatus(await ben.browser.request('GET', `/api/v1/projects/${id.project}/conversation-roots`), 200) as { roots: { message: { body: string } }[] };
      // The move into Blocked posts its reason into the task's discussion, which is a root of its own.
      assert.deepEqual(roots.roots.map((root) => root.message.body), [c.message, c.blocker]);
      const dm = expectStatus(await ben.browser.request('GET', `/api/v1/dms/${id.dm}`), 200) as { title: string | null; messages: { body: string }[] };
      assert.deepEqual({ title: dm.title, bodies: dm.messages.map((m) => m.body) }, { title: c.dmTitle, bodies: [c.dmMessage] }, side);
      const dms = expectStatus(await ben.browser.request('GET', `/api/v1/workspaces/${side === 'A' ? A : B}/dms`), 200) as { items: { title: string | null; lastMessageBody?: string | null }[] };
      assert.equal(dms.items[0]?.title, c.dmTitle);
      const decision = expectStatus(await ben.browser.request('GET', `/api/v1/decisions/${id.decision}`), 200) as { title: string; rationale: string; status: string };
      assert.deepEqual({ ...decision, status: decision.status }, { ...decision, title: c.decision, rationale: c.rationale, status: 'accepted' }, side);
      const notices = expectStatus(await ben.browser.request('GET', projectObjectNoticesPath(id.project)), 200) as { items: { title: string }[] };
      assert.deepEqual(new Set(notices.items.map((item) => item.title)), new Set([c.decision, c.result]), `${side}: object notices (#696) open their titles`);
      const task = expectStatus(await ben.browser.request('GET', `/api/v1/work/${id.task}`), 200) as { title: string; outcome: string; criteria: string[]; blocker: string | null; status: string };
      assert.deepEqual({ title: task.title, outcome: task.outcome, criteria: task.criteria, blocker: task.blocker, status: task.status },
        { title: c.taskRename, outcome: c.outcome, criteria: [c.criterion], blocker: c.blocker, status: 'blocked' }, `${side}: task`);
      const activity = JSON.stringify((await ben.browser.request('GET', `/api/v1/work/${id.task}/activity`)).json);
      assert.ok(activity.includes(c.task) && activity.includes(c.taskRename), `${side}: the title change is in the activity`);
      const draft = expectStatus(await ada.browser.request('GET', `/api/v1/drafts/${id.draft}`), 200) as { title: string; body: string };
      assert.deepEqual({ title: draft.title, body: draft.body }, { title: c.draft, body: c.draftEdit });
    }
  });

  test('a reference opens the sealed text it cites for a reader and stores only ids; locked, the card answers like its conversation (#469)', async () => {
    for (const side of ['A', 'B'] as const) {
      const c = canaries[side]; const id = ids[side];
      const read = async () => expectStatus(await ben.browser.request('GET', `/api/v1/conversations/${id.conversation}`), 200) as { messages: { id: string; references?: { kind: string; state: string; title?: string; place?: string; author?: string }[] }[] };
      const reply = (await read()).messages[1]!;
      assert.deepEqual(reply.references?.map(({ kind, state, title, place, author }) => ({ kind, state, title, place, author })),
        [{ kind: 'message', state: 'available', title: c.message, place: c.project, author: 'Ada' }], `${side}: the card opens the sealed message and project name`);
      const stored = (await pool.query(`SELECT kind, target_id FROM message_references WHERE project_message_id = $1`, [reply.id])).rows;
      assert.equal(stored.length, 1, side);
      assert.deepEqual(Object.keys(stored[0]).sort(), ['kind', 'target_id'], `${side}: a reference row is a kind and an id`);
    }
    expectStatus(await lock(ada.browser, A), 200);
    assert.equal((await ben.browser.request('GET', `/api/v1/conversations/${ids.A.conversation}`)).status, 423, 'locked: nothing of A is read, cards included');
    expectStatus(await unlock(ada.browser, A, { password: pw }), 200);
    assert.equal((await ben.browser.request('GET', `/api/v1/conversations/${ids.A.conversation}`)).status, 200);
  });

  test('citing an id of a locked sealed workspace answers exactly like citing an id that does not exist (#469)', async () => {
    // Ben is a member of both workspaces. Nothing of A may be learned from B by citing A's ids, locked or not.
    const opening = (expectStatus(await ben.browser.request('GET', `/api/v1/conversations/${ids.A.conversation}`), 200) as { messages: { id: string }[] }).messages[0]!.id;
    const dmMessage = (expectStatus(await ben.browser.request('GET', `/api/v1/dms/${ids.A.dm}`), 200) as { messages: { id: string }[] }).messages[0]!.id;
    const attempt = async (path: string, reference: { kind: string; id: string }) => {
      const response = await ben.browser.request('POST', path, { body: { body: 'Citing from B', clientMessageId: randomUUID(), references: [reference] } });
      return { status: response.status, body: response.text };
    };
    const places = [`/api/v1/projects/${ids.B.project}/conversations`, `/api/v1/dms/${ids.B.dm}/messages`];
    const check = async (label: string) => {
      for (const path of places) {
        const absent = await attempt(path, { kind: 'message', id: randomUUID() });
        assert.equal(absent.status, 404, `${label}: an absent id`);
        assert.match(absent.body, /REFERENCE_UNAVAILABLE/);
        for (const reference of [{ kind: 'message', id: opening }, { kind: 'message', id: dmMessage }, { kind: 'thought', id: opening }]) {
          assert.deepEqual(await attempt(path, reference), absent, `${label}: ${path} ${reference.kind} of A answers like an absent id`);
        }
      }
    };
    await check('unlocked');
    expectStatus(await lock(ada.browser, A), 200);
    try {
      await check('locked');
      assert.equal(JSON.stringify(await attempt(places[0]!, { kind: 'message', id: opening })).includes('Garden club'), false, 'the answer never names the locked workspace');
    } finally {
      expectStatus(await unlock(ada.browser, A, { password: pw }), 200);
    }
  });

  test('the reads computed in the application open sealed titles: chooser search, Since-you-left and task notices (S2a-2a review)', async () => {
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      const c = canaries[side]; const id = ids[side];
      // A twin with the same title in another project of the workspace must not be a candidate here.
      const other = await post(ada, `/api/v1/workspaces/${ws}/projects`, { name: `Other ${side}`, visibility: 'workspace' }, 201);
      const twin = await post(ada, `/api/v1/projects/${String(other.id)}/work`, { title: c.taskRename }, 201);
      const needle = c.taskRename.slice(8, 30).toUpperCase(); // a case-folded substring from the middle
      const chooser = await ben.browser.request('GET', `/api/v1/projects/${id.project}/work-view?purpose=choices&choice=pivot_work&q=${encodeURIComponent(needle)}`);
      expectStatus(chooser, 200, `${side}: chooser`);
      const items = (chooser.json as { items: { id: string; title: string }[] }).items;
      assert.deepEqual(items.map((item) => [item.id, item.title]), [[id.task, c.taskRename]], `${side}: the chooser finds the task by a substring of its sealed title, not the other project's twin`);
      assert.notEqual(String(twin.id), id.task);
      const none = await ben.browser.request('GET', `/api/v1/projects/${id.project}/work-view?purpose=choices&choice=pivot_work&q=${encodeURIComponent('no such words %_')}`);
      assert.deepEqual((none.json as { items: unknown[] }).items, [], `${side}: % and _ stay literal`);
      const since = await ben.browser.request('GET', `/api/v1/return?place=project&id=${id.project}&from=24h&scope=all`);
      expectStatus(since, 200, `${side}: Since-you-left`);
      assert.ok(since.text.includes(c.taskRename), `${side}: Since-you-left shows the task title`);
      const notices = await ben.browser.request('GET', `/api/v1/projects/${id.project}/task-notices`);
      expectStatus(notices, 200, `${side}: task notices`);
      assert.ok(notices.text.includes(c.taskRename) && notices.text.includes(c.blocker), `${side}: task notices show the title and the blocked reason`);
      for (const response of [chooser, since, notices]) assert.equal(/fx1\.[1-9]/.test(response.text), false, `${side}: no envelope reaches a reader`);
    }
  });

  test('docs, materials and maps read back opened; live Wiki and live maps answer 409 for A until S2b (S2a-2b)', async () => {
    for (const side of ['A', 'B'] as const) {
      const c = canaries[side]; const id = ids[side];
      const doc = expectStatus(await ben.browser.request('GET', `/api/v1/docs/${id.doc}`), 200, `${side}: doc`) as { title: string; body: string };
      assert.equal(doc.title, c.docTitle);
      assert.ok(doc.body.includes(c.docEdit) && doc.body.includes(c.decision), `${side}: the PATCH and the added section are in the doc`);
      const versions = JSON.stringify(expectStatus(await ben.browser.request('GET', `/api/v1/docs/${id.doc}/versions`), 200));
      assert.ok(versions.includes(c.docTitle), `${side}: versions list opened titles`);
      const material = expectStatus(await ben.browser.request('GET', `/api/v1/materials/${id.material}`), 200, `${side}: material`) as { title: string; body: string; url: string };
      assert.deepEqual([material.title, material.body, material.url], [c.materialTitle, c.materialBody, `https://example.test/${c.materialUrl}`]);
      const map = JSON.stringify(expectStatus(await ben.browser.request('GET', `/api/v1/sketches/${id.sketch}`), 200, `${side}: map`));
      for (const text of [c.mapTitle, c.thought, c.linkLabel.slice(0, 60)]) assert.ok(map.includes(text), `${side}: the map shows ${text.slice(0, 20)}`);
      for (const text of [doc.title, map]) assert.equal(/fx1\.[1-9]/.test(text), false, `${side}: no envelope reaches a reader`);
      const live = [await ben.browser.request('GET', `/api/v1/docs/${id.doc}/live`), await ben.browser.request('GET', `/api/v1/sketches/${id.sketch}/live`)];
      for (const response of live) {
        if (side === 'A') { assert.equal(response.status, 409, response.text); assert.equal((response.json as { code?: string }).code, 'WORKSPACE_ENCRYPTED_UNSUPPORTED'); }
        else assert.notEqual((response.json as { code?: string } | null)?.code, 'WORKSPACE_ENCRYPTED_UNSUPPORTED');
      }
    }
    const live = (await pool.query(`SELECT (SELECT count(*) FROM doc_live_heads h JOIN project_materials m ON m.id = h.doc_id WHERE m.workspace_id = $1)
      + (SELECT count(*) FROM map_live_heads WHERE workspace_id = $1) AS n`, [A])).rows[0];
    assert.equal(Number(live.n), 0, 'nothing was written to the live tables for A');
  });

  test('a live room for A\'s doc or map is refused with 409 for a reader and 404 for an outsider; B\'s opens (S2a-2b review)', async () => {
    const outsider = await person('Room outsider');
    const join = (who: Person, kind: 'wiki' | 'map', id: string) => new Promise<string>((resolve) => {
      const url = new URL(`/api/v1/editing?kind=${kind}&id=${id}`, apiUrl); url.protocol = 'ws:';
      const socket = new WebSocket(url, { headers: { origin: publicOrigin, host: new URL(publicOrigin).host, cookie: who.browser.cookieHeader() }, perMessageDeflate: false });
      const timer = setTimeout(() => { socket.terminate(); resolve('timeout'); }, 8000);
      socket.once('open', () => { clearTimeout(timer); socket.terminate(); resolve('open'); });
      socket.once('unexpected-response', (_request, response) => { clearTimeout(timer); resolve(`refused ${response.statusCode}`); socket.terminate(); });
      socket.once('error', (error) => { clearTimeout(timer); resolve(`error ${error.message}`); });
    });
    for (const [kind, key] of [['wiki', 'doc'], ['map', 'sketch']] as const) {
      assert.equal(await join(ben, kind, ids.A[key]), 'refused 409', `A ${kind}: a reader learns it is not offered yet`);
      assert.equal(await join(outsider, kind, ids.A[key]), 'refused 404', `A ${kind}: an outsider learns nothing`);
      assert.equal(await join(ben, kind, ids.B[key]), 'open', `B ${kind} opens`);
    }
    // Over HTTP too, the refusal follows the session and access checks.
    assert.equal((await new Browser().request('GET', `/api/v1/docs/${ids.A.doc}/live`)).status, 401, 'no session: 401 first');
    assert.equal((await outsider.browser.request('GET', `/api/v1/docs/${ids.A.doc}/live`)).status, 404, 'an outsider: 404');
  });

  test('a sealed chooser search that reaches its scan limit says so (searchLimited); below the limit and in B it does not', async () => {
    const limit = Number(process.env.FLUX_TEST_SEALED_CHOOSER_SCAN_LIMIT ?? 0);
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      const project = await post(ada, `/api/v1/workspaces/${ws}/projects`, { name: `Many ${side}`, visibility: 'workspace' }, 201);
      const search = async () => (await ada.browser.request('GET', `/api/v1/projects/${String(project.id)}/work-view?purpose=choices&choice=pivot_work&q=needle`)).json as
        { searchLimited?: boolean; total: number };
      await post(ada, `/api/v1/projects/${String(project.id)}/work`, { title: 'needle 0' }, 201);
      assert.equal((await search()).searchLimited, undefined, `${side}: below the limit`);
      for (let index = 1; index <= 9; index += 1) await post(ada, `/api/v1/projects/${String(project.id)}/work`, { title: `needle ${index}` }, 201);
      const many = await search();
      if (side === 'A' && limit > 0 && limit < 10) {
        assert.equal(many.searchLimited, true, 'A: more objects than the scan opens');
        assert.equal(many.total, limit, 'A: total counts matches among the opened ones');
      } else {
        assert.equal(many.searchLimited, undefined, `${side}: no marker`);
        assert.equal(many.total, 10);
      }
    }
  });

  test('a promoted DM map lists its copy with the opened project name', async () => {
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      const c = canaries[side];
      const dm = await post(ada, `/api/v1/workspaces/${ws}/dms`, { participantIds: [ben.id, cy.id], title: `Copy ${side}` }, 201);
      const sketch = await post(ada, `/api/v1/workspaces/${ws}/sketches`, { title: `${c.mapTitle} dm`, scope: 'dm', dmId: dm.id }, 201);
      await post(ada, `/api/v1/sketches/${String(sketch.id)}/thoughts`, { text: `${c.thought} dm`, x: 0, y: 0 }, 201);
      const preview = expectStatus(await ada.browser.request('GET', `/api/v1/sketches/${String(sketch.id)}/promotion?target=new&participants=none`), 200, `${side}: preview`) as { token: string };
      const name = `${c.project} copy`;
      await post(ada, `/api/v1/sketches/${String(sketch.id)}/promotion`, { target: { kind: 'new', name }, token: preview.token, participants: 'none' }, 201);
      const source = expectStatus(await ada.browser.request('GET', `/api/v1/sketches/${String(sketch.id)}`), 200, `${side}: source`) as { copies?: { projectName: string }[] };
      assert.deepEqual(source.copies?.map((copy) => copy.projectName), [name], `${side}: the copy shows the opened project name`);
    }
  });

  test('a file of A is sealed on disk as it arrives and served opened; its name and digest are sealed; a tampered object is never served (S2a-2b-2)', async () => {
    const objectFile = async (id: string) => {
      const find = async (dir: string): Promise<string | null> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { const found = await find(path); if (found) return found; } else if (entry.name === id) return path;
        }
        return null;
      };
      return find('/data/files');
    };
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      void ws;
      const c = canaries[side];
      const bytes = Buffer.from(`file bytes ${c.fileName} ${'x'.repeat(5000)}`);
      const name = `${c.fileName}.txt`;
      const response = await fetch(new URL(`/api/v1/projects/${ids[side].project}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, ada.browser.base), {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: ada.browser.cookieHeader(), origin: ada.browser.defaultOrigin }, body: bytes });
      assert.equal(response.status, 201, await response.clone().text());
      const staged = await response.json() as { id: string; name: string; size: number };
      assert.deepEqual({ name: staged.name, size: staged.size }, { name, size: bytes.length }, `${side}: the plaintext size and name`);
      const served = await fetch(new URL(`/api/v1/files/${staged.id}`, ada.browser.base), { headers: { cookie: ada.browser.cookieHeader() } });
      assert.equal(served.status, 200);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes, `${side}: the download is the uploaded bytes`);
      const path = await objectFile(staged.id);
      assert.ok(path, `${side}: the object exists`);
      const stored = await readFile(path!);
      const row = (await pool.query(`SELECT flux_is_sealed(name) AS name, flux_is_sealed(sha256) AS sha, key_version FROM project_files WHERE id = $1`, [staged.id])).rows[0];
      if (side === 'A') {
        assert.equal(stored.subarray(0, 4).toString('ascii'), 'FXF1', 'A: a sealed object');
        assert.equal(stored.length, bytes.length + 36, 'A: header and tag around the plaintext length');
        for (const needle of [c.fileName, createHash('sha256').update(bytes).digest('hex')]) assert.equal(stored.includes(needle), false, 'A: no plaintext on disk');
        assert.deepEqual(row, { name: true, sha: true, key_version: 1 });
        // A changed byte makes the object unavailable, never served.
        const tampered = Buffer.from(stored); tampered[tampered.length - 1] ^= 1;
        await writeFile(path!, tampered);
        assert.notEqual((await fetch(new URL(`/api/v1/files/${staged.id}`, ada.browser.base), { headers: { cookie: ada.browser.cookieHeader() } })).status, 200, 'A: a tampered object is refused');
        await writeFile(path!, stored);
      } else {
        assert.ok(stored.equals(bytes), 'B: stored as it was sent');
        assert.deepEqual(row, { name: false, sha: false, key_version: null });
      }
    }
  });

  test('a mention in A reaches the inbox content-free ("Ada mentioned you in Garden club"); B keeps its text; the database refuses content (S2a-2c)', async () => {
    const inbox = async () => (expectStatus(await ben.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string; body: string; source: { workspaceId?: string; id: string } }[] }).items;
    for (const side of ['A', 'B'] as const) {
      await post(ada, `/api/v1/conversations/${ids[side].conversation}/messages`, { body: `@Ben ${canaries[side].mention}`, clientMessageId: randomUUID() }, 201);
    }
    let items: Awaited<ReturnType<typeof inbox>> = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      items = await inbox();
      if (items.some((item) => item.title === 'Ada mentioned you in Garden club') && items.some((item) => item.body.includes(canaries.B.mention))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const sealed = items.find((item) => item.title === 'Ada mentioned you in Garden club');
    assert.ok(sealed, `A's mention arrived content-free: ${JSON.stringify(items.map((item) => item.title))}`);
    assert.equal(sealed.body, '');
    assert.ok(items.some((item) => item.body.includes(canaries.B.mention)), 'B keeps its preview');
    for (const item of items) assert.equal(/fx1\.[1-9]/.test(item.title + item.body), false, 'no envelope in the inbox');
    const insert = (title: string, body: string) => pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, reason, title, body, url)
      VALUES (gen_random_uuid(), $1, $2, 'project', $3, 'mention', $4, $5, '/x')`, [ben.id, A, ids.A.project, title, body]);
    await assert.rejects(insert('Ada mentioned you in Garden club', 'a preview'), { hint: 'NOTIFICATION_CONTENT_REFUSED' }, 'a body');
    await assert.rejects(insert('Ada mentioned you in a secret project', ''), { hint: 'NOTIFICATION_CONTENT_REFUSED' }, 'another place');
    await assert.rejects(insert('secret words mentioned you in Garden club', ''), { hint: 'NOTIFICATION_CONTENT_REFUSED' }, 'a free who');
  });

  test('mid-upload, the scratch file of A holds ciphertext only (B plaintext); an aborted upload leaves nothing in tmp (#707 review)', async () => {
    const tmp = '/data/files/attachments/tmp';
    const scratch = async () => { try { return await readdir(tmp); } catch { return []; } };
    const start = (projectId: string, first: Buffer, gate: Promise<void>, rest: Buffer, signal?: AbortSignal) => {
      const body = Readable.toWeb(Readable.from((async function* () { yield first; await gate; yield rest; })())) as unknown as ReadableStream;
      return fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=gated.txt`, ada.browser.base), {
        method: 'POST', body, signal, duplex: 'half',
        headers: { 'content-type': 'application/octet-stream', cookie: ada.browser.cookieHeader(), origin: ada.browser.defaultOrigin },
      } as RequestInit & { duplex: 'half' });
    };
    // Every file the upload created in tmp (the scratch file and anything beside it), once the first chunk is written.
    const waitForScratch = async (before: Set<string>) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const fresh = (await scratch()).filter((name) => !before.has(name));
        const files = await Promise.all(fresh.map(async (name) => ({ name, bytes: await readFile(join(tmp, name)).catch(() => Buffer.alloc(0)) })));
        if (files.some((file) => file.bytes.length > 64 * 1024)) {
          await new Promise((resolve) => setTimeout(resolve, 200)); // anything written beside it lands too
          const settled = await Promise.all((await scratch()).filter((name) => !before.has(name))
            .map(async (name) => ({ name, bytes: await readFile(join(tmp, name)).catch(() => Buffer.alloc(0)) })));
          return { names: settled.map((file) => file.name), files: settled };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('the upload never reached its scratch file');
    };
    for (const side of ['A', 'B'] as const) {
      const needle = `scratch-${side}-${randomUUID()}`;
      const first = Buffer.from(`${needle} ${'y'.repeat(200_000)}`);
      let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
      const before = new Set(await scratch());
      const response = start(ids[side].project, first, gate, Buffer.from(' the end'));
      const during = await waitForScratch(before);
      if (side === 'A') {
        assert.ok(during.files.some((file) => file.bytes.subarray(0, 4).toString('ascii') === 'FXF1'), 'A: the scratch file starts as a sealed object');
        for (const file of during.files) assert.equal(file.bytes.includes(needle), false, `A: no plaintext anywhere in tmp while the upload is open (${file.name})`);
      } else {
        assert.ok(during.files.some((file) => file.bytes.includes(needle)), 'B: the plain control writes plaintext');
      }
      open();
      assert.equal((await response).status, 201, `${side}: the gated upload finishes`);
      // Abort mid-stream: the scratch file goes away.
      const controller = new AbortController();
      let neverOpen!: () => void; const stuck = new Promise<void>((resolve) => { neverOpen = resolve; });
      const beforeAbort = new Set(await scratch());
      const aborted = start(ids[side].project, first, stuck, Buffer.from('never'), controller.signal).catch(() => null);
      const pending = await waitForScratch(beforeAbort);
      controller.abort(); neverOpen();
      await aborted;
      let left = true;
      for (let attempt = 0; attempt < 100 && left; attempt += 1) {
        const now = await scratch();
        left = pending.names.some((name) => now.includes(name));
        if (left) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(left, false, `${side}: an aborted upload leaves no scratch file`);
    }
  });

  test('A\'s rows hold envelopes, B\'s plain text; the draft versions of A are written by the application, sealed', async () => {
    const one = async (query: string, values: unknown[]) => (await pool.query(query, values)).rows[0] as Record<string, unknown>;
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      const sealed = side === 'A';
      const row = await one(`SELECT flux_is_sealed(p.name) AS name, flux_is_sealed(g.title) AS goal, flux_is_sealed(d.title) AS decision,
          flux_is_sealed(d.rationale) AS rationale, flux_is_sealed(r.title) AS result, flux_is_sealed(r.evidence) AS evidence
        FROM projects p JOIN project_goals g ON g.project_id = p.id JOIN project_decisions d ON d.project_id = p.id JOIN project_results r ON r.project_id = p.id
        WHERE p.workspace_id = $1`, [ws]);
      assert.deepEqual(row, { name: sealed, goal: sealed, decision: sealed, rationale: sealed, result: sealed, evidence: sealed }, side);
      const messages = (await pool.query(`SELECT bool_and(flux_is_sealed(body)) AS body, bool_and(flux_is_sealed(request_fingerprint)) AS fingerprint
        FROM project_messages WHERE workspace_id = $1`, [ws])).rows[0];
      assert.deepEqual(messages, { body: sealed, fingerprint: sealed }, side);
      const dm = await one(`SELECT bool_and(flux_is_sealed(d.title)) AS title, bool_and(flux_is_sealed(m.body)) AS body, bool_and(flux_is_sealed(m.request_fingerprint)) AS fingerprint
        FROM dms d JOIN dm_messages m ON m.dm_id = d.id WHERE d.workspace_id = $1`, [ws]);
      assert.deepEqual(dm, { title: sealed, body: sealed, fingerprint: sealed }, side);
      const versions = (await pool.query(`SELECT v.version, flux_is_sealed(v.title) AS title, flux_is_sealed(v.body) AS body FROM draft_versions v
        JOIN drafts d ON d.id = v.draft_id WHERE d.workspace_id = $1 ORDER BY v.version`, [ws])).rows;
      assert.deepEqual(versions, [{ version: 1, title: sealed, body: sealed }, { version: 2, title: sealed, body: sealed }], `${side}: one row per version`);
      const work = await one(`SELECT flux_is_sealed(title) AS title, flux_is_sealed(outcome) AS outcome, flux_is_sealed(blocker) AS blocker, flux_is_sealed(criteria) AS criteria
        FROM project_work_items WHERE id = $1`, [ids[side].task]);
      assert.deepEqual(work, { title: sealed, outcome: sealed, blocker: sealed, criteria: sealed }, `${side}: task`);
      const activity = (await pool.query(`SELECT bool_and(flux_is_sealed(detail)) AS detail, count(*)::int AS n FROM project_task_activity WHERE workspace_id = $1`, [ws])).rows[0];
      assert.ok(activity.n >= 2);
      assert.equal(activity.detail, sealed, `${side}: activity`);
      const docRows = (await pool.query(`SELECT bool_and(flux_is_sealed(v.title)) AS title, bool_and(flux_is_sealed(v.body)) AS body, count(*)::int AS n
        FROM project_material_versions v WHERE v.workspace_id = $1`, [ws])).rows[0];
      assert.ok(docRows.n >= 4, `${side}: doc and material versions`);
      assert.deepEqual({ title: docRows.title, body: docRows.body }, { title: sealed, body: sealed }, `${side}: doc and material versions`);
      const map = await one(`SELECT flux_is_sealed(s.title) AS title, bool_and(flux_is_sealed(t.text)) AS text, bool_and(flux_is_sealed(l.label)) AS label
        FROM sketches s JOIN sketch_thoughts t ON t.sketch_id = s.id JOIN sketch_links l ON l.sketch_id = s.id WHERE s.id = $1 GROUP BY s.title`, [ids[side].sketch]);
      assert.deepEqual(map, { title: sealed, text: sealed, label: sealed }, `${side}: map`);
      const keys = (await pool.query(`SELECT bool_and(flux_is_sealed(response_body)) AS body, bool_and(flux_is_sealed(request_hash)) AS hash, count(*)::int AS n
        FROM idempotency_keys WHERE workspace_id = $1 AND response_body IS NOT NULL`, [ws])).rows[0];
      assert.ok(keys.n >= 5, `${side}: scoped idempotency rows (${keys.n})`);
      assert.deepEqual({ body: keys.body, hash: keys.hash }, { body: sealed, hash: sealed }, side);
    }
  });

  test('search keeps placeholder rows for A, with every change logged, and B as before', async () => {
    const a = (await pool.query(`SELECT bool_and(sealed) AS sealed, bool_and(title = '' AND body = '') AS empty, count(*)::int AS n
      FROM search_documents WHERE workspace_id = $1 AND kind <> 'person'`, [A])).rows[0];
    assert.ok(a.n >= 6, `placeholder rows of A: ${a.n}`);
    assert.deepEqual({ sealed: a.sealed, empty: a.empty }, { sealed: true, empty: true });
    assert.ok((await pool.query(`SELECT count(*)::int AS n FROM search_changes WHERE workspace_id = $1`, [A])).rows[0].n >= a.n);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM search_changes WHERE workspace_id = $1`, [B])).rows[0].n, 0);
    const b = (await pool.query(`SELECT bool_or(sealed) AS sealed, bool_or(title = $2) AS named FROM search_documents WHERE workspace_id = $1`, [B, canaries.B.project])).rows[0];
    assert.deepEqual(b, { sealed: false, named: true });
  });

  test('a stolen database holds none of A\'s canaries in any encoding; B\'s are there (positive control)', async () => {
    const text = await databaseText();
    for (const kind of kinds) {
      for (const encoded of encodings(canaries.A[kind])) assert.equal(text.includes(encoded), false, `A ${kind} leaked`);
      assert.ok(text.includes(canaries.B[kind].slice(0, 60)), `B ${kind} is in the database`);
    }
  });

  test('an idempotent replay in A answers the stored body, opened; locked it answers 423, unlocked again it replays', async () => {
    const replayKey = randomUUID();
    const send = () => ben.browser.request('POST', `/api/v1/projects/${ids.A.project}/decisions`, { body: { title: 'Replay me', rationale: 'Once' }, headers: { 'idempotency-key': replayKey } });
    const first = expectStatus(await send(), 201) as { id: string; title: string };
    const again = await send();
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual((again.json as { id: string; title: string }), first);
    expectStatus(await lock(ada.browser, A), 200);
    assert.equal((await send()).status, 423, 'a replay opens the stored body, so it needs the key');
    assert.equal((await ben.browser.request('GET', `/api/v1/decisions/${ids.A.decision}`)).status, 423);
    expectStatus(await unlock(ada.browser, A, { password: pw }), 200);
    assert.equal((await send()).status, 201);
  });

  test('creating a decision in A works: the agent-thread witnesses skip a sealed workspace (no 409 WORKSPACE_ENCRYPTED_AI_OFF)', async () => {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_thread_artifact_mutations WHERE workspace_id = $1`, [A])).rows[0].n, 0);
    assert.ok((await pool.query(`SELECT count(*)::int AS n FROM agent_thread_artifact_mutations WHERE workspace_id = $1`, [B])).rows[0].n > 0, 'B is witnessed as before');
  });

  test('a write the application did not seal is refused by the backstop for A, never stored; the same write passes for B', async () => {
    for (const [ws, project] of [[A, ids.A.project], [B, ids.B.project]] as const) {
      const attempt = pool.query(`UPDATE project_decisions SET title = 'plain words' WHERE project_id = $1`, [project]);
      if (ws === A) await assert.rejects(attempt, (error: { hint?: string; message: string }) => error.hint === 'WORKSPACE_PLAINTEXT_REFUSED' && !error.message.includes('plain words'));
      else assert.ok((await attempt).rowCount! > 0);
    }
  });
});

// #712 review: a stale template title stays markable as read; the morning summary of a sealed unread is content-free;
// the settings page and Needs you open (or, locked, name by workspace) a sealed place instead of failing.
describe('F-030 content-free notifications in use (#712 review)', () => {
  const inbox = async () => (expectStatus(await ben.browser.request('GET', '/api/v1/inbox'), 200) as { items: { id: string; title: string; readAt: string | null; source: { workspaceId?: string } }[] }).items;

  test('after an account rename, a sealed notification is still marked read, one by one and all at once', async () => {
    const sealed = (await inbox()).filter((item) => item.title.startsWith('Ada ') && item.title.endsWith(' in Garden club'));
    assert.ok(sealed.length >= 1, 'a sealed notification to mark');
    await pool.query(`UPDATE auth_users SET name = 'Ada Renamed' WHERE id = $1`, [ada.id]);
    try {
      expectStatus(await ben.browser.request('POST', `/api/v1/inbox/${sealed[0]!.id}/read`, { body: {} }), 200, 'mark read');
      expectStatus(await ben.browser.request('POST', '/api/v1/inbox/read-all', { body: {} }), 200, 'mark all read');
      // A changed title is still checked against the current names.
      await assert.rejects(pool.query(`UPDATE notifications SET title = 'Ada mentioned you in Garden club, secret' WHERE id = $1`, [sealed[0]!.id]),
        { hint: 'NOTIFICATION_CONTENT_REFUSED' });
    } finally { await pool.query(`UPDATE auth_users SET name = 'Ada' WHERE id = $1`, [ada.id]); }
    // With the names as they were, only the link decides: an id-only form passes, anything else is refused.
    const ok = `/projects/${randomUUID()}/conversations/${randomUUID()}#message-${randomUUID()}`;
    const original = (await pool.query<{ title: string }>(`SELECT title FROM notifications WHERE id = $1`, [sealed[0]!.id])).rows[0]!.title;
    assert.match(original, /^Ada /);
    await pool.query(`UPDATE notifications SET url = $2 WHERE id = $1`, [sealed[0]!.id, ok]);
    await assert.rejects(pool.query(`UPDATE notifications SET url = '/projects/x?q=secret' WHERE id = $1`, [sealed[0]!.id]), { hint: 'NOTIFICATION_CONTENT_REFUSED' }, 'url: ids only');
  });

  test('a proposed decision of A in Needs you, and a muted place of A in the settings, open for Ben; locked, the settings name the workspace', async () => {
    const title = `NEEDS-${randomUUID()}`;
    await post(ada, `/api/v1/projects/${ids.A.project}/decisions`, { title, rationale: 'why' }, 201);
    const needs = expectStatus(await ben.browser.request('GET', '/api/v1/needs-you'), 200) as unknown;
    assert.ok(JSON.stringify(needs).includes(title), 'the proposed decision of A is opened');
    assert.equal(/fx1\.[1-9]/.test(JSON.stringify(needs)), false);
    const mute = expectStatus(await ben.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: ids.A.project, muted: true } }), 200) as { muted: { id: string; name: string }[] };
    assert.equal(mute.muted.find((place) => place.id === ids.A.project)?.name, canaries.A.project, 'the muted project of A is opened');
    expectStatus(await lock(ada.browser, A), 200);
    try {
      for (const method of ['GET', 'PATCH'] as const) {
        const settings = expectStatus(await ben.browser.request(method, '/api/v1/notification-preferences', method === 'PATCH' ? { body: {} } : {}), 200, method) as { muted: { id: string; name: string }[] };
        assert.equal(settings.muted.find((place) => place.id === ids.A.project)?.name, 'Garden club', `${method}: locked, the place is named by its workspace`);
      }
    } finally {
      expectStatus(await unlock(ada.browser, A, { password: pw }), 200);
      expectStatus(await ben.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: ids.A.project, muted: false } }), 200);
    }
  });

  test('the morning summary of a person whose newest unread is in A is written content-free and the day is claimed', async () => {
    await post(ada, `/api/v1/conversations/${ids.A.conversation}/messages`, { body: `@Ben ${randomUUID()}`, clientMessageId: randomUUID() }, 201);
    let newest: { title: string; source: { workspaceId?: string } } | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      newest = (await inbox()).find((item) => item.readAt === null);
      if (newest?.source.workspaceId === A) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(newest?.source.workspaceId, A, 'the newest unread is in A');
    const now = new Date();
    await pool.query(`INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ben.id]);
    await pool.query(`UPDATE notification_preferences SET summary_enabled = true, summary_at = $2, time_zone = 'UTC', summary_last_on = NULL WHERE user_id = $1`,
      [ben.id, now.getUTCHours() * 60 + now.getUTCMinutes()]);
    const boss = new PgBoss({ connectionString, migrate: false, supervise: false, schedule: false });
    await boss.start();
    try { await boss.send('notification.morning-summary.v1', {}); } finally { await boss.stop({ graceful: false }); }
    let row: { title: string; body: string; workspace_id: string } | undefined;
    for (let attempt = 0; attempt < 120 && !row; attempt += 1) {
      row = (await pool.query<{ title: string; body: string; workspace_id: string }>(`SELECT title, body, workspace_id FROM notifications
        WHERE user_id = $1 AND delivery_kind = 'morning_summary' ORDER BY created_at DESC LIMIT 1`, [ben.id])).rows[0];
      if (!row) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(row, 'the summary was written');
    assert.match(row.title, /^(\d+\+? things wait|1 thing waits) in your inbox$/);
    assert.equal(row.body, 'Your morning summary from Flux');
    assert.equal(row.workspace_id, A, 'every unread is in A (the rest were marked read): the plain count, in A');
    const claimed = (await pool.query<{ on: string | null }>(`SELECT summary_last_on::text AS on FROM notification_preferences WHERE user_id = $1`, [ben.id])).rows[0];
    assert.ok(claimed?.on, 'the day is claimed');
    // #712 review P2-4: with A locked, the next day's summary leaves A's items out and still claims the day.
    expectStatus(await lock(ada.browser, A), 200);
    try {
      await pool.query(`UPDATE notification_preferences SET summary_last_on = NULL WHERE user_id = $1`, [ben.id]);
      const again = new PgBoss({ connectionString, migrate: false, supervise: false, schedule: false });
      await again.start();
      try { await again.send('notification.morning-summary.v1', {}); } finally { await again.stop({ graceful: false }); }
      let on: string | null = null;
      for (let attempt = 0; attempt < 120 && !on; attempt += 1) {
        on = (await pool.query<{ on: string | null }>(`SELECT summary_last_on::text AS on FROM notification_preferences WHERE user_id = $1`, [ben.id])).rows[0]?.on ?? null;
        if (!on) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.ok(on, 'locked: the day is still claimed (no retry loop on WORKSPACE_LOCKED)');
    } finally { expectStatus(await unlock(ada.browser, A, { password: pw }), 200); }
    await pool.query(`UPDATE notification_preferences SET summary_enabled = false WHERE user_id = $1`, [ben.id]);
  });
});
