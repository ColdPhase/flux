import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { parseSupervisorFrame, type SupervisorFrame } from './frames.js';
import { managerConsolePath, MANAGER_ERRORS, type ManagerError } from './manager-api.js';
import { SLOT_NAME } from './names.js';
import { CONSOLE_SIZE } from './requests.js';
import { isPlainObject, literal, object, oneOf } from './shape.js';

// The sign-in console's stream (F-022 "Sign-in as in a terminal", T4 #279). The supervisor runs one
// login command of the closed set in a PTY; the console relays what the CLI prints and what the owner
// types, in memory only. API → manager → supervisor each open it with an HTTP upgrade to
// `flux-console/1`, authenticated as every other request (service secret, then slot secret), and then
// exchange binary frames: one type byte, a 4-byte big-endian length and the payload.
//
// Toward the supervisor: `open` (the login request, first and once), `input` (bytes for the CLI's
// prompt) and `resize`. From the supervisor: `control` (a closed supervisor frame, or the manager's
// relay error) and `output` (bytes the CLI printed). Every frame is size-bounded and checked; a
// malformed frame ends the console. Neither side logs a frame, and nothing parses `input` or `output`.

export const CONSOLE_PROTOCOL = 'flux-console/1';

export const CONSOLE_LIMITS = {
  /** F-022: the supervisor ends the PTY after 15 minutes (the lifetime of a Codex device code). */
  lifetimeMs: 15 * 60_000,
  /** The open frame must arrive this soon after the upgrade. */
  openWithinMs: 10_000,
  inputFrameBytes: 1024,
  outputFrameBytes: 16 * 1024,
  controlFrameBytes: 4 * 1024,
  /** Everything typed into one console (a sign-in needs a code of a few hundred bytes). */
  inputTotalBytes: 64 * 1024,
  /** Everything one console prints. */
  outputTotalBytes: 4 * 1024 * 1024,
} as const;

export const CONSOLE_FRAME = { open: 0x01, input: 0x02, resize: 0x03, control: 0x10, output: 0x11 } as const;

export type ToSupervisor =
  | { type: 'open'; body: Record<string, unknown> }
  | { type: 'input'; data: Buffer }
  | { type: 'resize'; cols: number; rows: number };

/** The manager's own refusal on the API's leg (the supervisor was unreachable, refused the secret, …). */
export interface RelayError { t: 'relay_error'; code: ManagerError }
export type ConsoleControl = SupervisorFrame | RelayError;

export type FromSupervisor = { type: 'control'; frame: ConsoleControl } | { type: 'output'; data: Buffer };

export const CONSOLE_STREAM_ERRORS = ['frame_too_large', 'unknown_frame', 'invalid_frame', 'input_too_large', 'output_too_large'] as const;
export type ConsoleStreamErrorCode = (typeof CONSOLE_STREAM_ERRORS)[number];

export class ConsoleStreamError extends Error {
  constructor(readonly code: ConsoleStreamErrorCode) {
    super(`Console stream refused: ${code}`);
    this.name = 'ConsoleStreamError';
  }
}

const HEADER = 5;

function frame(type: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(payload.length, 1);
  payload.copy(out, HEADER);
  return out;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

/** The login request's fields (without `kind`), checked by the receiver against the closed set. */
export const encodeOpen = (body: Record<string, unknown>) => frame(CONSOLE_FRAME.open, json(body));

/** Bytes for the CLI's prompt, split into frames of at most `inputFrameBytes`. */
export function encodeInput(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let start = 0; start < data.length; start += CONSOLE_LIMITS.inputFrameBytes) {
    parts.push(frame(CONSOLE_FRAME.input, data.subarray(start, start + CONSOLE_LIMITS.inputFrameBytes)));
  }
  return Buffer.concat(parts);
}

export function encodeResize(cols: number, rows: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16BE(cols, 0);
  payload.writeUInt16BE(rows, 2);
  return frame(CONSOLE_FRAME.resize, payload);
}

export const encodeControl = (value: ConsoleControl) => frame(CONSOLE_FRAME.control, json(value));

/** What the CLI printed, split into frames of at most `outputFrameBytes`. */
export function encodeOutput(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let start = 0; start < data.length; start += CONSOLE_LIMITS.outputFrameBytes) {
    parts.push(frame(CONSOLE_FRAME.output, data.subarray(start, start + CONSOLE_LIMITS.outputFrameBytes)));
  }
  return Buffer.concat(parts);
}

const sizeIn = (value: number, range: { min: number; max: number }) => Number.isInteger(value) && value >= range.min && value <= range.max;

function parseJson(payload: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { return undefined; }
}

const isRelayError = object({ t: literal('relay_error'), code: oneOf(MANAGER_ERRORS) });

