import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { UNTITLED_SKETCH, type Doc, type SearchResponse, type SearchResult, type Sketch } from '@flux/contracts';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { codeOf, createSealed, installTestSeals, lock, passphrase, unlock } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// F-030 S2b (#655; docs/product/encrypted-workspaces.md#search, #live-wiki-and-maps): search in an encrypted workspace A answers from
// the in-memory index of the API process and returns what the same content returns in the plain workspace B; the index follows
// every write, is dropped on lock and reads only the partitions the reader may see; live Wiki and live maps persist sealed; and
// nothing of A (the canaries of search and of the live tables) is in any row of the database.

let ada: Person; let ben: Person; let cy: Person;
let A: string; let B: string;
const pw = passphrase();
const ids = {} as Record<'A' | 'B', { project: string; dm: string; doc: string; sketch: string; restricted: string }>;
const key = () => ({ 'idempotency-key': randomUUID() });
const canary = (name: string) => `canary-${name}-${randomUUID()}`;
const live = (side: 'A' | 'B') => ({ wiki: canary(`live-wiki-${side}`), peer: canary(`live-peer-${side}`), map: canary(`live-map-${side}`), mapLabel: canary(`lbl-${side}`).slice(0, 60) });
const liveCanaries = { A: live('A'), B: live('B') };
/** Words only A's search content holds (spaces, not dashes, so the parser keeps them as words). */
const followup = canary('followup').replace(/-/g, ' ');
const closed = canary('closed').replace(/-/g, ' ');

async function post(who: Person, path: string, body: unknown, status: number, headers: Record<string, string> = {}) {
  return expectStatus(await who.browser.request('POST', path, { body, headers: { ...key(), ...headers } }), status, path) as Record<string, unknown>;
}

/** The same content in both workspaces, so the same query must find the same things. */
async function writeSet(ws: string, side: 'A' | 'B') {
  const project = await post(ada, `/api/v1/workspaces/${ws}/projects`, { name: 'Pavilion roadmap', visibility: 'workspace' }, 201);
  const conversation = await post(ada, `/api/v1/projects/${project.id}/conversations`, { body: 'The sensor comparison covers the lamp and the camera.', clientMessageId: randomUUID() }, 201);
  await post(ben, `/api/v1/conversations/${conversation.id}/messages`, { body: 'Camera privacy is still the open question for the workshop.', clientMessageId: randomUUID() }, 201);
  const decision = await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: 'Use a time-of-flight sensor', rationale: 'Cameras raise privacy concerns at the stall.' }, 201);
  await post(ada, `/api/v1/decisions/${decision.id}/accept`, {}, 200, { 'if-match': `"${decision.version}"` });
  await post(ada, `/api/v1/projects/${project.id}/results`, { title: 'Low light run', finding: 'positive', evidence: 'The sensor stayed accurate in the dark.' }, 201);
  await post(ada, `/api/v1/projects/${project.id}/work`, { title: 'Order the sensor boards', outcome: 'Boards arrive before the workshop' }, 201);
  const doc = await post(ada, `/api/v1/projects/${project.id}/docs`, { title: 'Sensor field notes', body: 'Notes about the sensor and the lamp enclosure.' }, 201) as unknown as Doc & { currentVersion?: number };
  expectStatus(await ada.browser.request('PATCH', `/api/v1/docs/${doc.id}`, { body: { body: 'Notes about the sensor and the lamp enclosure. Presentation outline follows.' },
    headers: { ...key(), 'if-match': `"${doc.currentVersion ?? doc.version}"` } }), 200, 'doc PATCH');
  await post(ada, `/api/v1/projects/${project.id}/materials`, { clientMutationId: randomUUID(), title: 'Datasheet', body: 'Reference sheet for the distance sensor', url: 'https://example.test/sheet' }, 201);
  await post(ada, `/api/v1/workspaces/${ws}/drafts`, { title: 'Presentation outline', body: 'Open with the lamp story.', projectId: project.id }, 201);
  const sketch = await post(ada, `/api/v1/workspaces/${ws}/sketches`, { title: 'Sensing options', scope: 'project', projectId: project.id }, 201);
  await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: 'Ultrasonic is noisy', x: 0, y: 0 }, 201);
  await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: 'Infrared drifts in sunlight', x: 200, y: 0 }, 201);
  const dm = await post(ada, `/api/v1/workspaces/${ws}/dms`, { participantIds: [ben.id, cy.id], title: 'Workshop crew' }, 201);
  await post(ada, `/api/v1/dms/${dm.id}/messages`, { body: 'Lunch plans for the workshop', clientMessageId: randomUUID() }, 201);
  const restricted = await post(ada, `/api/v1/workspaces/${ws}/projects`, { name: 'Closed lab', visibility: 'restricted' }, 201);
  ids[side] = { project: String(project.id), dm: String(dm.id), doc: String(doc.id), sketch: String(sketch.id), restricted: String(restricted.id) };
}

