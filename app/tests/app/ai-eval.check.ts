import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import {
  agentAssistantRunsPath, ASSISTANT_MODEL_PATH, assistantRunPath, backgroundComputeConnectionsPath, conversationAssistantRunsPath, MY_AGENTS_PATH, myAgentPath,
  taskDiscussionPath, type AssistantModelChoice, type AssistantRun, type MyAgentList,
} from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { signIn } from './support/http.js';
import { addMember, expectStatus, grant, password, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';

// TEST ONLY: the API side of scripts/check_ai_eval.sh, the answer-accuracy evaluation of #1295 (founder decision 2026-11-13). It loads the
// workspace that scripts/eval/answers/workspace.py wrote (the retrieval bench's 10,000 messages, Wiki pages, tasks with discussions,
// decisions, maps, files, and messages at ages relative to today) into a real Flux through its API, as its people would write it, then
// moves each message to its date. The owner saves her REAL Anthropic key through Connect AI, and every question is asked of her agent through
// the API-key engine, end to end: its brief, its tools (flux_search, flux_read_around, flux_summarize, flux_get_doc …) and its tool loop.
// The worker's requests reach Anthropic through the recording proxy (support/eval-proxy.ts), which tells what each question cost and
// which tools it called. An LLM judge with a fixed rubric then grades each answer against its reference, next to exact keys.
//
// Steps: wait-ready, seed, connect, ask, judge, report. Evidence under FLUX_EVAL_EVIDENCE (/evidence). The key is read from
// FLUX_EVAL_ANTHROPIC_KEY by `connect` (sent once to Flux, which seals it) and by `judge`; it is never printed or written.

const evidence = process.env.FLUX_EVAL_EVIDENCE ?? '/evidence';
const stateFile = `${evidence}/state.json`;
const proxyUrl = process.env.FLUX_EVAL_PROXY_URL ?? 'http://evalproxy:8099';
const MODEL = process.env.FLUX_EVAL_MODEL ?? 'claude-haiku-5-5';
const JUDGE_MODEL = process.env.FLUX_EVAL_JUDGE_MODEL ?? 'claude-haiku-5-5';
const RUN_WAIT_SECONDS = Number(process.env.FLUX_EVAL_RUN_WAIT_SECONDS ?? '600');
const { pool } = createDatabase(process.env.DATABASE_URL!);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// --- The seed file (scripts/eval/answers/workspace.py).

interface SeedMessage { conv: string; author: string; at: string; body: string; key: string | null; file?: string; inWindow?: boolean }
interface Question {
  id: string; category: string; lang: 'pl' | 'en'; ask: string; question: string; gold: string[]; keys: string[]; answer: string;
  refuse?: boolean; dates?: boolean; bench?: string; goldInWindow: string[];
}
interface Seed {
  today: string; now: string; shiftDays: number; window: number;
  workspace: { name: string };
  people: { key: string; name: string; role: 'owner' | 'admin' | 'member' | 'guest' }[];
  spaces: { key: string; name: string; visibility: 'workspace' | 'restricted'; grants: Record<string, string> }[];
  conversations: { key: string; space: string }[];
  messages: SeedMessage[];
  docs: { key: string; space: string; author: string; title: string; body: string }[];
  tasks: { key: string; space: string; author: string; title: string; discussion: { key: string; author: string; at: string; body: string }[] }[];
  decisions: { key: string; space: string; author: string; title: string; rationale: string }[];
  maps: { key: string; space: string; author: string; title: string; thoughts: { key: string; text: string }[] }[];
  files: Record<string, { name: string; contentType: string; base64: string; bytes: number }>;
  questions: Question[];
}
const loadSeed = async () => JSON.parse(await readFile(`${evidence}/eval-seed.json`, 'utf8')) as Seed;

/** A seeded source as Flux knows it: what a citation or a tool result names it by. */
interface Source { kind: string; id: string; title?: string; number?: number; conversationId?: string; sketchId?: string; text: string }
interface State {
  workspaceId?: string; people: Record<string, { id: string; email: string }>; spaces: Record<string, string>; conversations: Record<string, string>;
  sources: Record<string, Source>; connectionId?: string; firstAgentId?: string; connectDefault?: unknown; seededSeconds?: number;
}
const load = async (): Promise<State> => ({ people: {}, spaces: {}, conversations: {}, sources: {}, ...JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as Partial<State> });
const save = (state: State) => writeFile(stateFile, JSON.stringify(state, null, 1));

const sessions = new Map<string, Person>();
async function as(key: string): Promise<Person> {
  const known = sessions.get(key);
  if (known) return known;
  const state = await load();
  const who = state.people[key];
  assert.ok(who, `no person ${key}`);
  const { browser, response } = await signIn(who.email, password);
  assert.equal(response.status, 200, `${key} signs in`);
  const someone = { id: who.id, email: who.email, browser };
  sessions.set(key, someone);
  return someone;
}

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, seconds: number): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 500)}`);
    await sleep(1000);
    value = await read();
  }
  return value;
}

/** At most `limit` of `items` at once, in order within each worker. */
async function parallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const fold = (value: string) => value.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');

// --- Seeding through the API, as the people would write it.

async function upload(who: Person, projectId: string, file: Seed['files'][string]): Promise<string> {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(file.name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin },
    body: Buffer.from(file.base64, 'base64'),
  });
  const body = await response.json() as { id?: string; code?: string };
  assert.equal(response.status, 201, `upload ${file.name}: ${JSON.stringify(body)}`);
  return body.id!;
}

async function seedAll() {
  const seed = await loadSeed();
  const started = Date.now();
  const state = await load();
  assert.ok(!state.workspaceId, 'the workspace is seeded once per stack');
  for (const someone of seed.people) {
    const made = await person(someone.name);
    state.people[someone.key] = { id: made.id, email: made.email };
    sessions.set(someone.key, made);
  }
  await save(state);
  const owner = seed.people.find((someone) => someone.role === 'owner')!;
  const ada = await as(owner.key);
  const ws = await createWorkspace(ada, seed.workspace.name);
  state.workspaceId = ws.id;
  for (const someone of seed.people) if (someone.key !== owner.key) await addMember(ada, ws.id, await as(someone.key), someone.role === 'owner' ? 'admin' : someone.role);
  for (const space of seed.spaces) {
    const made = await createProject(ada, ws.id, space.name, space.visibility);
    state.spaces[space.key] = made.id;
    for (const [key, role] of Object.entries(space.grants)) if (key !== owner.key) await grant(ada, made.id, await as(key), role as 'contributor');
  }
  await save(state);

  // Messages, conversation by conversation in their order (the sequence is the order of the dates), seven conversations at once.
  const byConv = new Map<string, SeedMessage[]>();
  for (const message of seed.messages) byConv.set(message.conv, [...(byConv.get(message.conv) ?? []), message]);
  const spaceOf = new Map(seed.conversations.map((conversation) => [conversation.key, conversation.space]));
  const dated: { id: string; at: string }[] = [];
  let posted = 0;
  await parallel([...byConv.entries()], 8, async ([conv, messages]) => {
    const projectId = state.spaces[spaceOf.get(conv)!]!;
    let conversationId = '';
    for (const message of messages) {
      const who = await as(message.author);
      const body: Record<string, unknown> = { body: message.body, clientMessageId: randomUUID() };
      const fileId = message.file ? await upload(who, projectId, seed.files[message.file]!) : null;
      if (fileId) body.attachmentIds = [fileId];
      const path = conversationId ? `/api/v1/conversations/${conversationId}/messages` : `/api/v1/projects/${projectId}/conversations`;
      const made = expectStatus(await who.browser.request('POST', path, { body }), 201, `${conv} message`) as { id: string; conversationId?: string };
      if (!conversationId) {
        const { rows } = await pool.query<{ conversation_id: string; id: string }>(
          `SELECT conversation_id, id FROM project_messages WHERE project_id = $1 AND client_message_id = $2`, [projectId, body.clientMessageId]);
        conversationId = rows[0]!.conversation_id;
        state.conversations[conv] = conversationId;
        made.id = rows[0]!.id;
      }
      dated.push({ id: made.id, at: message.at });
      if (message.key) {
        const key = message.key.startsWith('file:') ? message.key : `message:${message.key}`;
        // A file is known by its own id and name; the message that carries it says nothing of what is inside.
        state.sources[key] = fileId ? { kind: 'file', id: fileId, title: seed.files[message.file!]!.name, conversationId, text: seed.files[message.file!]!.name }
          : { kind: 'message', id: made.id, conversationId, text: message.body };
      }
      if (++posted % 1000 === 0) console.log(`posted ${posted} of ${seed.messages.length} messages (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  });
  await save(state);

  for (const doc of seed.docs) {
    const made = expectStatus(await (await as(doc.author)).browser.request('POST', `/api/v1/projects/${state.spaces[doc.space]}/docs`, { body: { title: doc.title, body: doc.body } }), 201, 'doc') as { id: string };
    state.sources[`doc:${doc.key}`] = { kind: 'doc', id: made.id, title: doc.title, text: doc.body };
  }
  for (const task of seed.tasks) {
    const who = await as(task.author);
    const made = expectStatus(await who.browser.request('POST', `/api/v1/projects/${state.spaces[task.space]}/work`, { body: { title: task.title } }), 201, 'task') as { id: string; number: number };
    state.sources[`task:${task.key}`] = { kind: 'task', id: made.id, number: made.number, title: task.title, text: task.title };
    for (const line of task.discussion) {
      const sent = expectStatus(await (await as(line.author)).browser.request('POST', taskDiscussionPath(made.id), { body: { body: line.body, clientMessageId: randomUUID() } }), 201, 'discussion') as { id: string };
      state.sources[`message:${line.key}`] = { kind: 'message', id: sent.id, text: line.body };
      dated.push({ id: sent.id, at: line.at });
    }
  }
  for (const decision of seed.decisions) {
    const who = await as(decision.author);
    const made = expectStatus(await who.browser.request('POST', `/api/v1/projects/${state.spaces[decision.space]}/decisions`, { body: { title: decision.title, rationale: decision.rationale } }), 201, 'decision') as { id: string; version: number };
    expectStatus(await who.browser.request('POST', `/api/v1/decisions/${made.id}/accept`, { body: {}, headers: { 'if-match': `"${made.version}"` } }), 200, 'accept');
    state.sources[`decision:${decision.key}`] = { kind: 'decision', id: made.id, title: decision.title, text: `${decision.title} ${decision.rationale}` };
  }
  for (const map of seed.maps) {
    const who = await as(map.author);
    const sketch = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${state.workspaceId}/sketches`, { body: { title: map.title, scope: 'project', projectId: state.spaces[map.space] } }), 201, 'map') as { id: string };
    let x = 0;
    for (const thought of map.thoughts) {
      const made = expectStatus(await who.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: thought.text, x: (x += 240), y: 0 } }), 201, 'thought') as { thought?: { id: string }; id?: string };
      state.sources[`thought:${thought.key}`] = { kind: 'thought', id: made.thought?.id ?? made.id!, sketchId: sketch.id, title: map.title, text: thought.text };
    }
  }
  await save(state);

  // Each message to its date: the search index's triggers take the new time with it (search_documents.at), as for a message written then.
  // In slices: each row's update reindexes it, and one statement for all of them outlasts the pool's query timeout.
  for (let at = 0; at < dated.length; at += 250) {
    const slice = dated.slice(at, at + 250);
    await pool.query(`UPDATE project_messages m SET created_at = d.at::timestamptz FROM unnest($1::uuid[], $2::text[]) AS d(id, at) WHERE m.id = d.id`,
      [slice.map((row) => row.id), slice.map((row) => row.at)]);
  }
  await pool.query(`UPDATE project_conversations c SET created_at = f.at FROM (SELECT conversation_id, min(created_at) AS at FROM project_messages GROUP BY conversation_id) f
    WHERE c.id = f.conversation_id AND c.workspace_id = $1`, [state.workspaceId]);
  const { rows } = await pool.query<{ n: number; stale: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE abs(extract(epoch FROM (sd.at - m.created_at))) > 1)::int AS stale
    FROM project_messages m JOIN search_documents sd ON sd.doc_key = 'message:' || m.id::text WHERE m.workspace_id = $1`, [state.workspaceId]);
  console.log(`indexed messages ${rows[0]!.n}, index time differs from the message's on ${rows[0]!.stale}`);
  state.seededSeconds = Math.round((Date.now() - started) / 1000);
  await save(state);
  console.log(`SEEDED people=${seed.people.length} spaces=${seed.spaces.length} messages=${dated.length} docs=${seed.docs.length} tasks=${seed.tasks.length} decisions=${seed.decisions.length} maps=${seed.maps.length} files=${Object.keys(seed.files).length} seconds=${state.seededSeconds}`);
}

