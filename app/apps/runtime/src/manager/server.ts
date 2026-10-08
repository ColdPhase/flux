import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  callSupervisor, managerSlotsPath, parseSupervisorRequest, REQUEST_LIMITS, SLOT_NAME,
  type ManagedSlot, type ManagerError, type SupervisorCallOutcome, type SupervisorRequest, type SupervisorTarget,
} from '@flux/runtime-protocol';
import { authorized } from '../shared/auth.js';

// The runtime manager (F-022 "The manager"): no database and no Docker access. The API and the worker
// reach it on `runtime-control` with the service secret; it reaches each supervisor on that slot's own
// network with that slot's secret, and listens on none of the slot networks. It checks every request
// against the supervisor's closed set before forwarding it, and reads every answer with the bounded
// stream reader. It never logs request bodies or CLI output.

export interface ManagerConfig {
  secret: string;
  slots: Map<string, SupervisorTarget>;
  call?: (target: SupervisorTarget, request: SupervisorRequest) => Promise<SupervisorCallOutcome>;
  log?: (event: Record<string, unknown>) => void;
}

const STATUS: Record<string, number> = {
  unauthorized: 502, unknown_request: 400, invalid_request: 400, unknown_slot: 404, busy: 409, client_off: 409, not_installed: 409,
  data_not_empty: 409, no_binding: 409, binding_mismatch: 409, binding_unsafe: 409, binding_too_large: 409, not_available: 501,
  internal: 502, unreachable: 503, timeout: 504, protocol: 502,
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > REQUEST_LIMITS.bodyBytes) { resolve(undefined); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });
}

/** Asks every slot for its report, in slot order. An unreachable or misbehaving slot is listed as such. */
export async function listSlots(config: ManagerConfig): Promise<ManagedSlot[]> {
  const call = config.call ?? callSupervisor;
  const names = [...config.slots.keys()].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return Promise.all(names.map(async (slot): Promise<ManagedSlot> => {
    const outcome = await call(config.slots.get(slot)!, { kind: 'status' });
    if (outcome.ok && outcome.result.kind === 'status' && 'slot' in outcome.result) {
      // A slot that reports another slot's name is answering for something it is not.
      if (outcome.result.slot.slot !== slot) return { slot, reachable: false, error: 'protocol' };
      return { slot, reachable: true, report: outcome.result.slot };
    }
    return { slot, reachable: false, error: outcome.ok ? 'protocol' : (outcome.code as ManagerError) };
  }));
}

export function createManagerServer(config: ManagerConfig): Server {
  const call = config.call ?? callSupervisor;
  const log = config.log ?? ((event) => console.log(JSON.stringify(event)));
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    if (!authorized(req.headers.authorization, config.secret)) { json(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && req.url === managerSlotsPath) { json(res, 200, { slots: await listSlots(config) }); return; }
    const route = /^\/v1\/slots\/([a-z0-9-]{1,16})\/([a-z]{1,16})$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !route) { json(res, 404, { error: 'unknown_request' }); return; }
    const [, slot, kind] = route as unknown as [string, string, string];
    const target = SLOT_NAME.test(slot) ? config.slots.get(slot) : undefined;
    if (!target) { json(res, 404, { error: 'unknown_slot' }); return; }
    const parsed = parseSupervisorRequest(kind, await readJson(req));
    if (!parsed.ok) { json(res, STATUS[parsed.code]!, { error: parsed.code }); return; }
    const started = Date.now();
    const outcome = await call(target, parsed.request);
    log({ event: 'request', slot, kind: parsed.request.kind, outcome: outcome.ok ? 'ok' : outcome.code, ms: Date.now() - started });
    if (outcome.ok) json(res, 200, { result: outcome.result });
    else json(res, STATUS[outcome.code] ?? 502, { error: outcome.code });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  return server;
}

/** Slot targets from the manager's environment: `FLUX_RUNTIME_SLOT_<n>=<secret>` names `runtime-<n>`. */
export function slotsFromEnv(env: NodeJS.ProcessEnv, secretPattern: RegExp): Map<string, SupervisorTarget> {
  const slots = new Map<string, SupervisorTarget>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^FLUX_RUNTIME_SLOT_([1-9][0-9]{0,2})$/.exec(key);
    if (!match) continue;
    const slot = `runtime-${match[1]}`;
    if (!value) continue;
    if (!secretPattern.test(value)) throw new Error(`${key} must be at least 32 characters (A-Z, a-z, 0-9, _ or -)`);
    slots.set(slot, { host: slot, secret: value });
  }
  return slots;
}