/** A control frame: exactly a closed supervisor frame or the manager's relay error. */
export function parseConsoleControl(value: unknown): ConsoleControl | null {
  if (isRelayError(value)) return value as RelayError;
  return parseSupervisorFrame(value);
}

type Direction = 'to_supervisor' | 'from_supervisor';
type FrameOf<D extends Direction> = D extends 'to_supervisor' ? ToSupervisor : FromSupervisor;

const SPECS: Record<Direction, Partial<Record<number, number>>> = {
  to_supervisor: { [CONSOLE_FRAME.open]: CONSOLE_LIMITS.controlFrameBytes, [CONSOLE_FRAME.input]: CONSOLE_LIMITS.inputFrameBytes, [CONSOLE_FRAME.resize]: 4 },
  from_supervisor: { [CONSOLE_FRAME.control]: CONSOLE_LIMITS.controlFrameBytes, [CONSOLE_FRAME.output]: CONSOLE_LIMITS.outputFrameBytes },
};

/**
 * The bounded reader of one direction of a console stream. It holds at most one frame, refuses an
 * unknown type, an oversized or empty payload, malformed JSON, a control frame outside the closed set
 * and more input or output in total than the console allows. After an error it stays failed.
 */
export class ConsoleFrameReader<D extends Direction> {
  private pending: Buffer = Buffer.alloc(0);
  private inputTotal = 0;
  private outputTotal = 0;
  private failed: ConsoleStreamError | null = null;

  constructor(private readonly direction: D) {}

  push(chunk: Uint8Array): FrameOf<D>[] {
    if (this.failed) throw this.failed;
    try {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
      const frames: FrameOf<D>[] = [];
      while (this.pending.length >= HEADER) {
        const type = this.pending.readUInt8(0);
        const length = this.pending.readUInt32BE(1);
        const max = SPECS[this.direction][type];
        if (max === undefined) throw new ConsoleStreamError('unknown_frame');
        if (length > max) throw new ConsoleStreamError('frame_too_large');
        if (length === 0) throw new ConsoleStreamError('invalid_frame');
        if (this.pending.length < HEADER + length) break;
        const payload = Buffer.from(this.pending.subarray(HEADER, HEADER + length));
        this.pending = this.pending.subarray(HEADER + length);
        frames.push(this.decode(type, payload));
      }
      return frames;
    } catch (error) {
      this.failed = error instanceof ConsoleStreamError ? error : new ConsoleStreamError('invalid_frame');
      this.pending = Buffer.alloc(0);
      throw this.failed;
    }
  }

  private decode(type: number, payload: Buffer): FrameOf<D> {
    switch (type) {
      case CONSOLE_FRAME.open: {
        const body = parseJson(payload);
        if (!isPlainObject(body)) throw new ConsoleStreamError('invalid_frame');
        return { type: 'open', body } as FrameOf<D>;
      }
      case CONSOLE_FRAME.input:
        this.inputTotal += payload.length;
        if (this.inputTotal > CONSOLE_LIMITS.inputTotalBytes) throw new ConsoleStreamError('input_too_large');
        return { type: 'input', data: payload } as FrameOf<D>;
      case CONSOLE_FRAME.resize: {
        if (payload.length !== 4) throw new ConsoleStreamError('invalid_frame');
        const cols = payload.readUInt16BE(0);
        const rows = payload.readUInt16BE(2);
        if (!sizeIn(cols, CONSOLE_SIZE.cols) || !sizeIn(rows, CONSOLE_SIZE.rows)) throw new ConsoleStreamError('invalid_frame');
        return { type: 'resize', cols, rows } as FrameOf<D>;
      }
      case CONSOLE_FRAME.control: {
        const control = parseConsoleControl(parseJson(payload));
        if (!control) throw new ConsoleStreamError('invalid_frame');
        return { type: 'control', frame: control } as FrameOf<D>;
      }
      case CONSOLE_FRAME.output:
        this.outputTotal += payload.length;
        if (this.outputTotal > CONSOLE_LIMITS.outputTotalBytes) throw new ConsoleStreamError('output_too_large');
        return { type: 'output', data: payload } as FrameOf<D>;
      default:
        throw new ConsoleStreamError('unknown_frame');
    }
  }
}

export type ConsoleEnd = 'closed' | 'protocol' | 'error';

/**
 * One upgraded console connection: frames in through the bounded reader, raw frames out. `onEnd` runs
 * once, when the peer closes, the stream breaks or a frame is refused (the socket is then destroyed).
 */
export class ConsoleLink<D extends Direction> {
  private ended = false;
  private frameHandler: (frame: FrameOf<D>) => void = () => undefined;
  private endHandlers: ((reason: ConsoleEnd) => void)[] = [];