// --- Asking.

const proxy = async (path: string, body?: unknown) => {
  const response = await fetch(`${proxyUrl}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json() as Promise<Ledger>;
};
interface Turn { n: number; status: number; ms: number; firstByteMs: number | null; stopReason: string | null; costUsd: number; calls: { name: string; input: Record<string, unknown> }[];
  usage: { input_tokens?: number; output_tokens?: number } | null; text: string }
interface Ledger { spentUsd: number; capUsd: number; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; modelMs: number;
  refused: number; models: string[]; turns: Turn[] }

/** What the tools gave the model in one question's requests: the tool results of its last request, which carries the whole run. */
async function toolResultsOf(tag: string): Promise<string> {
  const dir = `${evidence}/proxy/requests`;
  const files = (await readdir(dir)).filter((name) => name.endsWith(`-${tag}.json`)).sort();
  const last = files.at(-1);
  if (!last) return '';
  const body = JSON.parse(await readFile(`${dir}/${last}`, 'utf8')) as { messages?: { content: unknown }[] };
  const out: string[] = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type: string; content?: unknown }[]) {
      if (block.type !== 'tool_result') continue;
      out.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
    }
  }
  return out.join('\n');
}

interface RunRow { status: string; end_reason: string | null; answer_body: string | null; answer_sources: { type: string; id: string }[]; input_tokens: number | null;
  output_tokens: number | null; charged_micros: number; run_tools: string[]; engine: string; model: string; created_at: Date; completed_at: Date | null }

async function askOne(q: Question, state: State, seed: Seed) {
  const ada = await as(seed.people.find((someone) => someone.role === 'owner')!.key);
  await proxy('/__eval/tag', { tag: q.id });
  let agentId = state.firstAgentId!;
  const started = Date.now();
  let run: AssistantRun;
  if (q.ask === 'chat') {
    // A fresh agent for each question: a private chat tells the agent its last exchanges, which would leak earlier answers.
    agentId = (expectStatus(await ada.browser.request('POST', MY_AGENTS_PATH, { body: { name: `Fieldbot ${q.id}`, workspaceId: state.workspaceId, connection: state.connectionId, model: MODEL } }), 201, 'agent') as { id: string }).id;
    run = expectStatus(await ada.browser.request('POST', agentAssistantRunsPath(agentId), { body: { clientRunId: randomUUID(), kind: 'ask', prompt: q.question } }), 202, 'ask') as AssistantRun;
  } else {
    run = expectStatus(await ada.browser.request('POST', conversationAssistantRunsPath(state.conversations[q.ask]!), { body: { clientRunId: randomUUID(), kind: 'ask', prompt: q.question } }), 202, '/ai') as AssistantRun;
  }
  const ended = await until('the run to end', async () => expectStatus(await ada.browser.request('GET', assistantRunPath(run.id)), 200) as AssistantRun,
    (current) => !['queued', 'reading', 'dispatching'].includes(current.status), RUN_WAIT_SECONDS);
  const seconds = (Date.now() - started) / 1000;
  const row = (await pool.query<RunRow>(`SELECT status, end_reason, answer_body, answer_sources, input_tokens, output_tokens, charged_micros, run_tools, engine, model,
    created_at, completed_at FROM personal_runs WHERE id = $1`, [run.id])).rows[0]!;
  const ledger = await proxy(`/__eval/ledger?tag=${encodeURIComponent(q.id)}`);
  const results = await toolResultsOf(q.id);
  const answer = row.answer_body ?? '';
  const calls = ledger.turns.flatMap((turn) => turn.calls);
  const gold = q.gold.map((key) => ({ key, source: state.sources[key] })).filter((item): item is { key: string; source: Source } => !!item.source);
  const snippet = (text: string) => fold(text).replace(/[*_`]/g, '').slice(0, 36);
  const foldedResults = fold(results).replace(/\*\*/g, '');
  const retrieved = gold.filter(({ source }) => results.includes(source.id) || foldedResults.includes(snippet(source.text)));
  const cites = {
    sources: (row.answer_sources ?? []).map((ref) => ref.id),
    wiki: [...answer.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]!),
    tasks: [...answer.matchAll(/(?:^|\s)#(\d+)\b/g)].map((match) => Number(match[1])),
    links: [...answer.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]),
  };
  const citedAny = cites.sources.length + cites.wiki.length + cites.tasks.length + cites.links.length > 0;
  const citedGold = gold.filter(({ source }) => cites.sources.includes(source.id) || cites.links.some((link) => link.includes(source.id))
    || (source.kind === 'doc' && cites.wiki.some((title) => fold(title) === fold(source.title ?? '')))
    || (source.kind === 'task' && cites.tasks.includes(source.number ?? -1))).map(({ key }) => key);
  // A source named in the answer's words (a Wiki page, task, decision, map or file by its title), where Flux gives it no link.
  const namedGold = gold.filter(({ source }) => source.kind !== 'message' && source.title && fold(answer).includes(fold(source.title).slice(0, 40))).map(({ key }) => key);
  const record = {
    id: q.id, category: q.category, lang: q.lang, ask: q.ask, question: q.question, reference: q.answer, refuse: q.refuse === true, dates: q.dates === true,
    gold: q.gold, goldInWindow: q.goldInWindow, runId: run.id, agentId, status: ended.status, endReason: row.end_reason, engine: row.engine, model: row.model,
    answer, seconds, runTools: row.run_tools,
    keysMatched: q.keys.length ? q.keys.every((pattern) => new RegExp(pattern, 'i').test(fold(answer))) : null,
    calls: calls.map((call) => ({ name: call.name, input: call.input })),
    usedDateFilter: calls.some((call) => (call.name === 'flux_search' && (call.input?.after || call.input?.before)) || call.name === 'flux_summarize' || call.name === 'flux_changes_since'),
    retrievedGold: retrieved.map(({ key }) => key), citedAny, citedGold, namedGold, cites,
    // The reference's own values reached the model through a tool: for a file, this is whether its contents did, not only its name.
    answerInResults: q.keys.length ? q.keys.every((pattern) => new RegExp(pattern, 'i').test(foldedResults)) : null,
    usage: { requests: ledger.requests, inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, costUsd: ledger.costUsd,
      modelSeconds: ledger.modelMs / 1000, refusedByCap: ledger.refused, fluxInputTokens: row.input_tokens, fluxOutputTokens: row.output_tokens, fluxChargedMicros: row.charged_micros },
    turns: ledger.turns.map((turn) => ({ status: turn.status, ms: turn.ms, firstByteMs: turn.firstByteMs, stopReason: turn.stopReason, usage: turn.usage, calls: turn.calls.map((call) => call.name) })),
  };
  await writeFile(`${evidence}/answers/${q.id}.json`, JSON.stringify(record, null, 1));
  console.log(`ASKED ${q.id} ${q.category} status=${record.status} keys=${record.keysMatched} tools=${record.calls.map((call) => call.name).join(',') || '-'} `
    + `in=${record.usage.inputTokens} out=${record.usage.outputTokens} $${record.usage.costUsd.toFixed(4)} ${seconds.toFixed(1)}s`);
  return record;
}

