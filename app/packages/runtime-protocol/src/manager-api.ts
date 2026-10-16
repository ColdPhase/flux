import { request as httpRequest } from 'node:http';
import { isSlotReport, isSupervisorResult, parseSupervisorFrame, SUPERVISOR_ERRORS, type RunFrame, type SlotReport, type SupervisorFrame, type SupervisorResult } from './frames.js';
import { NdjsonReader } from './ndjson.js';
import { RUNTIME_PORTS, SLOT_NAME, UUID } from './names.js';
import { requestBody, type SupervisorRequest } from './requests.js';
import { arrayOf, object, oneOf, str, type Check } from './shape.js';
import { RUN_FRAME_LIMITS, SUPERVISOR_TIMEOUTS_MS } from './supervisor-client.js';

// The manager's HTTP API on the `runtime-control` network (F-022 "The manager"). Only the API and the
// worker call it, with the service secret. It maps nothing itself: callers name the slot and binding
// they read from the database for the session's owner or the worker's own record, never from a
// browser request.

export const MANAGER_ERRORS = [...SUPERVISOR_ERRORS, 'unknown_slot', 'unreachable', 'timeout', 'protocol'] as const;
export type ManagerError = (typeof MANAGER_ERRORS)[number];

export type ManagedSlot = { slot: string; reachable: true; report: SlotReport } | { slot: string; reachable: false; error: ManagerError };

export const managerSlotsPath = '/v1/slots';
export const managerRequestPath = (slot: string, kind: SupervisorRequest['kind']) => `/v1/slots/${slot}/${kind}`;
/** The sign-in console of a slot (F-022 T4): an upgrade to `flux-console/1`, never a plain request. */
export const managerConsolePath = (slot: string) => `/v1/slots/${slot}/login`;

const managerError = oneOf(MANAGER_ERRORS);
const exactly = <T extends boolean>(expected: T): Check<T> => (value): value is T => value === expected;
const isManagedSlot: Check<ManagedSlot> = (value): value is ManagedSlot =>
  object({ slot: str(SLOT_NAME, 12), reachable: exactly(true), report: isSlotReport })(value)
  || object({ slot: str(SLOT_NAME, 12), reachable: exactly(false), error: managerError })(value);
export const isManagerSlots = object({ slots: arrayOf(isManagedSlot, 999) });
export const isManagerResult = object({ bootId: str(UUID, 36), result: isSupervisorResult });
export const isManagerError = object({ error: managerError });

export type ManagerOutcome = { ok: true; bootId: string; result: SupervisorResult } | { ok: false; code: ManagerError };

export interface RuntimeManagerClient {
  slots(): Promise<{ ok: true; slots: ManagedSlot[] } | { ok: false; code: ManagerError }>;
  request(slot: string, request: SupervisorRequest): Promise<ManagerOutcome>;
}

export interface ManagerClientOptions {
  /** e.g. `http://runtime-manager-control:7600`. */
  url: string;
  secret: string;
  fetch?: typeof fetch;
}

export const DEFAULT_MANAGER_URL = `http://runtime-manager-control:${RUNTIME_PORTS.manager}`;

/** The API's and worker's client of the manager. Answers that are not exactly the API's shapes are `protocol`. */
export function createRuntimeManagerClient({ url, secret, fetch: fetchImpl = fetch }: ManagerClientOptions): RuntimeManagerClient {
  const base = url.replace(/\/+$/, '');
  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<{ ok: true; body: unknown } | { ok: false; code: ManagerError }> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, code: (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
    const raw = await response.text().catch(() => '');
    if (raw.length > 4 * 1024 * 1024) return { ok: false, code: 'protocol' };
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return { ok: false, code: 'protocol' }; }
    if (isManagerError(body)) return { ok: false, code: body.error };
    if (!response.ok) return { ok: false, code: 'protocol' };
    return { ok: true, body };
  }
  return {
    async slots() {
      const answer = await call(managerSlotsPath, { method: 'GET' }, 40_000);
      if (!answer.ok) return answer;
      return isManagerSlots(answer.body) ? { ok: true, slots: answer.body.slots } : { ok: false, code: 'protocol' };
    },
    async request(slot, request) {
      if (!SLOT_NAME.test(slot)) return { ok: false, code: 'unknown_slot' };
      const answer = await call(managerRequestPath(slot, request.kind), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody(request)),
      }, SUPERVISOR_TIMEOUTS_MS[request.kind] + 5_000);
      if (!answer.ok) return answer;
      if (!isManagerResult(answer.body) || answer.body.result.kind !== request.kind) return { ok: false, code: 'protocol' };
      return { ok: true, bootId: answer.body.bootId, result: answer.body.result };
    },
  };
}

