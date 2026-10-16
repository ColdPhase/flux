import { spawn } from 'node:child_process';
import { cliEnvironment, CODEX_FILE_STORE } from './templates.js';

// The allowlisted Codex app-server client (F-022 "Hardening: no local tool" and "Caps", T6 #281). It starts
// `codex app-server` in the owner's binding directory with the CLI's own environment (never the run token),
// speaks its JSON-RPC over stdio (one JSON object per line) and may send ONLY `initialize`, `config/read` and
// `account/rateLimits/read`. Every other method, `command/exec` included, is refused here before anything is
// written, because wenext measured that app-server's `command/exec` still runs with the shell features off.
// The server's own requests and notifications are never answered. Nothing it prints is logged.

export const APP_SERVER_METHODS = ['initialize', 'config/read', 'account/rateLimits/read'] as const;
export type AppServerMethod = (typeof APP_SERVER_METHODS)[number];

export class AppServerMethodRefused extends Error {
  constructor(readonly method: string) {
    super('This app-server method is not on Flux\'s allowlist');
    this.name = 'AppServerMethodRefused';
  }
}

/** Refuses any method but the three; exported for the contract test. */
export function allowedAppServerMethod(method: string): method is AppServerMethod {
  return (APP_SERVER_METHODS as readonly string[]).includes(method);
}

const MAX_LINE_BYTES = 256 * 1024;
const CLIENT_INFO = { name: 'flux-runtime', title: 'Flux agent runtime', version: '1' };

export interface AppServerSession {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * One app-server process for one check. `initialize` is sent first and the session is refused until it
 * answers. The process is killed on `close`, on a timeout, or on any malformed line.
 */
export async function openAppServer(cliPath: string, bindingDir: string, egressHost: string, options: { timeoutMs: number; overrides?: readonly string[] }): Promise<AppServerSession> {
  const child = spawn(cliPath, [...CODEX_FILE_STORE, ...(options.overrides ?? []), 'app-server'],
    { env: cliEnvironment('codex', bindingDir, egressHost), cwd: bindingDir, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let closed = false;
  const fail = (why: string) => {
    if (closed) return;
    closed = true;
    kill();
    for (const pending of waiting.values()) pending.reject(new Error(why));
    waiting.clear();
  };
  const timer = setTimeout(() => fail('timed out'), options.timeoutMs);
  timer.unref();
  let pending: Buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) break;
      const line = pending.subarray(0, newline).toString('utf8').trim();
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      let message: { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { fail('malformed'); return; }
      // A server request or notification (it has a method) is never answered.
      if (!message || typeof message !== 'object' || message.method !== undefined || typeof message.id !== 'number') continue;
      const waiter = waiting.get(message.id);
      if (!waiter) continue;
      waiting.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error('app-server error'));
      else waiter.resolve(message.result);
    }
    if (pending.length > MAX_LINE_BYTES) fail('line too long');
  });
  child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined);
  child.on('error', () => fail('spawn failed'));
  child.on('close', () => fail('exited'));

  const send = (method: string, params: Record<string, unknown> | undefined): Promise<unknown> => {
    if (!allowedAppServerMethod(method)) return Promise.reject(new AppServerMethodRefused(method));
    if (closed) return Promise.reject(new Error('closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    });
  };
  await send('initialize', { clientInfo: CLIENT_INFO });
  // The protocol's acknowledgement; a notification, not a method of the server's.
  if (!closed) child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  return {
    request: (method, params) => {
      if (method === 'initialize') return Promise.reject(new AppServerMethodRefused(method));
      return send(method, params);
    },
    close: () => { clearTimeout(timer); fail('closed'); },
  };
}

/** A plan-limit window as the slot passes it on: the percentage used and when it resets, or unknown. */
export interface RateLimitReading { limited: boolean | null; resetsAt: string | null }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `account/rateLimits/read`'s snapshot reduced to: is a window at 100 %, and when does it reset. Any shape
 * Flux does not recognise is "unknown" (limited: null), never zero.
 */
export function readRateLimits(result: unknown): RateLimitReading {
  const snapshot = isObject(result) && isObject(result.rateLimits) ? result.rateLimits : null;
  if (!snapshot) return { limited: null, resetsAt: null };
  const windows = [snapshot.primary, snapshot.secondary].filter(isObject);
  if (!windows.length) return { limited: null, resetsAt: null };
  let limited = false;
  let resetsAt: number | null = null;
  for (const window of windows) {
    const used = window.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) return { limited: null, resetsAt: null };
    if (used < 100) continue;
    limited = true;
    const resets = window.resetsAt;
    if (typeof resets === 'number' && Number.isFinite(resets) && resets > 0) {
      const ms = resets < 1e12 ? resets * 1000 : resets;
      resetsAt = resetsAt === null ? ms : Math.max(resetsAt, ms);
    }
  }
  return { limited, resetsAt: limited && resetsAt !== null ? new Date(resetsAt).toISOString() : null };
}
