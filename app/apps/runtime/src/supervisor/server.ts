import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CONSOLE_UPGRADE_ANSWER, encodeFrame, isConsoleUpgrade, parseSupervisorRequest, refuseUpgrade, REQUEST_LIMITS, type SupervisorError, type SupervisorFrame } from '@flux/runtime-protocol';
import { authorized } from '../shared/auth.js';
import { serveConsole } from './console.js';
import { handle, slotReport, type SupervisorConfig } from './handlers.js';
import { stopPersonRuns } from './run.js';

// The supervisor's listener on its own network (port 7700). It answers only the manager: a POST to
// `/v1/<request>` with its own secret and a JSON body of at most 64 KiB, checked against the closed set
// before anything runs. Each person's requests run one at a time in their own lane (F-022 "Caps": sign-in,
// status, run and sign-out never overlap), except stop and the read-only report, and one person's lane never
// waits for another's (#860). The sign-in console (T4) is the one upgrade it accepts: `GET /v1/login` to
// `flux-console/1`, same secret.

/** A single serial lane with a short queue; a full queue answers `busy`. */
export class Lane {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly maxPending = 4) {}
  get busy() { return this.pending > 0; }
  run<T>(task: () => Promise<T>): Promise<T> | null {
    if (this.pending >= this.maxPending) return null;
    this.pending += 1;
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined).then(() => { this.pending -= 1; });
    return result;
  }
  /** Runs `task` only if nothing else is in the lane or waiting for it (the sign-in console, a run). */
  tryRun<T>(task: () => Promise<T>): Promise<T> | null {
    return this.pending > 0 ? null : this.run(task);
  }
}

function answer(res: ServerResponse, status: number, frames: SupervisorFrame[]) {
  res.writeHead(status, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', connection: 'close' });
  res.end(frames.map(encodeFrame).join(''));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > limit) { resolve(null); return; }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts, size)));
    req.on('error', () => resolve(null));
  });
}

export interface SupervisorServer { server: Server }

export function createSupervisorServer(config: SupervisorConfig): SupervisorServer {
  const lanes = new Map<string, Lane>();
  const laneOf = (bindingId: string) => {
    let lane = lanes.get(bindingId);
    if (!lane) { lane = new Lane(); lanes.set(bindingId, lane); }
    return lane;
  };
  // A new person's user id is the lowest free one: two people never get it at once.
  const binds = new Lane(256);
  // Open sign-in consoles of each person; a release ends theirs first, so it never waits for a console's 15 minutes.
  const consoles = new Map<string, Set<() => void>>();
  const closing = new Set<string>();
  const host = {
    laneOf,
    removing: (bindingId: string) => closing.has(bindingId),
    opened(bindingId: string, end: () => void) {
      const open = consoles.get(bindingId) ?? new Set();
      consoles.set(bindingId, open.add(end));
      return () => { open.delete(end); if (!open.size) consoles.delete(bindingId); };
    },
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const refuse = (status: number, code: SupervisorError) => answer(res, status, [{ t: 'error', code }]);
    if (!authorized(req.headers.authorization, config.secret)) { refuse(401, 'unauthorized'); req.destroy(); return; }
    const route = /^\/v1\/([a-z]{1,16})$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !route) { refuse(404, 'unknown_request'); return; }
    if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) { refuse(400, 'invalid_request'); return; }
    const body = await readBody(req, REQUEST_LIMITS.bodyBytes);
    if (!body) { refuse(400, 'invalid_request'); return; }
    let value: unknown;
    try { value = JSON.parse(body.toString('utf8')); } catch { refuse(400, 'invalid_request'); return; }
    const parsed = parseSupervisorRequest(route[1], value);
    if (!parsed.ok) { refuse(parsed.code === 'unknown_request' ? 404 : 400, parsed.code); return; }
    const request = parsed.request;
    const person = 'bindingId' in request ? request.bindingId : undefined;
    const removing = () => person !== undefined && closing.has(person);
    if (removing()) { refuse(409, 'busy'); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', connection: 'close' });
    const send = (frame: SupervisorFrame) => { if (!res.writableEnded) res.write(encodeFrame(frame)); };
    send({ t: 'accepted', kind: request.kind, bootId: config.bootId });
    const work = async () => {
      try {
        if (request.kind === 'status' && !request.client) return { result: await slotReport(config) };
        // Recheck after queue wait. A delayed auth command may not target a new
        // supervisor process, even if a stale API still knows its old binding.
        if ((request.kind === 'logout' || (request.kind === 'status' && request.client)) && request.bootId !== config.bootId) {
          return { error: 'invalid_request' as const };
        }
        if (removing() && request.kind !== 'release') return { error: 'busy' as const };
        return await handle(config, request, send);
      } catch {
        return { error: 'internal' as const };
      }
    };
    const lanePass = request.kind === 'stop' || person === undefined;
    // A run never waits behind a sign-in, a status check or another run of theirs: the answer is `busy` (F-022 "Caps").
    const running = lanePass ? work() : request.kind === 'bind' ? binds.run(() => laneOf(person).run(work) ?? Promise.resolve({ error: 'busy' as const }))
      : request.kind === 'run' ? laneOf(person).tryRun(work) : laneOf(person).run(work);
    if (!running) { send({ t: 'error', code: 'busy' }); res.end(); return; }
    let stopping: NodeJS.Timeout | undefined;
    if (request.kind === 'release') {
      closing.add(person!);
      for (const end of consoles.get(person!) ?? []) end();
      // A release does not wait out a run. It asks again until its turn comes: a run may still be starting its CLI.
      stopPersonRuns(config, person!);
      stopping = setInterval(() => stopPersonRuns(config, person!), 1_000);
    }
    const outcome = await running;
    if (request.kind === 'release') {
      clearInterval(stopping);
      closing.delete(person!);
      if ('result' in outcome && outcome.result.kind === 'release' && outcome.result.deleted) lanes.delete(person!);
    }
    send('error' in outcome ? { t: 'error', code: outcome.error } : { t: 'result', result: outcome.result });
    res.end();
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!authorized(req.headers.authorization, config.secret)) { refuseUpgrade(socket, 401, 'Unauthorized'); return; }
    if (req.method !== 'GET' || req.url !== '/v1/login' || !isConsoleUpgrade(req.headers)) { refuseUpgrade(socket, 404, 'Not Found'); return; }
    socket.write(CONSOLE_UPGRADE_ANSWER);
    serveConsole(config, host, socket, head);
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  return { server };
}
