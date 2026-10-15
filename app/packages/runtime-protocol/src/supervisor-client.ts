import { request as httpRequest } from 'node:http';
import { parseSupervisorFrame, resultMatches, type StepOutcome, type SupervisorError, type SupervisorFrame, type SupervisorResult } from './frames.js';
import { DEFAULT_FRAME_LIMITS, FrameStreamError, NdjsonReader, type FrameLimits } from './ndjson.js';
import { RUNTIME_PORTS } from './names.js';
import { requestBody, type SupervisorRequest } from './requests.js';

// The manager's side of one supervisor request: an authenticated POST on the slot's own network and a
// bounded, ordered read of the answer. The answer must be `accepted` (for this request), any `step`s,
// then exactly one `result` of the request's kind or one `error`, and then the end of the stream.

export type SupervisorCallOutcome =
  | { ok: true; bootId: string; result: SupervisorResult; steps: { step: string; outcome: StepOutcome; client?: string }[] }
  | { ok: false; code: SupervisorError | 'unreachable' | 'timeout' | 'protocol' };

export interface SupervisorTarget { host: string; port?: number; secret: string }

export const SUPERVISOR_TIMEOUTS_MS: Record<SupervisorRequest['kind'], number> = {
  bind: 10_000, status: 30_000, login: 15 * 60_000, run: 30 * 60_000, stop: 10_000, logout: 60_000, release: 120_000,
};

const MAX_STEPS = 16;

export function callSupervisor(target: SupervisorTarget, request: SupervisorRequest,
  options: { timeoutMs?: number; limits?: FrameLimits } = {}): Promise<SupervisorCallOutcome> {
  const body = Buffer.from(JSON.stringify(requestBody(request)));
  const timeoutMs = options.timeoutMs ?? SUPERVISOR_TIMEOUTS_MS[request.kind];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SupervisorCallOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs);
    const req = httpRequest({
      host: target.host, port: target.port ?? RUNTIME_PORTS.supervisor, method: 'POST', path: `/v1/${request.kind}`,
      headers: { authorization: `Bearer ${target.secret}`, 'content-type': 'application/json', 'content-length': body.length },
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 401 && res.statusCode !== 400 && res.statusCode !== 404 && res.statusCode !== 409) {
        finish({ ok: false, code: 'protocol' });
        return;
      }
      if (!/^application\/x-ndjson(;|$)/.test(String(res.headers['content-type'] ?? ''))) { finish({ ok: false, code: 'protocol' }); return; }
      const reader = new NdjsonReader<SupervisorFrame>(parseSupervisorFrame, options.limits ?? DEFAULT_FRAME_LIMITS);
      const steps: { step: string; outcome: StepOutcome; client?: string }[] = [];
      let bootId: string | null = null;
      let terminal: SupervisorCallOutcome | null = null;
      const accept = (frame: SupervisorFrame) => {
        if (terminal) throw new FrameStreamError('invalid_frame');
        if (frame.t === 'error') { terminal = { ok: false, code: frame.code }; return; }
        if (frame.t === 'accepted') {
          if (bootId !== null || frame.kind !== request.kind) throw new FrameStreamError('invalid_frame');
          bootId = frame.bootId;
          return;
        }
        if (bootId === null) throw new FrameStreamError('invalid_frame');
        // Console frames belong to the sign-in console's stream (console.ts), never to a request's answer.
        if (frame.t === 'console') throw new FrameStreamError('invalid_frame');
        if (frame.t === 'step') {
          if (steps.length >= MAX_STEPS) throw new FrameStreamError('too_many_frames');
          steps.push({ step: frame.step, outcome: frame.outcome, ...(frame.client ? { client: frame.client } : {}) });
          return;
        }
        if (!resultMatches(request.kind, frame.result)) throw new FrameStreamError('invalid_frame');
        terminal = { ok: true, bootId, result: frame.result, steps };
      };
      res.on('data', (chunk: Buffer) => {
        try { for (const frame of reader.push(chunk)) accept(frame); } catch { finish({ ok: false, code: 'protocol' }); }
      });
      res.on('end', () => {
        try { reader.end(); } catch { finish({ ok: false, code: 'protocol' }); return; }
        finish(terminal ?? { ok: false, code: 'protocol' });
      });
      res.on('error', () => finish({ ok: false, code: 'unreachable' }));
    });
    req.on('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end(body);
  });
}
