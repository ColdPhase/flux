import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { projectObjectNoticesPath, type Project } from '@flux/contracts';
import { pool } from './support/db.js';
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
const kinds = ['project', 'goal', 'message', 'reply', 'large', 'dmTitle', 'dmMessage', 'decision', 'rationale', 'result', 'evidence', 'draft', 'draftBody', 'draftEdit'] as const;
type Kind = typeof kinds[number];
const canaries: Record<'A' | 'B', Record<Kind, string>> = { A: {} as Record<Kind, string>, B: {} as Record<Kind, string> };
for (const side of ['A', 'B'] as const) {
  for (const kind of kinds) canaries[side][kind] = `canary-${side}-${kind}-${randomUUID()}`;
  // Over 8 KiB of repetitive text, so PostgreSQL TOASTs and compresses it (the dump decompresses; the scan reads values).
  canaries[side].large = `${canaries[side].large} ${'garden '.repeat(1500).trim()}`;
}
const ids: Record<'A' | 'B', { project: string; conversation: string; dm: string; decision: string; result: string; draft: string }> = {} as never;
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
  ids[side] = { project: project.id, conversation: String(conversation.id), dm: String(dm.id), decision: String(decision.id), result: String(result.id), draft: String(draft.id) };
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
      assert.deepEqual(roots.roots.map((root) => root.message.body), [c.message]);
      const dm = expectStatus(await ben.browser.request('GET', `/api/v1/dms/${id.dm}`), 200) as { title: string | null; messages: { body: string }[] };
      assert.deepEqual({ title: dm.title, bodies: dm.messages.map((m) => m.body) }, { title: c.dmTitle, bodies: [c.dmMessage] }, side);
      const dms = expectStatus(await ben.browser.request('GET', `/api/v1/workspaces/${side === 'A' ? A : B}/dms`), 200) as { items: { title: string | null; lastMessageBody?: string | null }[] };
      assert.equal(dms.items[0]?.title, c.dmTitle);
      const decision = expectStatus(await ben.browser.request('GET', `/api/v1/decisions/${id.decision}`), 200) as { title: string; rationale: string; status: string };
      assert.deepEqual({ ...decision, status: decision.status }, { ...decision, title: c.decision, rationale: c.rationale, status: 'accepted' }, side);
      const notices = expectStatus(await ben.browser.request('GET', projectObjectNoticesPath(id.project)), 200) as { items: { title: string }[] };
      assert.deepEqual(new Set(notices.items.map((item) => item.title)), new Set([c.decision, c.result]), `${side}: object notices (#696) open their titles`);
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
