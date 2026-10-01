/** Explicit local performance experiment, never part of the lightweight PR suite.
 * Real Better Auth, policy, SQL, LISTEN/NOTIFY and production typing route.
 * Driver and instrumented API share one monotonic clock/process; RSS is combined.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Fastify, { type FastifyPluginAsync } from 'fastify';
// Resolve the existing server dependency; do not add another plugin/version.
const websocket = createRequire(new URL('../../apps/server/package.json', import.meta.url))('@fastify/websocket') as FastifyPluginAsync<{ options: { maxPayload: number } }>;
import WebSocket from 'ws';
import { createDatabase } from '@flux/db';
import type { Conversation, TypingSnapshot } from '@flux/contracts';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { typingRoutes } from '../../apps/server/src/typing/routes.js';
import type { TypingHub } from '../../apps/server/src/typing/hub.js';
import { TypingDiagnostics } from '../../apps/server/src/typing/diagnostics.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from './support/people.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const connectionString = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(connectionString);
const origin = 'http://127.0.0.1:19555';
const app = Fastify();
const actors: Person[] = [];
const sockets: Client[] = [];
const activeAt = new Map<string, number>();
const publications = new Map<string, number>();
const muted = new Set<string>();
const clock = () => performance.now();
let phase = 'bootstrap'; let failure: string | null = null; let keepalive: ReturnType<typeof setInterval> | undefined;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let work: () => TypingHub['work'] & { admissions: number; humans: number } = () => ({ contexts: 0, entries: 0, watermarks: 0, sockets: 0, pendingBroker: 0, pumping: false, admissions: 0, humans: 0 });
const diagnostics = new TypingDiagnostics((pulse, at) => {
  publications.set(`${pulse.actorId}:${pulse.active}`, at);
  if (pulse.active) activeAt.set(pulse.actorId, at);
});
const memory: { atMs: number; rss: number; heapUsed: number; work: ReturnType<typeof work> }[] = [];
const samples: { inputToReceiptMs: number; acceptedToReceiptMs: number; stopToReceiptMs: number }[] = [];
let warmups = 0; let measuredStarted = 0; let measuredElapsed = 0;
let countDurable: (() => Promise<Record<string, string>>) | undefined;
let durableBefore: Record<string, string> | undefined;
let durableAfter: Record<string, string> | undefined;
let durableCheckFailure: string | null = null;

class Client {
  socket!: WebSocket;
  current: TypingSnapshot | null = null;
  receivedAt = 0;
  frames = 0;
  bytes = 0;
  closedCode: number | null = null;
  identity = false;
  probe: { actorId: string; since: number; firstAt: number | null } | null = null;
  constructor(readonly actor: Person, readonly browser: Browser) {}
  async connect(contextId: string) {
    const socket = this.socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/v1/typing`, { headers: { origin, cookie: this.browser.cookieHeader() } });
    socket.on('message', (data) => {
      this.frames++; this.bytes += Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
      const frame = JSON.parse(String(data));
      if (frame.type === 'identity') {
        assert.deepEqual(frame, { type: 'identity', id: this.actor.id }); this.identity = true;
      } else {
        assert.equal(frame.type, 'snapshot'); assert.equal(frame.context.id, contextId);
        assert.equal(frame.people.some((human: { id: string }) => human.id === this.actor.id), false);
        this.current = frame; this.receivedAt = clock();
        if (this.probe && this.probe.firstAt === null && this.receivedAt >= this.probe.since && this.has(this.probe.actorId)) this.probe.firstAt = this.receivedAt;
      }
    });
    socket.on('close', (code) => { this.closedCode = code; });
    socket.on('error', () => { failure ??= 'socket transport error'; });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('unexpected-response', (_request, response) => { response.resume(); reject(new Error(`typing upgrade refused: ${response.statusCode}`)); socket.terminate(); });
      socket.once('error', reject);
    });
    await until(() => this.identity, 'native identity acknowledgement');
    socket.send(JSON.stringify({ type: 'watch', context: { kind: 'conversation', id: contextId } }));
    await until(() => this.current?.availability === 'ready', 'initial native watch');
  }
  send(active: boolean) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('publisher transport closed');
    this.socket.send(JSON.stringify({ type: 'active', active }));
  }
  has(id: string) { return this.current?.availability === 'ready' && this.current.people.some((human) => human.id === id); }
}

async function until(check: () => boolean, label: string, timeout = 6000) {
  const end = clock() + timeout;
  while (!check()) {
    if (failure || sockets.some((socket) => socket.closedCode !== null)) throw new Error(`${label}: transport did not sustain the workload`);
    if (clock() > end) throw new Error(`${label}: timeout`);
    await sleep(10);
  }
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
  return { count: sorted.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) };
}

try {
  // Public native API creates every actor/role/resource; no fixture identity port.
  for (let offset = 0; offset < 32; offset += 2) actors.push(...await Promise.all([offset, offset + 1].map((index) => person(`typing-stress-${index + 1}`))));
  const owner = actors[0]!;
  const space = await workspace(owner, 'Typing stress library');
  const room = await project(owner, space.id, 'Low-light reading corner', 'restricted');
  for (const actor of actors.slice(1)) { await addMember(owner, space.id, actor, 'member'); await grant(owner, room.id, actor, 'contributor'); }
  const native = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${room.id}/conversations`, { body: { body: 'Which sensor keeps the reading corner quiet in low light?', clientMessageId: randomUUID() } }), 201) as Conversation;
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM project_messages WHERE workspace_id=$1) AS messages,
    (SELECT count(*) FROM events WHERE workspace_id=$1) AS events,
    (SELECT count(*) FROM notifications WHERE workspace_id=$1) AS notifications,
    (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.workspace_id=$1) AS outbox,
    (SELECT count(*) FROM event_audience a JOIN events e ON e.id=a.event_id WHERE e.workspace_id=$1) AS audience`, [space.id])).rows[0] as Record<string, string>;
  countDurable = counts;
  await sleep(2000); const baseline = durableBefore = await counts();
  const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: origin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(typingRoutes, { db, sessions: identity, publicOrigin: origin, connectionString, diagnostics, inspectWork: (read) => { work = read; } });
  await app.listen({ host: '127.0.0.1', port: 19555 });
  for (const actor of actors) {
    const browser = new Browser(origin, origin);
    expectStatus(await browser.request('POST', '/api/auth/sign-in/email', { body: { email: actor.email, password } }), 200);
    assert.equal((expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } }).user.id, actor.id);
    // Four actual sockets per person: one publisher plus three additional watchers.
    for (let tab = 0; tab < 4; tab++) { const client = new Client(actor, browser); sockets.push(client); await client.connect(native.id); }
  }
  assert.equal(work().sockets, 128); assert.equal(work().admissions, 128);
  const watchFrameStart = sockets.map((client) => client.frames);
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    memory.push({ atMs: clock(), rss: usage.rss, heapUsed: usage.heapUsed, work: work() });
    // This experiment has a fixed finite duration and at most230 samples.
    if (memory.length > 512) memory.shift();
  };
  sampleMemory(); sampleTimer = setInterval(sampleMemory, 1000);
  const publishers = actors.map((actor) => sockets.find((socket) => socket.actor.id === actor.id)!);
  for (const publisher of publishers) publisher.send(true);
  keepalive = setInterval(() => {
    for (const publisher of publishers) {
      if (!muted.has(publisher.actor.id) && clock() - (activeAt.get(publisher.actor.id) ?? 0) >= 1400) {
        try { publisher.send(true); } catch { failure ??= 'publisher closed under steady load'; }
      }
    }
  }, 1500);
  phase = 'dense-initial-publication';
  await until(() => sockets.every((socket) => socket.current?.people.length === 31), '32 publishers visible to all128 recipients', 6000);

  async function sample(index: number) {
    const publisher = publishers[index % publishers.length]!;
    const actor = publisher.actor.id;
    const watchers = sockets.filter((socket, socketIndex) => socketIndex % 4 !== 0 && socket.actor.id !== actor);
    const receiver = watchers[index % watchers.length]!;
    muted.add(actor);
    try {
      const stopAt = clock(); publisher.send(false);
      await until(() => receiver.current?.availability === 'ready' && !receiver.has(actor) && receiver.receivedAt >= stopAt, 'fresh sampled stop', 2000);
      const stopMs = receiver.receivedAt - stopAt;
      // Avoid conflating the server's genuine1000ms active throttle with delivery.
      await sleep(Math.max(0, (activeAt.get(actor) ?? 0) + 1050 - clock()));
      const sentAt = clock(); receiver.probe = { actorId: actor, since: sentAt, firstAt: null }; publisher.send(true);
      await until(() => (publications.get(`${actor}:true`) ?? 0) >= sentAt, 'accepted native publication', 2000);
      const acceptedAt = publications.get(`${actor}:true`)!;
      await until(() => receiver.probe?.firstAt !== null, 'first fresh visible sampled activity', 2000);
      const receivedAt = receiver.probe!.firstAt!;
      // Receipt can precede the publish promise's completion microtask. Preserve
      // the signed difference explicitly rather than waiting for a later frame.
      return { inputToReceiptMs: receivedAt - sentAt, acceptedToReceiptMs: receivedAt - acceptedAt, stopToReceiptMs: stopMs };
    } finally { receiver.probe = null; muted.delete(actor); }
  }
  phase = 'warmup';
  for (let index = 0; index < 30; index++) { await sample(index); warmups++; }
  diagnostics.reset(); measuredStarted = clock(); phase = 'measured';
  for (let index = 0; index < 200; index++) {
    samples.push(await sample(index));
    // Sustained measurement must cover at least60s, without forcing rapid input.
    await sleep(Math.max(0, measuredStarted + (index + 1) * 300 - clock()));
  }
  measuredElapsed = clock() - measuredStarted;
  assert.ok(measuredElapsed >= 60_000); assert.equal(samples.length, 200);
  assert.ok(sockets.every((socket, index) => socket.frames > watchFrameStart[index]! && socket.socket.readyState === WebSocket.OPEN));
  assert.deepEqual(durableAfter = await counts(), baseline, 'ephemeral workload creates no durable native effects');
  const timings = diagnostics.snapshot().phases as Record<string, { p95UpperMs: number | null }>;
  assert.ok(timings.command?.p95UpperMs !== null && timings.command!.p95UpperMs! <= 150, 'actual server command handler p95<=150ms');
  assert.ok(distribution(samples.map((sample) => sample.acceptedToReceiptMs)).p95Ms! <= 1000, 'accepted publication to fresh receipt p95<=1000ms');
  assert.ok(work().sockets <= 128 && work().pendingBroker <= 4096 && work().watermarks <= 4096 && work().entries <= 512);
  phase = 'passed';
} catch (error) {
  failure ??= error instanceof Error ? error.message : 'experiment failed';
} finally {
  if (keepalive) clearInterval(keepalive);
  if (sampleTimer) clearInterval(sampleTimer);
  if (countDurable && !durableAfter) {
    try { durableAfter = await countDurable(); } catch { durableCheckFailure = 'final SQL counts unavailable'; }
  }
  const report = { timingDefinition: { inputToReceipt: 'driver send to first ready remote snapshot containing actor after observed stop', acceptedToReceipt: 'signed first receipt minus API publish-promise completion, same monotonic clock; may be negative', handler: 'command execution including authority and publication, queue reported separately' }, durable: { before: durableBefore ?? null, after: durableAfter ?? null, checkFailure: durableCheckFailure }, source: process.env.FLUX_GIT_COMMIT ?? 'record externally', phase, failure, runtime: { node: process.version, driver: 'ws8.22 real cookie sockets', browserDom: 'not measured in this experiment', memoryScope: 'in-process production route plus driver, not API-only RSS', cpuProfile: process.env.FLUX_STRESS_CPU_PROFILE ?? 'Docker development allocation' },
    dataset: { actors: actors.length, requestedSockets: 128, connectedSockets: sockets.length, publishers: 32, additionalWatchers: 96, warmups, requestedMeasured: 200, completedMeasured: samples.length, measuredElapsedMs: measuredElapsed || (measuredStarted ? clock() - measuredStarted : 0) },
    distributions: { inputToReceipt: distribution(samples.map((sample) => sample.inputToReceiptMs)), acceptedToReceipt: distribution(samples.map((sample) => sample.acceptedToReceiptMs)), stopToReceipt: distribution(samples.map((sample) => sample.stopToReceiptMs)) },
    api: diagnostics.snapshot(), work: work(), memory, transport: { frames: sockets.reduce((sum, socket) => sum + socket.frames, 0), bytes: sockets.reduce((sum, socket) => sum + socket.bytes, 0), closed: sockets.filter((socket) => socket.closedCode !== null).length, codes: Object.fromEntries([...new Set(sockets.map((socket) => socket.closedCode).filter((code) => code !== null))].map((code) => [code, sockets.filter((socket) => socket.closedCode === code).length])) } };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.FLUX_STRESS_REPORT) await writeFile(process.env.FLUX_STRESS_REPORT, JSON.stringify(report, null, 2) + '\n');
  for (const socket of sockets) socket.socket?.terminate();
  await app.close(); await pool.end();
}
if (failure) process.exitCode = 1;