const flat = (parts: { text: string; match: boolean }[]) => parts.map((part) => (part.match ? `[${part.text}]` : part.text)).join('');
/** What a result tells a reader, without ids and without the workspace's own name. */
const shape = (item: SearchResult) => [item.kind, item.label, flat(item.title), item.snippet ? flat(item.snippet) : '', item.task ? `#${item.task.number} ${item.task.status}` : '',
  item.place.type === 'workspace' ? 'workspace' : item.place.type === 'project' || item.place.type === 'dm' ? `${item.place.type}:${item.place.name}` : item.place.type].join(' | ');
const search = async (who: Person, query: Record<string, string | number>) =>
  expectStatus(await who.browser.request('GET', `/api/v1/search?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`), 200, JSON.stringify(query)) as SearchResponse;

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
/** A value in the encodings a stored row could hold: raw, JSON-escaped, SHA-256 hex, and base64 at its three alignments (Yjs update bytes). */
const encodings = (value: string) => {
  const aligned = [0, 1, 2].map((shift) => Buffer.from(`${'x'.repeat(shift)}${value}`).toString('base64').slice(4, -4));
  return [value, JSON.stringify(value).slice(1, -1), createHash('sha256').update(value).digest('hex'), ...aligned];
};
const sessionOf = async (who: Person): Promise<SessionContext> => {
  const [session] = (await pool.query('SELECT s.id, s.expires_at, u.name, u.email FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1', [who.id])).rows;
  return { sessionId: session.id, expiresAt: session.expires_at, principal: { kind: 'human', id: who.id }, user: { id: who.id, name: session.name, email: session.email } };
};

before(async () => {
  await installTestSeals();
  [ada, ben, cy] = [await person('Ada'), await person('Ben'), await person('Cy')];
  A = (await createSealed(ada, 'Garden club', pw)).workspace.id;
  B = (await workspace(ada, 'Book club')).id;
  for (const ws of [A, B]) { await addMember(ada, ws, ben, 'admin'); await addMember(ada, ws, cy, 'member'); }
  await writeSet(A, 'A');
  await writeSet(B, 'B');
});