export type ManagerRunOutcome =
  | { ok: true; result: Extract<SupervisorResult, { kind: 'run' }> }
  /** `broken`: the stream ended or broke without an answer, after it started (the run's effects are unknown). */
  | { ok: false; code: ManagerError | 'broken' };

/**
 * The worker's side of a run (F-022 T5): one POST to the manager, read as a bounded stream of the slot's run
 * frames (handed to `onRun` as they arrive) and then exactly one result or error. A stream that breaks after
 * it started is `broken`; a refusal before it started keeps its code.
 */
export function streamManagerRun({ url, secret }: Omit<ManagerClientOptions, 'fetch'>, slot: string, request: Extract<SupervisorRequest, { kind: 'run' }>,
  onRun: (frame: RunFrame) => void): Promise<ManagerRunOutcome> {
  if (!SLOT_NAME.test(slot)) return Promise.resolve({ ok: false, code: 'unknown_slot' });
  const target = new URL(managerRequestPath(slot, 'run'), url.replace(/\/+$/, '') + '/');
  const body = Buffer.from(JSON.stringify(requestBody(request)));
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    const finish = (outcome: ManagerRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, code: started ? 'broken' : 'timeout' }), SUPERVISOR_TIMEOUTS_MS.run + 5_000);
    const req = httpRequest({ host: target.hostname, port: Number(target.port || 80), method: 'POST', path: target.pathname, agent: false,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      if (/^application\/json(;|$)/.test(String(res.headers['content-type'] ?? ''))) {
        // A refusal before the run: the manager's JSON error.
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { if (parts.reduce((n, part) => n + part.length, 0) < 64 * 1024) parts.push(chunk); });
        res.on('end', () => {
          try {
            const answer = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
            finish(isManagerError(answer) ? { ok: false, code: answer.error } : { ok: false, code: 'protocol' });
          } catch { finish({ ok: false, code: 'protocol' }); }
        });
        res.on('error', () => finish({ ok: false, code: 'unreachable' }));
        return;
      }
      if (res.statusCode !== 200 || !/^application\/x-ndjson(;|$)/.test(String(res.headers['content-type'] ?? ''))) { finish({ ok: false, code: 'protocol' }); return; }
      const reader = new NdjsonReader<SupervisorFrame>(parseSupervisorFrame, RUN_FRAME_LIMITS);
      const accept = (frame: SupervisorFrame) => {
        if (frame.t === 'run') { started = true; onRun(frame); return; }
        if (frame.t === 'error') { finish({ ok: false, code: started && frame.code === 'internal' ? 'broken' : frame.code }); return; }
        if (frame.t === 'result' && frame.result.kind === 'run' && frame.result.runId === request.runId) { finish({ ok: true, result: frame.result }); return; }
        throw new Error('unexpected frame');
      };
      res.on('data', (chunk: Buffer) => {
        try { for (const frame of reader.push(chunk)) accept(frame); } catch { finish({ ok: false, code: started ? 'broken' : 'protocol' }); }
      });
      res.on('end', () => finish({ ok: false, code: started ? 'broken' : 'protocol' }));
      res.on('error', () => finish({ ok: false, code: started ? 'broken' : 'unreachable' }));
    });
    req.on('error', () => finish({ ok: false, code: started ? 'broken' : 'unreachable' }));
    req.end(body);
  });
}
