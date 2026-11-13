import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { searchRows, searchVectorRows, type SearchPlanRows } from '@flux/db';
import { createEmbedder, createQueryVectors, type Principal } from '@flux/core';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { db, pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

// The REAL embedding container (text-embeddings-inference with bge-m3, docker/compose.embeddings.yaml), through the REAL worker and API of
// the check stack. It runs only when the stack has the container:
//
//   FLUX_CHECK_EMBEDDINGS=on [FLUX_CHECK_EMBEDDINGS_CACHE=<host dir for the model>] [FLUX_TEST_RECALL_FILE=<seed.json>] \
//     ./scripts/check_application.sh tests/app/search-vectors-live.test.ts
//
// The first start downloads the model (2.3 GB). Without FLUX_TEST_RECALL_FILE only the pipeline is checked. With it (a seed.json of
// scripts/eval/retrieval/seed.py: `python3 seed.py --out seed.json [--messages 10000]`) the corpus of the research bench (#1242) is put
// in the search index of a workspace of this stack, the real worker embeds it, and recall@10 of BM25 and of the hybrid is measured through
// the repository's own `ranked`, for the 60 questions in the three forms of the research. Result lines start with `RECALL`.

const containerUrl = process.env.FLUX_TEST_EMBEDDINGS_URL;
const corpusFile = process.env.FLUX_TEST_RECALL_CORPUS;
const vectorRows = searchVectorRows(db);
const access = policySearchAccess(db);
const human = (someone: Person): Principal => ({ id: someone.id, kind: 'human' });
const text = (parts: { text: string }[] | null) => (parts ?? []).map((part) => part.text).join('');
const plain = (words: string) => words.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function plan(words: string, reader: string, limit = 20): SearchPlanRows {
  return { text: words, prefix: null, fuzzy: false, number: null, words: plain(words), kinds: null, place: null, author: null, after: null, limit, reader };
}

describe('the real embedding container, worker and hybrid ranking', { skip: containerUrl ? false : 'FLUX_TEST_EMBEDDINGS_URL is not set: the stack has no embedding container (see the header)' }, () => {
  const embedder = createEmbedder(containerUrl ?? 'http://embeddings:8080');
  const hook = createQueryVectors(embedder, { log: (message) => console.warn(message) });

  test('the container answers with bge-m3 vectors, and the worker switches embeddings on by itself', async () => {
    const model = await waitFor(async () => embedder.model().catch(() => null), 'the container to load its model', 20 * 60_000);
    assert.equal(model, 'BAAI/bge-m3');
    const [vector] = await embedder.embed(['Kalibracja czujników jest zaplanowana na piątek.']);
    assert.equal(vector!.length, 1024);
    assert.ok(Math.abs(Math.hypot(...vector!) - 1) < 1e-3, 'normalised');
    await waitFor(async () => (await vectorRows.counts()).model === 'BAAI/bge-m3', 'the worker to turn embeddings on', 3 * 60_000);
  });

  test('a message gets its vector from the real worker, is found by meaning across languages, and an edit replaces the vector', async () => {
    const ari = await person('Ari Nowak');
    const ws = await workspace(ari, 'Zielony Dach');
    const space = await createProject(ari, ws.id, 'Dostawy', 'workspace');
    const conversation = expectStatus(await ari.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, {
      body: { body: 'Faktura za dostawę czujników temperatury została opłacona w środę.', clientMessageId: randomUUID() } }), 201) as { id: string };
    const row = async () => (await pool.query<{ id: string }>(`SELECT id::text FROM search_documents WHERE project_id = $1 AND kind = 'message'`, [space.id])).rows[0]!.id;
    const vectorOf = async (id: string) => (await pool.query<{ v: string }>(`SELECT embedding::text AS v FROM search_vectors WHERE document_id = $1`, [id])).rows[0]?.v;
    const id = await row();
    const first = await waitFor(async () => vectorOf(id), 'the real worker to embed the message', 120_000);

    // An English question about a Polish message shares no word with it: only the vector finds it.
    const question = 'Was the invoice for the temperature sensors paid?';
    const audiences = await access.audiences(human(ari));
    const lexical = await searchRows(db).ranked(audiences, plan(question, ari.id));
    const hybrid = await searchRows(db, hook).ranked(audiences, plan(question, ari.id));
    const own = (hits: typeof hybrid) => hits.findIndex((hit) => text(hit.snippet).startsWith('Faktura za dostawę'));
    console.log(`RECALL pipeline: the Polish message is hit ${own(lexical) + 1} of ${lexical.length} by BM25 alone and hit ${own(hybrid) + 1} of ${hybrid.length} by the hybrid (0 = not found)`);
    assert.equal(own(hybrid), 0, 'found by meaning, first');

    expectStatus(await ari.browser.request('PATCH', `/api/v1/conversations/${conversation.id}/messages/${(await pool.query<{ id: string }>(`SELECT id::text FROM project_messages WHERE conversation_id = $1`, [conversation.id])).rows[0]!.id}`, {
      body: { body: 'Dostawa czujników opóźniona o tydzień z powodu strajku.' } }), 200);
    assert.equal(await vectorOf(id), undefined, 'the old words lose their vector in the edit\'s transaction');
    const second = await waitFor(async () => vectorOf(id), 'the vector of the new words', 120_000);
    assert.notEqual(second, first);
  });

  test('an agent\'s flux_search through the API container ranks by meaning too, and finds only what its owner reads', async () => {
    const ari = await person('Agnes Search');
    const nia = await person('Nia Search');
    const ws = await workspace(ari, 'Agents Dach');
    await addMember(ari, ws.id, nia, 'member');
    const space = await createProject(ari, ws.id, 'Dostawy', 'workspace');
    const hidden = await createProject(ari, ws.id, 'Zarząd', 'restricted');
    const post = async (projectId: string, body: string) => expectStatus(await ari.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201);
    await post(space.id, 'Faktura za dostawę czujników temperatury została opłacona w środę.');
    await post(hidden.id, 'Faktura zarządu za temperaturę w serwerowni czeka na podpis prezesa.');
    const rows = async () => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.kind = 'message' AND d.project_id = ANY($1)`, [[space.id, hidden.id]])).rows[0]!.n;
    await waitFor(async () => (await rows()) === 2, 'the real worker to embed both messages', 120_000);
    const agent = expectStatus(await nia.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string };
    const connection = await agentConnection(pool, nia.browser, agent.id, [space.id]);
    const found = toolValue((await connection.raw('flux_search', { q: 'Was the invoice for the temperature sensors paid?' })).message) as unknown as { results: { snippet?: string; title?: string }[] };
    const shown = found.results.map((hit) => (hit.snippet ?? hit.title ?? '').replace(/\*\*/g, ''));
    console.log(`RECALL agent: ${shown.length} hits, the first: ${(shown[0] ?? '').slice(0, 60)}`);
    assert.match(shown[0] ?? '', /^Faktura za dostawę/, 'found by meaning, first');
    assert.ok(!shown.some((text) => text.startsWith('Faktura zarządu')), 'the restricted space is not the owner\'s to read, so its vector is never a hit');
  });

  test('recall@10 on the research bench: BM25 alone and the hybrid, through the repository\'s own ranked', { skip: corpusFile ? false : 'FLUX_TEST_RECALL_CORPUS is not set (FLUX_TEST_RECALL_FILE)' }, async () => {
    const seed = JSON.parse(readFileSync(corpusFile!, 'utf8')) as Seed;
    const started = Date.now();
    const ari = await person('Ada Nowak');
    const ws = await workspace(ari, seed.workspace.name);
    const people = new Map<string, Person>([['ada', ari]]);
    for (const p of seed.people.filter((item) => item.key !== 'ada')) {
      const someone = await person(p.name);
      people.set(p.key, someone);
      await addMember(ari, ws.id, someone, p.role === 'guest' ? 'guest' : p.role === 'admin' ? 'admin' : 'member');
    }
    const spaces = new Map<string, Project>();
    for (const s of seed.spaces) {
      const space = await createProject(ari, ws.id, s.name, s.visibility === 'restricted' ? 'restricted' : 'workspace');
      spaces.set(s.key, space);
      // The asker reads all six spaces (the bench's agent, Ada's).
      for (const [key, role] of [['ada', 'contributor'], ...Object.entries(s.grants)] as [string, string][]) {
        if (key !== 'ada' || s.visibility === 'restricted') await grant(ari, space.id, people.get(key)!, role === 'manager' ? 'manager' : 'contributor').catch(() => undefined);
      }
    }
    const conversations = new Map(seed.conversations.map((c) => [c.key, c]));
    // The corpus goes into the search index as the triggers of the source tables would write it; the real worker embeds it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of seed.messages) {
        const space = spaces.get(conversations.get(m.conversation)!.space)!;
        await client.query(`SELECT search_put($1, 'message', $2, $3, $4, $5, $6, NULL, NULL, '', $7, 'human', $8, $9)`,
          [`message:${m.id}`, ws.id, `project:${space.id}`, space.id, m.id, conversations.get(m.conversation)!.id, m.body, people.get(m.author)!.id, m.at]);
      }
      await client.query('COMMIT');
    } finally { client.release(); }
    const total = seed.messages.length;
    console.log(`RECALL loaded ${total} messages in ${Math.round((Date.now() - started) / 1000)} s`);
    const embeddedAt = Date.now();
    let last = 0;
    await waitFor(async () => {
      const done = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.workspace_id = $1 AND d.kind = 'message'`, [ws.id])).rows[0]!.n;
      if (Date.now() - last > 30_000) { last = Date.now(); console.log(`RECALL embedded ${done} of ${total} (${Math.round((Date.now() - embeddedAt) / 1000)} s)`); }
      return done >= total;
    }, 'the real worker to embed the corpus', Number(process.env.FLUX_TEST_RECALL_WAIT_MINUTES ?? 60) * 60_000);
    const embedSeconds = Math.round((Date.now() - embeddedAt) / 1000);
    console.log(`RECALL embedded ${total} messages in ${embedSeconds} s (${(total / Math.max(1, embedSeconds)).toFixed(1)} a second)`);

    const audiences = await access.audiences(human(ari));
    const lexical = searchRows(db);
    const hybrid = searchRows(db, hook);
    const results: Record<string, Record<string, unknown>> = {};
    const mean = (items: number[]) => Math.round(1000 * items.reduce((sum, item) => sum + item, 0) / items.length) / 1000;
    type Question = Seed['questions'][number];
    /** The plan of a question, with its date range inside the statement (the bench applies the range to every option). */
    const planOf = (q: Question, words: string, limit: number): SearchPlanRows => ({ ...plan(words, ari.id, limit), since: q.after ? new Date(q.after) : null, until: q.before ? new Date(q.before) : null });
    const recallOf = (ids: string[], q: Question) => { const found = new Set(ids.slice(0, 10)); return q.gold_ids.filter((id) => found.has(id)).length / q.gold_ids.length; };
    /** Reciprocal rank fusion (k = 60) of two ranked lists, each cut at `depth`. */
    const fuse = (first: string[], second: string[], depth: number) => {
      const score = new Map<string, number>();
      for (const list of [first, second]) list.slice(0, depth).forEach((id, index) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + index + 1)));
      return [...score].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    };
    const timings: Record<string, number[]> = {};
    /** The nearest messages by cosine distance within the question's dates, exactly (the statement uses no approximate index, #1326's rule). */
    async function nearest(vector: number[], q: Question, how: 'exact'): Promise<string[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const started = performance.now();
        const rows = await client.query<{ object_id: string }>(`SELECT d.object_id FROM search_vectors v JOIN search_documents d ON d.id = v.document_id
          WHERE d.workspace_id = $1 AND d.kind = 'message' AND ($3::timestamptz IS NULL OR d.at >= $3) AND ($4::timestamptz IS NULL OR d.at < $4)
          ORDER BY v.embedding <=> $2::halfvec LIMIT 100`, [ws.id, `[${vector.join(',')}]`, q.after ?? null, q.before ?? null]);
        (timings[String(how)] ??= []).push(performance.now() - started);
        await client.query('COMMIT');
        return rows.rows.map((row) => row.object_id);
      } finally { client.release(); }
    }
    for (const form of ['question', 'keywords', 'bilingual'] as const) {
      const strategies: Record<string, { id: string; category: string; recall: number }[]> = {};
      const note = (name: string, q: Question, ids: string[]) => (strategies[name] ??= []).push({ id: q.id, category: q.category, recall: recallOf(ids, q) });
      for (const q of seed.questions) {
        const words = form === 'bilingual' ? `${q.keywords} ${q.keywords_other}` : q[form];
        const lex = (await lexical.ranked(audiences, planOf(q, words, 100))).map((hit) => hit.objectId);
        const fused = (await hybrid.ranked(audiences, planOf(q, words, 100))).map((hit) => hit.objectId);
        const vector = (await hook(plain(words)))!;
        const exact = await nearest(vector, q, 'exact');
        console.log(`RECALL_LISTS ${JSON.stringify({ form, q: q.id, gold: q.gold_ids, lex, vec: exact, hybrid: fused.slice(0, 20) })}`);
        note('bm25', q, lex);
        note('HYBRID ranked (production)', q, fused);
        note('vector exact', q, exact);
        note('fusion of exact lists, depth 50', q, fuse(lex, exact, 50));
        note('fusion of exact lists, depth 100', q, fuse(lex, exact, 100));
      }
      for (const [name, per] of Object.entries(strategies)) {
        const categories: Record<string, number> = {};
        for (const category of [...new Set(per.map((item) => item.category))].sort()) categories[category] = mean(per.filter((item) => item.category === category).map((item) => item.recall));
        const all = mean(per.map((item) => item.recall));
        results[`${name}/${form}`] = { recall10: all, categories, perQuestion: per.map((item) => [item.id, Math.round(item.recall * 100) / 100]) };
        console.log(`RECALL ${name.padEnd(34)} ${form.padEnd(9)} r@10=${all.toFixed(3)} ${JSON.stringify(categories)}`);
      }
    }
    const ms = (values: number[]) => `${mean(values)} ms mean, ${Math.round(100 * values.sort((x, y) => x - y)[Math.floor(values.length * 0.95)]!) / 100} ms p95`;
    console.log(`RECALL the vector list alone: ${Object.entries(timings).map(([how, values]) => `${how}: ${ms(values)}`).join('; ')}`);
    console.log(`RECALL_RESULT ${JSON.stringify({ messages: total, questions: seed.questions.length, embedSeconds, results })}`);
    const q = (name: string) => (results[name] as { recall10: number }).recall10;
    assert.ok(q('HYBRID ranked (production)/question') >= q('bm25/question'), 'the hybrid finds at least what BM25 alone finds, for the questions as asked');
    // The research's figure for the question as asked (0.75, bge-m3, 10,000 messages) is reported, not asserted: Flux's own statement measured
    // 0.700 (docs/product/research/2026-11-ai-context-retrieval.md, "Measured in Flux itself"), accepted as the bench result (founder
    // decision, 2026-11-13, on #1341). FLUX_TEST_RECALL_MIN sets a bar for a run that has one.
    console.log(`RECALL the research's hybrid figure is 0.75 for the question as asked; Flux's statement: ${q('HYBRID ranked (production)/question')}`);
    if (process.env.FLUX_TEST_RECALL_MIN) assert.ok(q('HYBRID ranked (production)/question') >= Number(process.env.FLUX_TEST_RECALL_MIN), 'recall@10 of the hybrid is below FLUX_TEST_RECALL_MIN');
  });
});

interface Project { id: string }
interface Seed {
  workspace: { name: string };
  people: { key: string; name: string; role: string }[];
  spaces: { key: string; name: string; visibility: string; grants: Record<string, string> }[];
  conversations: { key: string; id: string; space: string }[];
  messages: { id: string; conversation: string; author: string; at: string; body: string }[];
  questions: { id: string; category: string; question: string; keywords: string; keywords_other: string; after?: string; before?: string; gold_ids: string[] }[];
}