function selected(seed: Seed): Question[] {
  const wanted = (process.env.FLUX_EVAL_QUESTIONS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return wanted.length ? seed.questions.filter((q) => wanted.includes(q.id) || wanted.includes(q.category)) : seed.questions;
}

// --- Judging: a fixed rubric, the cheap model, low effort (temperature cannot be set on API version 2026-10-21).

const RUBRIC = `You grade an AI agent's answer to a question a person asked about their company's workspace (Polish and English). You get the question, a
reference answer written by the person who planted the facts, and the agent's answer. Grade only whether the answer gives the reference's facts; ignore
style, length, language and links.

Verdicts:
- "correct": the answer states the reference's key facts (numbers, names, dates, the thing asked) and contradicts none of them. Extra true detail is fine.
- "partial": it gives part of what the reference requires (one of two asked facts, or two of three events where the reference asks for at least two counts as correct), or it hedges between the right value and a wrong one.
- "wrong": it states a different value, takes the fact from the wrong date or source (an older or newer message on the same topic), or answers another question.
- "dont_know": it says it could not find the answer or does not know, without stating a value.

When the reference says the workspace does not answer the question: "correct" if the agent says it could not find it or does not know (it may say where it looked or
suggest who to ask); "wrong" if it states a value as the answer; "partial" if it offers a guess while saying it is unsure.

Reply with JSON only: {"verdict": "correct" | "partial" | "wrong" | "dont_know", "reason": "<one sentence>"}.`;
const SCORE: Record<string, number> = { correct: 1, partial: 0.5, wrong: 0, dont_know: 0 };

async function judgeAll(seed: Seed) {
  const key = process.env.FLUX_EVAL_ANTHROPIC_KEY;
  assert.ok(key, 'FLUX_EVAL_ANTHROPIC_KEY is needed to judge');
  const require = createRequire(new URL('../../packages/agent-runtime/package.json', import.meta.url));
  const { default: Anthropic } = await import(require.resolve('@anthropic-ai/sdk')) as { default: new (options: Record<string, unknown>) => {
    messages: { create(params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[]; stop_reason: string }> } } };
  const client = new Anthropic({ apiKey: key, baseURL: proxyUrl, maxRetries: 2, timeout: 120_000 });
  await mkdir(`${evidence}/judged`, { recursive: true });
  for (const q of selected(seed)) {
    const answered = JSON.parse(await readFile(`${evidence}/answers/${q.id}.json`, 'utf8').catch(() => 'null')) as { answer: string; status: string } | null;
    if (!answered) continue;
    await proxy('/__eval/tag', { tag: `judge:${q.id}` });
    let verdict = { verdict: 'wrong', reason: 'no answer' };
    if (answered.answer.trim()) {
      const message = await client.messages.create({
        model: JUDGE_MODEL, max_tokens: 1_000, system: RUBRIC, output_config: { effort: 'low', format: { type: 'json_schema', schema: {
          type: 'object', additionalProperties: false, required: ['verdict', 'reason'],
          properties: { verdict: { type: 'string', enum: ['correct', 'partial', 'wrong', 'dont_know'] }, reason: { type: 'string' } } } } },
        messages: [{ role: 'user', content: `<question>${q.question}</question>\n<reference>${q.answer}</reference>\n<answer>${answered.answer}</answer>` }],
      });
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
      try { verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as typeof verdict; } catch { verdict = { verdict: 'wrong', reason: `unreadable verdict: ${text.slice(0, 200)}` }; }
    }
    const ledger = await proxy(`/__eval/ledger?tag=${encodeURIComponent(`judge:${q.id}`)}`);
    await writeFile(`${evidence}/judged/${q.id}.json`, JSON.stringify({ ...verdict, score: SCORE[verdict.verdict] ?? 0, costUsd: ledger.costUsd }, null, 1));
    console.log(`JUDGED ${q.id} ${verdict.verdict}: ${verdict.reason}`);
  }
}

// --- The report: per question, per category, overall.

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
const round = (value: number | null, digits = 3) => (value === null ? null : Number(value.toFixed(digits)));

async function report(seed: Seed) {
  const rows: Record<string, unknown>[] = [];
  for (const q of selected(seed)) {
    const answered = JSON.parse(await readFile(`${evidence}/answers/${q.id}.json`, 'utf8').catch(() => 'null')) as Record<string, unknown> | null;
    const judged = JSON.parse(await readFile(`${evidence}/judged/${q.id}.json`, 'utf8').catch(() => 'null')) as { verdict: string; reason: string; score: number; costUsd: number } | null;
    if (answered) rows.push({ ...answered, judge: judged });
  }
  type Row = { id: string; category: string; refuse: boolean; dates: boolean; status: string; keysMatched: boolean | null; judge: { verdict: string; score: number; costUsd: number } | null;
    citedAny: boolean; citedGold: string[]; namedGold: string[]; retrievedGold: string[]; answerInResults: boolean | null; gold: string[]; usedDateFilter: boolean; seconds: number; calls: { name: string }[];
    usage: { inputTokens: number; outputTokens: number; costUsd: number; requests: number } };
  const all = rows as unknown as Row[];
  const summarize = (of: Row[]) => {
    const answerable = of.filter((row) => !row.refuse);
    const seconds = of.map((row) => row.seconds).sort((a, b) => a - b);
    const tools: Record<string, number> = {};
    for (const row of of) for (const call of row.calls) tools[call.name] = (tools[call.name] ?? 0) + 1;
    return {
      questions: of.length,
      accuracy: round(mean(of.map((row) => row.judge?.score ?? 0))),
      correct: of.filter((row) => row.judge?.verdict === 'correct').length, partial: of.filter((row) => row.judge?.verdict === 'partial').length,
      wrong: of.filter((row) => row.judge?.verdict === 'wrong').length, dontKnow: of.filter((row) => row.judge?.verdict === 'dont_know').length,
      keysMatched: round(mean(of.filter((row) => row.keysMatched !== null).map((row) => (row.keysMatched ? 1 : 0)))),
      falseDontKnow: round(mean(answerable.map((row) => (row.judge?.verdict === 'dont_know' ? 1 : 0)))),
      citedAny: round(mean(answerable.map((row) => (row.citedAny ? 1 : 0)))),
      citedGold: round(mean(answerable.map((row) => (row.citedGold.length ? 1 : 0)))),
      citedOrNamedGold: round(mean(answerable.map((row) => (row.citedGold.length || row.namedGold.length ? 1 : 0)))),
      retrievedGold: round(mean(answerable.map((row) => (row.retrievedGold.length ? 1 : 0)))),
      answerInResults: round(mean(of.filter((row) => row.answerInResults !== null).map((row) => (row.answerInResults ? 1 : 0)))),
      usedDateFilter: round(mean(of.filter((row) => row.dates).map((row) => (row.usedDateFilter ? 1 : 0)))),
      failedRuns: of.filter((row) => row.status !== 'completed').length,
      inputTokensPerQuestion: round(mean(of.map((row) => row.usage.inputTokens)), 0), outputTokensPerQuestion: round(mean(of.map((row) => row.usage.outputTokens)), 0),
      requestsPerQuestion: round(mean(of.map((row) => row.usage.requests)), 2),
      costUsd: round(of.reduce((sum, row) => sum + row.usage.costUsd, 0), 4), costUsdPerQuestion: round(mean(of.map((row) => row.usage.costUsd)), 5),
      secondsP50: round(pct(seconds, 0.5), 1), secondsP95: round(pct(seconds, 0.95), 1), tools,
    };
  };
  const categories = [...new Set(seed.questions.map((q) => q.category))];
  const byCategory = Object.fromEntries(categories.map((category) => [category, summarize(all.filter((row) => row.category === category))]).filter(([, value]) => (value as { questions: number }).questions));
  const judgeUsd = all.reduce((sum, row) => sum + (row.judge?.costUsd ?? 0), 0);
  const meta = {
    issue: 1295, label: process.env.FLUX_EVAL_LABEL ?? null, sha: process.env.FLUX_EVAL_SHA ?? null, productSha: process.env.FLUX_EVAL_PRODUCT_SHA ?? null, date: new Date().toISOString(), seedToday: seed.today, shiftDays: seed.shiftDays,
    model: MODEL, judgeModel: JUDGE_MODEL, engine: 'server (API key)', webSearch: process.env.FLUX_WEB_READS ?? 'off', window: seed.window,
    connectDefault: (await load()).connectDefault ?? null,
    spend: { agentUsd: round(all.reduce((sum, row) => sum + row.usage.costUsd, 0), 4), judgeUsd: round(judgeUsd, 4) },
  };
  const results = { meta, overall: summarize(all), byCategory, questions: rows };
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 1));
  const lines = [`# Answer accuracy (#1295): ${MODEL}${meta.label ? `, ${meta.label}` : ''}`, '',
    `Flux ${meta.productSha ?? '?'} (main; harness ${meta.sha ?? '?'}) · ${meta.date.slice(0, 10)} · ${all.length} questions · judge ${JUDGE_MODEL} · web search ${meta.webSearch} · spend $${meta.spend.agentUsd} agent + $${meta.spend.judgeUsd} judge`, '',
    '| Category | n | Accuracy | Correct / partial / wrong / don\'t know | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const line = (name: string, s: ReturnType<typeof summarize>) => lines.push(`| ${name} | ${s.questions} | ${s.accuracy} | ${s.correct} / ${s.partial} / ${s.wrong} / ${s.dontKnow} | ${s.keysMatched ?? '-'} | `
    + `${s.retrievedGold ?? '-'} | ${s.answerInResults ?? '-'} | ${s.citedGold ?? '-'} (${s.citedOrNamedGold ?? '-'}) | ${s.usedDateFilter ?? '-'} | ${s.inputTokensPerQuestion} | ${s.outputTokensPerQuestion} | ${s.costUsdPerQuestion} | ${s.secondsP50} / ${s.secondsP95} |`);
  for (const [name, s] of Object.entries(byCategory)) line(name, s as ReturnType<typeof summarize>);
  line('**all**', results.overall);
  lines.push('', '| Question | Category | Verdict | Keys | Tools | Answer (start) |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of rows as (Row & { answer: string })[]) {
    lines.push(`| ${row.id} | ${row.category} | ${row.judge?.verdict ?? '-'} | ${row.keysMatched ?? '-'} | ${row.calls.map((call) => call.name.replace('flux_', '')).join(' ') || '-'} | `
      + `${row.answer.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 110)} |`);
  }
  await writeFile(`${evidence}/results.md`, `${lines.join('\n')}\n`);
  console.log(lines.slice(0, 6 + Object.keys(byCategory).length).join('\n'));
  console.log(`RESULT accuracy=${results.overall.accuracy} questions=${all.length} agentUsd=${meta.spend.agentUsd} judgeUsd=${meta.spend.judgeUsd}`);
}

