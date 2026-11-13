import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { BINDING_ID, RUNTIME_PORTS, SLOT_NAME, UUID } from './names.js';
import { int, object, str, type Check } from './shape.js';

// A file of a run's scratch, for `flux_attach_file` (#1437, RT-5): the one answer of the runtime that is bytes, not frames. The API asks the
// manager, the manager the run's supervisor, which reads the file as the run's person through Flux's sandbox reader (native/sandbox.c
// `read`): only a regular file, never through a link as its last name, and never outside that run's scratch, whatever the path says. The
// path is data for that reader, never a command line; the run must be running, in that person's binding. The bytes are streamed through
// unchanged; the API checks them as a person's upload.

export const RUN_FILE_LIMITS = {
  /** A path as the agent names it in its scratch. */
  pathCharacters: 512,
  /** The largest file the API may ask for: the operator's largest video (FILE_LIMITS.videoMaxMib). */
  maxBytes: 1024 * 1024 * 1024,
  /** How long a file may take to arrive. */
  timeoutMs: 20 * 60_000,
} as const;

export interface RunFileRequest { bindingId: string; runId: string; path: string; maxBytes: number }

/** No control character, no empty path; anything else is up to the sandbox, which keeps it inside the scratch. */
// eslint-disable-next-line no-control-regex
const RUN_FILE_PATH = /^[^\u0000-\u001f\u007f]{1,512}$/;
export const isRunFileRequest: Check<RunFileRequest> = object({
  bindingId: str(BINDING_ID, 36), runId: str(UUID, 36), path: str(RUN_FILE_PATH, RUN_FILE_LIMITS.pathCharacters), maxBytes: int(1, RUN_FILE_LIMITS.maxBytes),
}) as Check<RunFileRequest>;

/** Why a file did not come: the plain cases the agent is told about, then the transport's. */
export const RUN_FILE_ERRORS = ['file_missing', 'file_not_regular', 'file_too_large', 'file_secret', 'not_running', 'no_sandbox', 'invalid_request', 'unauthorized',
  'unknown_slot', 'no_binding', 'binding_unsafe', 'internal', 'unreachable', 'timeout', 'protocol'] as const;
export type RunFileError = (typeof RUN_FILE_ERRORS)[number];

export const supervisorFilePath = '/v1/file';
export const managerFilePath = (slot: string) => `/v1/slots/${slot}/file`;
/** The status each refusal travels with; the body is `{ error }` as JSON. A file is 200 with `application/octet-stream`. */
export const RUN_FILE_STATUS: Record<RunFileError, number> = {
  file_missing: 404, file_not_regular: 422, file_too_large: 413, file_secret: 422, not_running: 409, no_sandbox: 501, invalid_request: 400, unauthorized: 401,
  unknown_slot: 404, no_binding: 409, binding_unsafe: 409, internal: 502, unreachable: 503, timeout: 504, protocol: 502,
};

export type RunFileOutcome = { ok: true; body: Readable; size: number | null } | { ok: false; code: RunFileError };

/**
 * One POST whose answer is a file's bytes or `{ error }`. The body is handed on as a stream, never buffered here; the caller bounds what it
 * reads (the API's storage receive does).
 */
export function postForFile(target: { host: string; port: number; path: string; secret: string }, request: RunFileRequest, timeoutMs: number = RUN_FILE_LIMITS.timeoutMs): Promise<RunFileOutcome> {
  const body = Buffer.from(JSON.stringify(request));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RunFileOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
    const req = httpRequest({ host: target.host, port: target.port, method: 'POST', path: target.path, agent: false, timeout: timeoutMs,
      headers: { authorization: `Bearer ${target.secret}`, 'content-type': 'application/json', 'content-length': body.length } }, (res: IncomingMessage) => {
      if (res.statusCode === 200 && /^application\/octet-stream(;|$)/.test(String(res.headers['content-type'] ?? ''))) {
        const size = Number(res.headers['x-flux-file-size']);
        finish({ ok: true, body: res, size: Number.isSafeInteger(size) && size >= 0 ? size : null });
        return;
      }
      const parts: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length <= 4096) parts.push(chunk); });
      res.on('end', () => {
        try {
          const answer = JSON.parse(Buffer.concat(parts).toString('utf8')) as { error?: unknown };
          finish({ ok: false, code: (RUN_FILE_ERRORS as readonly unknown[]).includes(answer.error) ? answer.error as RunFileError : 'protocol' });
        } catch { finish({ ok: false, code: 'protocol' }); }
      });
      res.on('error', () => finish({ ok: false, code: 'unreachable' }));
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, code: 'timeout' }); });
    req.on('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end(body);
  });
}

/** The API's call: the file of `runId`'s scratch, through runtime-manager (`url` e.g. `http://runtime-manager-control:7600`). */
export function fetchRunFile(manager: { url: string; secret: string }, slot: string, request: RunFileRequest): Promise<RunFileOutcome> {
  if (!SLOT_NAME.test(slot)) return Promise.resolve({ ok: false, code: 'unknown_slot' });
  const url = new URL(manager.url);
  return postForFile({ host: url.hostname, port: Number(url.port || 80), path: managerFilePath(slot), secret: manager.secret }, request);
}

/** The manager's call to the run's supervisor. */
export const fetchSupervisorFile = (target: { host: string; port?: number; secret: string }, request: RunFileRequest) =>
  postForFile({ host: target.host, port: target.port ?? RUNTIME_PORTS.supervisor, path: supervisorFilePath, secret: target.secret }, request);
