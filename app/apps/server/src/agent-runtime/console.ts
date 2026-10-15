import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  AGENT_RUNTIME_CONSOLE_INPUT_CHARS, AGENT_RUNTIME_CONSOLE_LIFETIME_MS, AGENT_RUNTIME_CONSOLE_SIZE,
  type AgentRuntimeConsoleClientMessage, type AgentRuntimeConsoleError, type AgentRuntimeConsoleServerMessage, type ClaudeCodeSignInMethod,
} from '@flux/contracts';
import type { AgentRuntimeUseCases, RuntimeAuthOperation } from '@flux/core';
import {
  ConsoleFrameReader, ConsoleLink, encodeInput, encodeOpen, encodeResize, openManagerConsole, type ConsoleControl,
} from '@flux/runtime-protocol';

// The API's side of the sign-in console (F-022 "Sign-in as in a terminal", T4 #279).
//
// 1. `POST /api/v1/agent-runtime/console {client, method}` gives a ticket: single use, valid for one
//    minute, signed with a key derived from the API's secret and bound to the owner AND to the session
//    that asked for it. It names no slot and no binding.
// 2. The browser opens the WebSocket at the same path (same-origin cookie, Origin checked) and attaches
//    with the ticket. Another member's session, another session of the same owner, a used or an expired
//    ticket are refused before anything reaches the runtime.
// 3. The API names the owner's own slot from the database and opens the console through runtime-manager.
//    It relays the CLI's output as binary messages and the owner's input as frames, in memory only. It
//    never logs a message. Durable admission refuses overlapping auth; uncertain work needs full recovery.
// 4. When the CLI ends, the supervisor reads its status; that alone is recorded (display facts) and
//    sent to the browser as the final message.

const TICKET_TTL_MS = 60_000;
const ATTACH_WITHIN_MS = 10_000;

export interface ConsoleTicket { ownerUserId: string; client: 'claude_code'; method: ClaudeCodeSignInMethod }
export interface VerifiedConsoleTicket extends ConsoleTicket { nonce: { digest: string; expiresAt: Date } }

export class ConsoleTickets {
  private readonly key: Buffer;

  constructor(secret: string, private readonly now: () => number = Date.now) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'flux-agent-runtime', 'console ticket v1', 32));
  }

  private static sessionTag(sessionId: string) { return createHash('sha256').update(`console-session\n${sessionId}`).digest('base64url').slice(0, 22); }
  private sign(body: string) { return createHmac('sha256', this.key).update(body).digest('base64url'); }

  issue(ticket: ConsoleTicket, sessionId: string): { ticket: string; expiresAt: string } {
    const expires = this.now() + TICKET_TTL_MS;
    const body = Buffer.from(JSON.stringify({ o: ticket.ownerUserId, s: ConsoleTickets.sessionTag(sessionId), c: ticket.client, m: ticket.method, e: expires,
      n: randomBytes(12).toString('base64url') })).toString('base64url');
    return { ticket: `${body}.${this.sign(body)}`, expiresAt: new Date(expires).toISOString() };
  }

  /** Verify owner/session/method/expiry; shared PostgreSQL admission enforces one-use. */
  redeem(value: unknown, ownerUserId: string, sessionId: string): VerifiedConsoleTicket | null {
    if (typeof value !== 'string' || value.length > 512) return null;
    const [body, mac, ...rest] = value.split('.');
    if (!body || !mac || rest.length) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let fields: { o?: unknown; s?: unknown; c?: unknown; m?: unknown; e?: unknown; n?: unknown };
    try { fields = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof fields; } catch { return null; }
    const now = this.now();
    if (typeof fields.e !== 'number' || !Number.isFinite(fields.e) || fields.e <= now
      || typeof fields.n !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(fields.n)) return null;
    if (fields.o !== ownerUserId || fields.s !== ConsoleTickets.sessionTag(sessionId) || fields.c !== 'claude_code') return null;
    if (fields.m !== 'claude_account' && fields.m !== 'console' && fields.m !== 'sso') return null;
    // Pure verification. Only the shared PostgreSQL claim consumes the digest.
    return { ownerUserId, client: 'claude_code', method: fields.m,
      nonce: { digest: createHash('sha256').update(fields.n).digest('hex'), expiresAt: new Date(fields.e) } };
  }
}

/** HMAC of an account digest the slot reported, with a key only the API holds (F-022 step 5). */
export function accountFingerprinter(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'flux-agent-runtime', 'account fingerprint v1', 32));
  return (digest: string) => createHmac('sha256', key).update(digest).digest('hex');
}

const sizeIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

/** One browser message, exactly one of the closed shapes, or null. */
export function parseClientMessage(text: string): AgentRuntimeConsoleClientMessage | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort().join(',');
  if (fields.t === 'attach' && keys === 'cols,rows,t,ticket' && typeof fields.ticket === 'string'
    && sizeIn(fields.cols, AGENT_RUNTIME_CONSOLE_SIZE.cols) && sizeIn(fields.rows, AGENT_RUNTIME_CONSOLE_SIZE.rows)) {
    return { t: 'attach', ticket: fields.ticket, cols: fields.cols, rows: fields.rows };
  }
  if (fields.t === 'in' && keys === 'd,t' && typeof fields.d === 'string' && fields.d.length > 0 && fields.d.length <= AGENT_RUNTIME_CONSOLE_INPUT_CHARS) {
    return { t: 'in', d: fields.d };
  }
  if (fields.t === 'size' && keys === 'cols,rows,t' && sizeIn(fields.cols, AGENT_RUNTIME_CONSOLE_SIZE.cols) && sizeIn(fields.rows, AGENT_RUNTIME_CONSOLE_SIZE.rows)) {
    return { t: 'size', cols: fields.cols, rows: fields.rows };
  }
  return null;
}

/** WebSocket close codes of the console (4000–4999 are the application's). */
export const CONSOLE_CLOSE = { done: 1000, invalid: 4400, refused: 4403, replaced: 4409, ended: 4410, unavailable: 4503 } as const;

export interface ConsoleSessionDeps {
  runtime: AgentRuntimeUseCases;
  tickets: ConsoleTickets;
  manager: { url: string; secret: string };
  /** The owner's consoles on this API instance: a newer one replaces an older one. */
  open: Map<string, () => void>;
  /** Re-reads the session; the console ends when it is no longer live. */
  sessionAlive: () => Promise<boolean>;
  lifetimeMs?: number;
}