  constructor(readonly socket: Duplex, private readonly reader: ConsoleFrameReader<D>) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    // The peer ended its side: the console is over. End ours too (an HTTP server's sockets allow a half
    // close, which would otherwise keep the connection open).
    socket.on('end', () => { this.finish('closed'); if (!socket.destroyed) socket.end(); });
    socket.on('close', () => this.finish('closed'));
    socket.on('error', () => this.finish('error'));
  }

  /** Frames that arrived with the upgrade answer (`head`) are read first. */
  start(head?: Buffer) {
    if (head?.length) this.receive(head);
  }

  onFrame(handler: (frame: FrameOf<D>) => void) { this.frameHandler = handler; }
  onEnd(handler: (reason: ConsoleEnd) => void) { if (this.ended) handler('closed'); else this.endHandlers.push(handler); }
  get open() { return !this.ended; }

  send(bytes: Buffer): void {
    if (!this.ended && !this.socket.destroyed && this.socket.writable) this.socket.write(bytes);
  }

  /** Ends the connection after the frames already written; a peer that does not close is cut off. */
  close(): void {
    if (this.ended) return;
    this.socket.end();
    setTimeout(() => { if (!this.socket.destroyed) this.socket.destroy(); }, 5_000).unref();
    this.finish('closed');
  }

  destroy(): void {
    if (!this.socket.destroyed) this.socket.destroy();
    this.finish('closed');
  }

  private receive(chunk: Buffer) {
    if (this.ended) return;
    let frames: FrameOf<D>[];
    try { frames = this.reader.push(chunk); } catch {
      this.finish('protocol');
      this.socket.destroy();
      return;
    }
    for (const value of frames) {
      if (this.ended) return;
      this.frameHandler(value);
    }
  }

  private finish(reason: ConsoleEnd) {
    if (this.ended) return;
    this.ended = true;
    for (const handler of this.endHandlers.splice(0)) handler(reason);
  }
}

export type ConsoleUpgrade =
  | { ok: true; socket: Duplex; head: Buffer }
  | { ok: false; code: 'unauthorized' | 'refused' | 'unreachable' | 'timeout' | 'protocol'; status?: number };

/**
 * Opens a console connection: `GET <path>` with `Connection: Upgrade`, `Upgrade: flux-console/1` and
 * the bearer secret. Anything but `101` with that protocol is a refusal; its body is not read beyond
 * a few bytes and never logged.
 */
export function openConsoleUpgrade(target: { host: string; port: number; path: string; secret: string; timeoutMs?: number }): Promise<ConsoleUpgrade> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ConsoleUpgrade) => {
      if (settled) {
        if (outcome.ok) outcome.socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const req = httpRequest({
      host: target.host, port: target.port, method: 'GET', path: target.path, agent: false,
      headers: { authorization: `Bearer ${target.secret}`, connection: 'Upgrade', upgrade: CONSOLE_PROTOCOL },
    });
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, code: 'timeout' }); }, target.timeoutMs ?? 10_000);
    req.on('upgrade', (res, socket, head) => {
      if (res.statusCode !== 101 || String(res.headers.upgrade ?? '').toLowerCase() !== CONSOLE_PROTOCOL) {
        socket.destroy();
        finish({ ok: false, code: 'protocol' });
        return;
      }
      finish({ ok: true, socket, head });
    });
    req.on('response', (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      finish({ ok: false, code: status === 401 ? 'unauthorized' : status >= 500 ? 'unreachable' : 'refused', status });
    });
    req.on('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end();
  });
}

/** The answer a console server writes to accept an upgrade. */
export const CONSOLE_UPGRADE_ANSWER = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${CONSOLE_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`;

/** Refuses an upgrade before any frame: a plain HTTP status with no body that could carry anything. */
export function refuseUpgrade(socket: Duplex, status: 400 | 401 | 404 | 409 | 503, reason: string) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** True when an upgrade request asks for exactly the console protocol. */
export function isConsoleUpgrade(headers: Record<string, string | string[] | undefined>): boolean {
  const upgrade = headers.upgrade;
  const connection = headers.connection;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === CONSOLE_PROTOCOL
    && typeof connection === 'string' && connection.toLowerCase().split(',').map((part) => part.trim()).includes('upgrade');
}

/** The API's side: a console to `slot` through runtime-manager on `runtime-control`. */
export function openManagerConsole(manager: { url: string; secret: string }, slot: string): Promise<ConsoleUpgrade> {
  if (!SLOT_NAME.test(slot)) return Promise.resolve({ ok: false, code: 'refused' });
  const url = new URL(manager.url);
  return openConsoleUpgrade({ host: url.hostname, port: Number(url.port), path: managerConsolePath(slot), secret: manager.secret });
}

export type { ManagerError };
