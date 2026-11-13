import { request as httpRequest, type IncomingMessage } from 'node:http';
import { BINDING_ID, RUNTIME_PORTS, SLOT_NAME, UUID } from './names.js';
import { object, str, text, type Check } from './shape.js';

// Whether a text a run is about to send out through a Flux tool holds its CLI's own vendor credential (coordinator decision on #1437, RT-5,
// RT-7): Codex applies an `apply_patch` itself, outside Flux's sandbox shell, with the rights of its own home, so a run steered by hostile
// content could move its login into its scratch before the supervisor stops it. The vendor login never leaves the runtime: the API sends the
// text to the run's supervisor (through runtime-manager), which alone knows the values, and gets back only whether one of them is in it.

export const RUN_SCAN_LIMITS = {
  /** One request's text; a longer one is asked about in overlapping pieces (`scanPieces`). */
  textCharacters: 512 * 1024,
  /** Its JSON body: every character escaped at worst. */
  bodyBytes: 512 * 1024 * 6 + 1024,
  /** What two pieces share, more than any credential value is long. */
  overlapCharacters: 8 * 1024,
  timeoutMs: 15_000,
} as const;

export interface RunScanRequest { bindingId: string; runId: string; text: string }
export const isRunScanRequest: Check<RunScanRequest> = object({
  bindingId: str(BINDING_ID, 36), runId: str(UUID, 36), text: text(RUN_SCAN_LIMITS.textCharacters),
}) as Check<RunScanRequest>;

export const RUN_SCAN_ERRORS = ['not_running', 'invalid_request', 'unauthorized', 'unknown_slot', 'no_binding', 'binding_unsafe', 'internal',
  'unreachable', 'timeout', 'protocol'] as const;
export type RunScanError = (typeof RUN_SCAN_ERRORS)[number];
export const RUN_SCAN_STATUS: Record<RunScanError, number> = {
  not_running: 409, invalid_request: 400, unauthorized: 401, unknown_slot: 404, no_binding: 409, binding_unsafe: 409, internal: 502,
  unreachable: 503, timeout: 504, protocol: 502,
};
export type RunScanOutcome = { ok: true; found: boolean } | { ok: false; code: RunScanError };

export const supervisorScanPath = '/v1/scan';
export const managerScanPath = (slot: string) => `/v1/slots/${slot}/scan`;

/** `text` in pieces of at most the request's limit, each sharing its last `overlapCharacters` with the next, so no value falls between two. */
export function scanPieces(value: string): string[] {
  const { textCharacters: size, overlapCharacters: overlap } = RUN_SCAN_LIMITS;
  if (value.length <= size) return [value];
  const pieces: string[] = [];
  for (let start = 0; start < value.length; start += size - overlap) {
    pieces.push(value.slice(start, start + size));
    if (start + size >= value.length) break;
  }
  return pieces;
}

/** One POST whose answer is `{ found }` or `{ error }`. */
export function postScan(target: { host: string; port: number; path: string; secret: string }, request: RunScanRequest,
  timeoutMs: number = RUN_SCAN_LIMITS.timeoutMs): Promise<RunScanOutcome> {
  const body = Buffer.from(JSON.stringify(request));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RunScanOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
    const req = httpRequest({ host: target.host, port: target.port, method: 'POST', path: target.path, agent: false, timeout: timeoutMs,
      headers: { authorization: `Bearer ${target.secret}`, 'content-type': 'application/json', 'content-length': body.length } }, (res: IncomingMessage) => {
      const parts: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length <= 4096) parts.push(chunk); });
      res.on('end', () => {
        try {
          const answer = JSON.parse(Buffer.concat(parts).toString('utf8')) as { found?: unknown; error?: unknown };
          if (res.statusCode === 200 && typeof answer.found === 'boolean') { finish({ ok: true, found: answer.found }); return; }
          finish({ ok: false, code: (RUN_SCAN_ERRORS as readonly unknown[]).includes(answer.error) ? answer.error as RunScanError : 'protocol' });
        } catch { finish({ ok: false, code: 'protocol' }); }
      });
      res.on('error', () => finish({ ok: false, code: 'unreachable' }));
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, code: 'timeout' }); });
    req.on('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end(body);
  });
}

/** The API's call, through runtime-manager (`url` e.g. `http://runtime-manager-control:7600`). */
export function scanRunText(manager: { url: string; secret: string }, slot: string, request: RunScanRequest): Promise<RunScanOutcome> {
  if (!SLOT_NAME.test(slot)) return Promise.resolve({ ok: false, code: 'unknown_slot' });
  const url = new URL(manager.url);
  return postScan({ host: url.hostname, port: Number(url.port || 80), path: managerScanPath(slot), secret: manager.secret }, request);
}

/** The manager's call to the run's supervisor. */
export const scanSupervisorText = (target: { host: string; port?: number; secret: string }, request: RunScanRequest) =>
  postScan({ host: target.host, port: target.port ?? RUNTIME_PORTS.supervisor, path: supervisorScanPath, secret: target.secret }, request);