export function serveBrowserConsole(socket: WebSocket, owner: { userId: string; sessionId: string }, deps: ConsoleSessionDeps): void {
  let phase: 'attach' | 'connecting' | 'relay' | 'done' = 'attach';
  let finishing = false;
  let link: ConsoleLink<'from_supervisor'> | null = null;
  let attachment: { ticket: VerifiedConsoleTicket; operation: RuntimeAuthOperation; actualBoot: string | null } | null = null;
  let operation: RuntimeAuthOperation | null = null;
  let settled = false;
  const isEnded = () => phase === 'done';
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = (message: AgentRuntimeConsoleServerMessage) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };
  const close = (code: number, reason: string) => {
    if (isEnded()) return;
    phase = 'done';
    for (const timer of timers) clearTimeout(timer);
    link?.destroy();
    if (operation && !settled) void deps.runtime.cancelAuth(operation).catch(() => undefined);
    if (deps.open.get(owner.userId) === end) deps.open.delete(owner.userId);
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
  };
  const fail = (code: AgentRuntimeConsoleError, closeCode: number) => { send({ t: 'error', code }); close(closeCode, code); };
  const end = () => fail('ended', CONSOLE_CLOSE.replaced);

  timers.push(setTimeout(() => { if (phase === 'attach') close(CONSOLE_CLOSE.invalid, 'attach'); }, ATTACH_WITHIN_MS));
  timers.push(setTimeout(() => fail('ended', CONSOLE_CLOSE.ended), (deps.lifetimeMs ?? AGENT_RUNTIME_CONSOLE_LIFETIME_MS) + 30_000));
  const revalidate = setInterval(() => {
    void deps.sessionAlive().then(async alive => {
      if (!alive || (operation && !await deps.runtime.renewAuth(operation))) fail('ended', CONSOLE_CLOSE.refused);
    }).catch(() => fail('unavailable', CONSOLE_CLOSE.unavailable));
  }, 20_000);
  timers.push(revalidate as unknown as ReturnType<typeof setTimeout>);

  async function connect(ticket: VerifiedConsoleTicket, cols: number, rows: number) {
    phase = 'connecting';
    let target: { slot: string; operation: RuntimeAuthOperation };
    try { target = await deps.runtime.beginConsole({ ownerUserId: owner.userId, sessionId: owner.sessionId }, ticket.client, ticket.nonce); }
    catch (error) { fail((error as { code?: string }).code === 'AGENT_RUNTIME_AUTH_BUSY' ? 'busy' : 'refused', CONSOLE_CLOSE.refused); return; }
    operation = target.operation;
    if (phase !== 'connecting') { await deps.runtime.cancelAuth(target.operation); return; }
    // Local notifications only: PostgreSQL admission already proved the previous work settled.
    deps.open.get(owner.userId)?.();
    deps.open.set(owner.userId, end);
    const upgrade = await openManagerConsole(deps.manager, target.slot);
    if (!upgrade.ok) { fail('unavailable', CONSOLE_CLOSE.unavailable); return; }
    if (phase !== 'connecting') { upgrade.socket.destroy(); return; }
    attachment = { ticket, operation: target.operation, actualBoot: null };
    const current = new ConsoleLink(upgrade.socket, new ConsoleFrameReader('from_supervisor'));
    link = current;
    current.onFrame((frame) => {
      if (frame.type === 'output') { if (socket.readyState === socket.OPEN) socket.send(frame.data, { binary: true }); return; }
      void control(frame.frame);
    });
    current.onEnd(() => { if (phase !== 'done' && !finishing) fail('ended', CONSOLE_CLOSE.ended); });
    current.start(upgrade.head);
    current.send(encodeOpen({ bindingId: target.operation.bindingId, bootId: target.operation.bootId, client: ticket.client, method: ticket.method, cols, rows }));
    phase = 'relay';
    send({ t: 'state', state: 'starting' });
  }

  async function control(frame: ConsoleControl) {
    if (phase === 'done') return;
    if (frame.t === 'accepted') {
      if (!attachment || frame.bootId !== attachment.operation.bootId) { fail('unavailable', CONSOLE_CLOSE.unavailable); return; }
      attachment.actualBoot = frame.bootId;
      return;
    }
    if (frame.t === 'step') return;
    if (frame.t === 'console') { send({ t: 'state', state: frame.state === 'started' ? 'running' : 'checking' }); return; }
    if (frame.t === 'relay_error') { fail(frame.code === 'busy' ? 'busy' : 'unavailable', CONSOLE_CLOSE.unavailable); return; }
    if (frame.t === 'error') { fail(frame.code === 'busy' ? 'busy' : frame.code === 'internal' || frame.code === 'not_installed' ? 'unavailable' : 'refused', CONSOLE_CLOSE.unavailable); return; }
    const result = frame.result;
    if (result.kind !== 'login' || !attachment || (result.client !== attachment.ticket.client || result.status.client !== attachment.ticket.client)) { fail('unavailable', CONSOLE_CLOSE.unavailable); return; }
    finishing = true;
    try {
      const completed = await deps.runtime.recordSignIn(owner.userId, { operation: attachment.operation, method: attachment.ticket.method },
        { signedIn: result.status.signedIn, facts: result.status.facts, bootId: attachment.actualBoot ?? '' });
      settled = completed.disposition === 'accepted';
      if (isEnded()) return;
      send({ t: 'done', ended: result.ended, disposition: completed.disposition, signedIn: completed.signedIn, status: completed.status });
      close(CONSOLE_CLOSE.done, 'done');
    } catch {
      fail('unavailable', CONSOLE_CLOSE.unavailable);
    }
  }

  socket.on('message', (data, isBinary) => {
    if (phase === 'done') return;
    if (isBinary) { close(CONSOLE_CLOSE.invalid, 'text only'); return; }
    const message = parseClientMessage(data.toString());
    if (!message) { close(CONSOLE_CLOSE.invalid, 'invalid'); return; }
    if (phase === 'attach') {
      if (message.t !== 'attach') { close(CONSOLE_CLOSE.invalid, 'attach first'); return; }
      const ticket = deps.tickets.redeem(message.ticket, owner.userId, owner.sessionId);
      if (!ticket) { fail('refused', CONSOLE_CLOSE.refused); return; }
      void connect(ticket, message.cols, message.rows).catch(() => fail('unavailable', CONSOLE_CLOSE.unavailable));
      return;
    }
    if (message.t === 'attach') { close(CONSOLE_CLOSE.invalid, 'attached'); return; }
    if (phase !== 'relay' || !link) return;
    link.send(message.t === 'in' ? encodeInput(Buffer.from(message.d, 'utf8')) : encodeResize(message.cols, message.rows));
  });
  socket.on('close', () => close(CONSOLE_CLOSE.ended, 'closed'));
  socket.on('error', () => close(CONSOLE_CLOSE.ended, 'error'));
}