describe('F-030 S2b: search in an encrypted workspace', () => {
  test('the same query finds the same results, counts and marks in A as in B (parity)', async () => {
    const queries: Record<string, string | number>[] = [
      { q: 'sensor' }, { q: 'sens' }, { q: 'SENSOR' }, { q: 'sensor lamp' }, { q: 'lamp camera' }, { q: '"sensor comparison"' }, { q: '"comparison sensor"' },
      { q: 'sensor -camera' }, { q: 'camera or privacy' }, { q: 'ensor' }, { q: 'omparison' }, { q: 'presentation' }, { q: 'present' }, { q: '#1' }, { q: 'workshop' },
      { q: 'the' }, { q: 'ultrasonic' }, { q: 'ultra' }, { q: 'zzzz' }, { q: 'sensor', type: 'doc' }, { q: 'sensor', type: 'message' }, { q: 'sensor', type: 'work' },
      { q: 'lamp', type: 'draft' }, { q: 'noisy', type: 'sketch' }, { q: 'pavilion' }, { q: 'roadmap pav' }, { q: 'field notes' }, { q: 'sunlight' },
    ];
    for (const query of queries) {
      const [a, b] = [await search(ben, { ...query, place: `project:${ids.A.project}` }), await search(ben, { ...query, place: `project:${ids.B.project}` })];
      assert.deepEqual(a.items.map(shape).sort(), b.items.map(shape).sort(), `results of ${JSON.stringify(query)}`);
      assert.deepEqual(a.counts, b.counts, `counts of ${JSON.stringify(query)}`);
      assert.equal(a.sealedUnavailable, undefined);
    }
    const dm = [await search(ben, { q: 'lunch', place: `dm:${ids.A.dm}` }), await search(ben, { q: 'lunch', place: `dm:${ids.B.dm}` })];
    assert.deepEqual(dm[0]!.items.map(shape), dm[1]!.items.map(shape));
    assert.equal(dm[0]!.items.length, 1);
    // A search for a task by its number puts that task first, as in B.
    const number = [await search(ben, { q: '#1', place: `project:${ids.A.project}` }), await search(ben, { q: '#1', place: `project:${ids.B.project}` })];
    assert.equal(number[0]!.items[0]?.kind, 'work');
    assert.equal(number[1]!.items[0]?.kind, 'work');
  });

  test('a page of results merges the plain and the encrypted source, and the cursor resumes across both', async () => {
    const all = await search(ada, { q: 'sensor', limit: 50 });
    const projectsOf = new Set(all.items.map((item) => (item.place.type === 'project' ? item.place.id : '')));
    assert.ok(projectsOf.has(ids.A.project) && projectsOf.has(ids.B.project), 'both workspaces answer');
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 30; page += 1) {
      const answer = await search(ada, { q: 'sensor', limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...answer.items.map((item) => item.id));
      if (!answer.next) break;
      cursor = answer.next;
    }
    assert.equal(new Set(seen).size, seen.length, 'no result twice');
    assert.deepEqual([...seen].sort(), all.items.map((item) => item.id).sort(), 'the pages together are the whole answer');
    assert.ok(all.items.length >= 12);
  });

  test('the index follows edits, deletions and access changes at once', async () => {
    const note = followup;
    const draft = await post(ada, `/api/v1/workspaces/${A}/drafts`, { title: note, body: 'fresh' }, 201);
    assert.equal((await search(ada, { q: note, place: 'private' })).items.length, 1, 'a new draft is found at once');
    const renamed = canary('renamed').replace(/-/g, ' ');
    expectStatus(await ada.browser.request('PATCH', `/api/v1/drafts/${draft.id}`, { body: { title: renamed }, headers: { ...key(), 'if-match': `"${draft.version}"` } }), 200, 'rename');
    assert.equal((await search(ada, { q: note })).items.length, 0, 'the old title is gone at once');
    assert.equal((await search(ada, { q: renamed })).items.length, 1, 'the new one is found at once');
    // A deleted thought leaves the index at once.
    const sketch = await post(ada, `/api/v1/workspaces/${A}/sketches`, { title: 'Scratch map', scope: 'project', projectId: ids.A.project }, 201);
    const thoughtText = canary('thought').replace(/-/g, ' ');
    const thought = await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: thoughtText, x: 0, y: 0 }, 201);
    assert.equal((await search(ada, { q: thoughtText })).items.length, 1);
    expectStatus(await ada.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/thoughts/${(thought.thought as { id: string }).id}`, { headers: { ...key(), 'if-match': `"${(thought.thought as { version: number }).version}"` } }), 204, 'delete thought');
    assert.equal((await search(ada, { q: thoughtText })).items.length, 0, 'a deleted thought is gone at once');
    // Access is decided on every request: a restricted project's content is invisible to Cy, then visible after a grant.
    const secret = closed;
    await post(ada, `/api/v1/projects/${ids.A.restricted}/conversations`, { body: secret, clientMessageId: randomUUID() }, 201);
    assert.equal((await search(cy, { q: secret })).items.length, 0, 'a restricted project is hidden');
    assert.equal((await search(ada, { q: secret })).items.length, 1);
    await grant(ada, ids.A.restricted, cy, 'viewer');
    assert.equal((await search(cy, { q: secret })).items.length, 1, 'a grant applies to the next search');
  });

  test('hidden matches change neither the answer nor the postings the index reads', async () => {
    const work = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/search/explain?q=sensor+lamp'), 200) as { sealed: { postings: number; terms: number } }).sealed;
    const outsider = await person('Outsider');
    await addMember(ada, A, outsider, 'member');
    const hidden = await project(ada, A, 'Hidden lab', 'restricted');
    const before = await work(outsider);
    const answer = await search(outsider, { q: 'sensor lamp' });
    for (let n = 0; n < 24; n += 1) await post(ada, `/api/v1/projects/${hidden.id}/conversations`, { body: `sensor lamp hidden ${n}`, clientMessageId: randomUUID() }, 201);
    const after = await work(outsider);
    assert.deepEqual(after, before, 'the postings read do not depend on matches the reader cannot see');
    assert.deepEqual((await search(outsider, { q: 'sensor lamp' })).items.map((item) => item.id).sort(), answer.items.map((item) => item.id).sort());
    assert.equal((await search(ada, { q: 'sensor lamp hidden', limit: 50 })).items.length >= 24, true, 'the owner sees them');
  });

  test('the index is dropped when the workspace locks, nothing of A is answered while locked, and it is rebuilt after an unlock', async () => {
    // A person outside A reads which workspaces this API process indexes (the route is a test deployment's).
    const observer = await person('Observer');
    const indexed = async () => (expectStatus(await observer.browser.request('GET', '/api/v1/search/explain?q=sensor'), 200) as { sealedIndexes: string[] }).sealedIndexes;
    assert.ok((await indexed()).includes(A), 'earlier searches built the index');
    assert.equal((await lock(ada.browser, A)).status, 200);
    assert.equal((await indexed()).includes(A), false, 'the lock dropped it');
    // Until S2c lists locked workspaces beside the answer, a search by a member of a locked workspace is refused as a whole (S1 gate).
    const locked = await ada.browser.request('GET', '/api/v1/search?q=sensor');
    assert.equal(locked.status, 423);
    assert.equal(codeOf(locked), 'WORKSPACE_LOCKED');
    assert.equal(JSON.stringify(locked.json).includes('sensor'), false, 'no content in the refusal');
    assert.equal((await indexed()).includes(A), false, 'nothing built it while locked');
    // Cy, who is still a member, gets the same refusal; a search by someone outside A is unaffected by A's lock.
    assert.equal((await cy.browser.request('GET', '/api/v1/search?q=sensor')).status, 423);
    assert.equal((await unlock(ada.browser, A, { password: pw })).status, 200);
    const again = await search(ada, { q: 'sensor', place: `project:${ids.A.project}` });
    assert.ok(again.items.length > 0, 'A answers again');
    assert.ok((await indexed()).includes(A), 'the index is rebuilt');
  });
});

describe('F-030 S2b: live Wiki and live maps in an encrypted workspace', () => {
  /** Two people write one doc live (updates, a catch-up from the stored rows, Save), then an ordinary save retires the generation. */
  async function wikiRoom(side: 'A' | 'B') {
    const docId = ids[side].doc; const c = liveCanaries[side];
    const authority = wikiAuthority({ pool });
    const first = new Y.Doc(); const second = new Y.Doc();
    try {
      const ada1 = await sessionOf(ada); const ben1 = await sessionOf(ben);
      const head = await authority.bootstrap(ada1, docId);
      await authority.enroll(ada1, docId, { generation: head.generation, replicaId: first.clientID });
      await authority.enroll(ben1, docId, { generation: head.generation, replicaId: second.clientID });
      Y.applyUpdate(first, Buffer.from(head.checkpoint, 'base64'));
      Y.applyUpdate(second, Buffer.from(head.checkpoint, 'base64'));
      first.getText('body').insert(head.body.length, ` ${c.wiki}`);
      second.getText('body').insert(0, `${c.peer} `);
      const send = (who: SessionContext, doc: Y.Doc) => {
        const bytes = Y.encodeStateAsUpdate(doc);
        return authority.submit(who, docId, { workspace: head.workspaceId, kind: 'wiki', room: head.resourceId, generation: head.generation,
          actor: who.principal.id, operation: 'text', uuid: randomUUID(), replica: doc.clientID, parameters: null }, bytes, authority.reserve(bytes));
      };
      assert.equal((await send(ada1, first)).sequence, 1, `${side}: first update`);
      assert.equal((await send(ben1, second)).sequence, 2, `${side}: second update`);
      const latest = await authority.bootstrap(ben1, docId);
      assert.ok(latest.body.includes(c.wiki) && latest.body.includes(c.peer), `${side}: both edits are in the shared text`);
      // A catch-up (another process, or after eviction) rebuilds the room from the stored snapshot and log.
      authority.rooms.clear();
      const rebuilt = await authority.bootstrap(ada1, docId);
      assert.equal(rebuilt.body, latest.body, `${side}: rebuilt from the stored rows`);
      const doc = expectStatus(await ada.browser.request('GET', `/api/v1/docs/${docId}`), 200) as Doc & { currentVersion?: number };
      const saved = await authority.save(ada1, docId, { clientCommandId: randomUUID(), expectedVersion: doc.currentVersion ?? doc.version, generation: rebuilt.generation,
        headSequence: rebuilt.sequence, headHash: rebuilt.hash, reason: 'Together' });
      assert.ok(saved.savedDoc?.body.includes(c.wiki), `${side}: Save writes the opened text`);
      const saved2 = expectStatus(await ada.browser.request('GET', `/api/v1/docs/${docId}`), 200) as Doc & { currentVersion?: number };
      expectStatus(await ada.browser.request('PATCH', `/api/v1/docs/${docId}`, { body: { body: `${saved2.body}\nAn ordinary edit.` },
        headers: { ...key(), 'if-match': `"${saved2.currentVersion ?? saved2.version}"` } }), 200, `${side}: PATCH after live`);
    } finally { first.destroy(); second.destroy(); await authority.close(); }
  }

  test('a live Wiki room works for two people in A as in B; every stored head, update, snapshot and receipt of A is sealed', async () => {
    await wikiRoom('B');
    await wikiRoom('A');
    const head = (await pool.query(`SELECT h.body, h.hash FROM doc_live_heads h WHERE h.doc_id = $1`, [ids.A.doc])).rows[0];
    for (const value of [head.body, head.hash]) assert.match(String(value), /fx1\.[1-9]/, 'A: the head is sealed');
    const updates = (await pool.query(`SELECT bytes, fingerprint, ledger::text AS ledger FROM doc_live_updates WHERE doc_id = $1`, [ids.A.doc])).rows;
    assert.ok(updates.length >= 2);
    for (const update of updates) for (const value of [update.bytes, update.fingerprint, update.ledger]) assert.match(String(value), /fx1\.[1-9]/, 'A: updates are sealed');
    const archives = (await pool.query(`SELECT body, hash, codec_state::text AS codec FROM doc_live_archives WHERE doc_id = $1`, [ids.A.doc])).rows;
    assert.ok(archives.length >= 1, 'A: the ordinary save retired the live generation');
    for (const archive of archives) for (const value of [archive.body, archive.hash, archive.codec]) assert.match(String(value), /fx1\.[1-9]/, 'A: the archive is sealed');
    const snapshots = (await pool.query(`SELECT hash FROM doc_live_snapshots WHERE doc_id = $1`, [ids.A.doc])).rows;
    assert.ok(snapshots.length >= 1);
    for (const snapshot of snapshots) assert.match(String(snapshot.hash), /fx1\.[1-9]/);
    const receipts = (await pool.query(`SELECT receipt::text AS receipt, fingerprint FROM live_editing_intents WHERE resource_id = $1`, [ids.A.doc])).rows;
    assert.ok(receipts.length >= 2);
    for (const receipt of receipts) assert.match(`${receipt.receipt}${receipt.fingerprint}`, /fx1\.[1-9]/);
    // The same rows of B are plain: the positive control of the scans.
    const plain = (await pool.query(`SELECT body FROM doc_live_heads WHERE doc_id = $1`, [ids.B.doc])).rows[0];
    assert.ok(String(plain.body).includes(liveCanaries.B.wiki), 'B: the head holds the text');
  });

  async function mapEdits(side: 'A' | 'B') {
    const sketchId = ids[side].sketch; const c = liveCanaries[side];
    expectStatus(await ben.browser.request('GET', `/api/v1/sketches/${sketchId}/live`), 200, `${side}: live bootstrap`);
    const thought = await post(ben, `/api/v1/sketches/${sketchId}/thoughts`, { text: c.map, x: 40, y: 40 }, 201);
    const other = await post(ben, `/api/v1/sketches/${sketchId}/thoughts`, { text: `${c.map} two`, x: 240, y: 40 }, 201);
    await post(ben, `/api/v1/sketches/${sketchId}/links`, { fromId: (thought.thought as { id: string }).id, toId: (other.thought as { id: string }).id, label: c.mapLabel }, 201);
    const map = expectStatus(await ada.browser.request('GET', `/api/v1/sketches/${sketchId}`), 200) as Sketch;
    assert.ok(JSON.stringify(map).includes(c.map), `${side}: the other person reads the live edit`);
    assert.ok(JSON.stringify(map).includes(c.mapLabel), `${side}: and the link label`);
  }

  test('a live map journals sealed in A and plain in B; the room opens for a reader and closes when the workspace locks', async () => {
    await mapEdits('B');
    await mapEdits('A');
    const sketchId = ids.A.sketch;
    const journal = (await pool.query(`SELECT change::text AS change, fingerprint FROM map_live_journal WHERE sketch_id = $1`, [sketchId])).rows;
    assert.ok(journal.length >= 3, `journalled: ${journal.length}`);
    for (const entry of journal) assert.match(`${entry.change}${entry.fingerprint}`, /fx1\.[1-9]/, 'A: the journal is sealed');
    const intents = (await pool.query(`SELECT receipt::text AS receipt FROM live_editing_intents WHERE resource_id = $1`, [sketchId])).rows;
    for (const intent of intents) assert.match(String(intent.receipt), /fx1\.[1-9]/);
    const plain = (await pool.query(`SELECT change::text AS change FROM map_live_journal WHERE sketch_id = $1`, [ids.B.sketch])).rows;
    assert.ok(plain.some((entry) => String(entry.change).includes(liveCanaries.B.map)), 'B: its journal holds the text (positive control)');

    // The room: open for a reader, closed by the lock.
    const upgrade = () => new Promise<{ socket?: WebSocket; status: number }>((resolve) => {
      const url = new URL(`/api/v1/editing?kind=map&id=${sketchId}`, apiUrl); url.protocol = 'ws:';
      const ws = new WebSocket(url, { headers: { origin: publicOrigin, host: new URL(publicOrigin).host, cookie: ben.browser.cookieHeader() }, perMessageDeflate: false });
      ws.once('open', () => resolve({ socket: ws, status: 101 }));
      ws.once('unexpected-response', (_request, response) => { resolve({ status: response.statusCode ?? 0 }); ws.terminate(); });
      ws.once('error', () => resolve({ status: 0 }));
    });
    const opened = await upgrade();
    assert.equal(opened.status, 101, 'a reader opens the room of A');
    const closed = new Promise<number>((resolve) => opened.socket!.once('close', (code) => resolve(code)));
    assert.equal((await lock(ada.browser, A)).status, 200);
    assert.equal(await Promise.race([closed, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000))]), 4423, 'the room closed when the workspace locked');
    // While locked the upgrade is refused with 423 and the live routes answer 423.
    assert.equal((await upgrade()).status, 423);
    assert.equal((await ben.browser.request('GET', `/api/v1/sketches/${sketchId}/live`)).status, 423);
    assert.equal((await ben.browser.request('GET', `/api/v1/docs/${ids.A.doc}/live`)).status, 423);
    const authority = wikiAuthority({ pool });
    try { await assert.rejects(authority.bootstrap(await sessionOf(ada), ids.A.doc), { code: 'WORKSPACE_LOCKED' }); } finally { await authority.close(); }
    assert.equal((await unlock(ada.browser, A, { password: pw })).status, 200);
  });

  test('a map\'s "hide empty maps" list leaves out an empty sealed map and keeps one with a thought or a title', async () => {
    for (const [side, ws] of [['A', A], ['B', B]] as const) {
      const empty = await post(ada, `/api/v1/workspaces/${ws}/sketches`, { title: UNTITLED_SKETCH, scope: 'project', projectId: ids[side].project }, 201);
      const titled = await post(ada, `/api/v1/workspaces/${ws}/sketches`, { title: `Named map ${side}`, scope: 'project', projectId: ids[side].project }, 201);
      const list = async () => (expectStatus(await ada.browser.request('GET', `/api/v1/workspaces/${ws}/sketches?projectId=${ids[side].project}&hideEmpty=true&limit=50`), 200) as { items: { id: string }[]; total: number });
      const hidden = await list();
      assert.equal(hidden.items.some((item) => item.id === String(empty.id)), false, `${side}: the empty map is left out`);
      assert.equal(hidden.items.some((item) => item.id === String(titled.id)), true, `${side}: a named map stays`);
      assert.equal(hidden.total, hidden.items.length, `${side}: the total agrees`);
      await post(ada, `/api/v1/sketches/${empty.id}/thoughts`, { text: 'First idea', x: 0, y: 0 }, 201);
      assert.equal((await list()).items.some((item) => item.id === String(empty.id)), true, `${side}: a map with a thought is listed`);
    }
  });
});

describe('F-030 S2b: nothing of A is on disk', () => {
  test('no row of any table holds a canary of A (search, live Wiki, live map); B\'s are found', async () => {
    const dump = await databaseText();
    const a = liveCanaries.A; const b = liveCanaries.B;
    const aCanaries = [a.wiki, a.peer, a.map, a.mapLabel, followup, closed];
    for (const value of aCanaries) for (const form of encodings(value)) assert.equal(dump.includes(form), false, `A: ${value.slice(0, 28)} as ${form.slice(0, 18)}`);
    // The positive controls: the same kinds of text in the plain workspace B are in its rows.
    for (const value of [b.wiki, b.peer, b.map, b.mapLabel]) assert.ok(encodings(value).some((form) => dump.includes(form)), `B: ${value.slice(0, 28)} is in the rows`);
    // The placeholder rows of A hold no text; B's rows hold it.
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = $1 AND kind <> 'person' AND (title <> '' OR body <> '')`, [A])).rows[0].n, 0);
    assert.ok((await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = $1 AND title <> ''`, [B])).rows[0].n > 5);
    // scripts/check_encryption.sh scans the data directory and the WAL of PostgreSQL for the canaries of A (none) and of B (found).
    const state = process.env.FLUX_TEST_STATE_DIR ?? '/state';
    await writeFile(join(state, 'encryption-disk-canaries.txt'), aCanaries.flatMap(encodings).join('\n') + '\n');
    await writeFile(join(state, 'encryption-disk-control.txt'), [b.wiki, b.map, b.mapLabel].join('\n') + '\n');
  });
});
