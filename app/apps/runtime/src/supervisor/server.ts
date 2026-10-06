import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CONSOLE_UPGRADE_ANSWER, encodeFrame, isConsoleUpgrade, parseSupervisorRequest, refuseUpgrade, REQUEST_LIMITS, type SupervisorError, type SupervisorFrame } from '@flux/runtime-protocol';
import { authorized } from '../shared/auth.js';
import { serveConsole } from './console.js';
import { handle, slotReport, type SupervisorConfig } from './handlers.js';

// The supervisor's listener on its slot network (port 7700). It answers only the manager: a POST to
// `/v1/<request>` with the slot's own secret and a JSON body of at most 64 KiB, checked against the
// closed set before anything runs. Requests run one at a time in a single lane (F-022 "Caps": sign-in,
// status, run and sign-out never overlap), except the read-only slot report and stop. The sign-in
// console (T4) is the one upgrade it accepts: `GET /v1/login` to `flux-console/1`, same secret.

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
  /** Runs `task` only if nothing else is in the lane or waiting for it (the sign-in console). */
  tryRun(task: () => Promise<void>): Promise<void> | null {
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

export interface SupervisorServer { server: Server; lane: Lane }

/**
 * `onReleased` runs once a release that confirmed an empty `/data` has been answered: in a slot it
 * ends the process, so the restart policy starts a fresh supervisor with a new boot id and an empty
 * tmpfs `/tmp` (F-022 "Stop, sign-out and removal").
 */
export function createSupervisorServer(config: SupervisorConfig, onReleased: () => void): SupervisorServer {
  const lane = new Lane();
  // Open sign-in consoles; a release ends them first, so it never waits for a console's 15 minutes.
  const consoles = new Set<() => void>();
  let closing = false;
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
    if (closing) { refuse(409, 'busy'); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', connection: 'close' });
    const send = (frame: SupervisorFrame) => { if (!res.writableEnded) res.write(encodeFrame(frame)); };
    send({ t: 'accepted', kind: request.kind, bootId: config.bootId });
    const work = async () => {
      try {
        if (request.kind === 'status' && !request.client) return { result: await slotReport(config, lane.busy) };
        return await handle(config, request, send);
      } catch {
        return { error: 'internal' as const };
      }
    };
    const lanePass = request.kind === 'stop' || (request.kind === 'status' && !request.client);
    const running = lanePass ? work() : lane.run(work);
    if (!running) { send({ t: 'error', code: 'busy' }); res.end(); return; }
    if (request.kind === 'release') { closing = true; for (const end of consoles) end(); }
    const outcome = await running;
    if ('error' in outcome) {
      send({ t: 'error', code: outcome.error });
      if (request.kind === 'release') closing = false;
      res.end();
      return;
    }
    send({ t: 'result', result: outcome.result });
    const exiting = outcome.result.kind === 'release' && outcome.result.exiting;
    if (request.kind === 'release' && !exiting) closing = false;
    res.end(() => { if (exiting) onReleased(); });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!authorized(req.headers.authorization, config.secret)) { refuseUpgrade(socket, 401, 'Unauthorized'); return; }
    if (req.method !== 'GET' || req.url !== '/v1/login' || !isConsoleUpgrade(req.headers)) { refuseUpgrade(socket, 404, 'Not Found'); return; }
    if (closing) { refuseUpgrade(socket, 409, 'Conflict'); return; }
    socket.write(CONSOLE_UPGRADE_ANSWER);
    serveConsole(config, lane, socket, head, consoles);
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  return { server, lane };
}