// --- Steps.

const steps: Record<string, () => Promise<void>> = {
  async 'wait-ready'() {
    await until('the API', async () => (await fetch(`${process.env.FLUX_API_URL ?? 'http://api:8080'}/api/v1/health`).catch(() => null))?.status ?? 0, (status) => status === 200, 180);
    await until('the evaluation proxy', async () => (await fetch(`${proxyUrl}/__health`).catch(() => null))?.status ?? 0, (status) => status === 200, 60);
    console.log('READY');
  },

  seed: seedAll,

  /** Ada saves her API key through Connect AI (Flux seals it), and her first agent moves to the evaluated model. */
  async connect() {
    const key = process.env.FLUX_EVAL_ANTHROPIC_KEY;
    assert.ok(key, 'FLUX_EVAL_ANTHROPIC_KEY is needed to connect');
    const seed = await loadSeed();
    const ada = await as(seed.people.find((someone) => someone.role === 'owner')!.key);
    const response = await ada.browser.request('POST', backgroundComputeConnectionsPath, { body: { name: 'Anthropic', provider: 'anthropic', model: MODEL, apiKey: key,
      dailyBudgetCents: Number(process.env.FLUX_EVAL_DAILY_BUDGET_CENTS ?? '5000'), timeZone: 'UTC' } });
    // The provider's answer never echoes the key, but the body is not printed either.
    assert.equal(response.status, 201, `saving the key: ${response.status} ${(response.json as { code?: string } | null)?.code ?? ''}`);
    const connectionId = (response.json as { id: string }).id;
    const choice = await until('the key\'s models', async () => expectStatus(await ada.browser.request('GET', ASSISTANT_MODEL_PATH), 200) as AssistantModelChoice,
      (value) => value.groups.some((group) => JSON.stringify(group).includes(MODEL)), 120);
    const mine = await until('the first agent', async () => expectStatus(await ada.browser.request('GET', MY_AGENTS_PATH), 200) as MyAgentList, (list) => list.items.length > 0, 60);
    const first = mine.items.find((item) => item.answersAi) ?? mine.items[0]!;
    expectStatus(await ada.browser.request('PATCH', myAgentPath(first.id), { body: { connection: connectionId, model: MODEL } }), 200, 'the first agent\'s model');
    const state = await load();
    await save({ ...state, connectionId, firstAgentId: first.id, connectDefault: choice.default });
    console.log(`CONNECTED model=${MODEL} default=${JSON.stringify(choice.default)} models=${choice.groups.map((group) => JSON.stringify(group).match(/claude-[a-z0-9-]+/g)?.length ?? 0).join(',')}`);
  },

  async ask() {
    const seed = await loadSeed();
    const state = await load();
    await mkdir(`${evidence}/answers`, { recursive: true });
    for (const q of selected(seed)) {
      const done = await readFile(`${evidence}/answers/${q.id}.json`, 'utf8').catch(() => null);
      if (done) continue;
      const total = await proxy('/__eval/ledger');
      if (total.spentUsd >= total.capUsd * 0.97) { console.log(`STOP: spent $${total.spentUsd.toFixed(4)} of the run's cap $${total.capUsd}`); break; }
      try { await askOne(q, state, seed); } catch (error) {
        console.log(`FAILED ${q.id}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      }
    }
  },

  async judge() { await judgeAll(await loadSeed()); },
  async report() { await report(await loadSeed()); },
};

const [name] = process.argv.slice(2);
try {
  const step = steps[name ?? ''];
  if (!step) throw new Error(`unknown step ${name}; steps: ${Object.keys(steps).join(', ')}`);
  await step();
} finally {
  await pool.end();
}
