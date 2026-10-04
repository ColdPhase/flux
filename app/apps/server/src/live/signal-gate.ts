import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { Principal } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import type { MediaSocketRegistry } from './admission-revocation.js';
import type { LiveAdmission, LiveAdmissionStore, RevokedAdmission } from './admissions.js';
import { ADMISSION_ID, MEDIA_GATE_PATH, participantIdentity, type LiveMediaConfig } from './media.js';

/** The only signaling paths of the pinned SFU (livekit-server v1.13.7 rtcservice.go). */
const SIGNAL_PATHS = new Set(['/rtc', '/rtc/v1']);
const VALIDATE_PATHS = ['/rtc/validate', '/rtc/v1/validate'];
/** Signaling carries SDP offers of several kilobytes; the Flux stream keeps its own 1 KiB bound. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;

export interface SignalGateOptions {
  publicOrigin: string;
  config: Pick<LiveMediaConfig, 'apiUrl' | 'signalUrl' | 'apiKey' | 'apiSecret'>;
  sessions: Pick<SessionResolver, 'resolveSession'>;
  admissions: Pick<LiveAdmissionStore, 'find'>;
  /** The live use case: current project/anchor access; returns the session's current room. */
  signalRoom(principal: Principal, liveSessionId: string): Promise<string>;
  /** An admission revoked while its socket was being opened: remove the participant too. */
  onLateRevocation(admission: RevokedAdmission): void;
  log: FastifyBaseLogger;
}

export interface SignalGate extends MediaSocketRegistry {
  /** Takes an HTTP upgrade for `/media/rtc` or `/media/rtc/v1`; false for any other path. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Registers `GET /media/rtc/validate` and `/media/rtc/v1/validate`. */
  routes(app: FastifyInstance): void;
  close(): void;
}

/** Detached media sockets must close before Fastify waits for HTTP connections to drain. */
export function registerSignalGateShutdown(app: FastifyInstance, gate: Pick<SignalGate, 'close'>) {
  app.addHook('preClose', async () => { gate.close(); });
}

type Decision = { admitted: true; admission: LiveAdmission; roomId: string } | { admitted: false; reason: string };

function normalCloseCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}

function refuse(socket: Duplex, status: number, text: string) {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }
  socket.destroy();
}

/**
 * The Flux signaling gate (#128). Browsers never reach the SFU's signaling port; every first
 * connect, resume and full reconnect of a LiveKit client arrives here as
 * `<public origin>/media/rtc{,/v1}?access_token=…`. Before anything is forwarded, the gate
 * requires: a JWT signed with the Flux LiveKit key and unexpired; an admission id as its
 * participant metadata that is unrevoked and names the same person; the request's own cookie
 * session being the admission's session; and current project access to the live session,
 * whose current room the JWT must name. A refused request gets an HTTP status without an
 * upgrade, so no SFU frame, participant list or metadata reaches that client. An admitted one
 * is proxied frame for frame to the private signal URL.
 */
export function liveSignalGate(options: SignalGateOptions): SignalGate {
  const verifier = new TokenVerifier(options.config.apiKey, options.config.apiSecret);
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const open = new Map<string, Set<{ client?: WebSocket; upstream: WebSocket }>>();
  let closing = false;

  async function decide(headers: IncomingHttpHeaders, query: URLSearchParams): Promise<Decision> {
    const token = query.get('access_token');
    if (!token || query.getAll('access_token').length !== 1) return { admitted: false, reason: 'missing_token' };
    let claims;
    try { claims = await verifier.verify(token, 0); }
    catch { return { admitted: false, reason: 'invalid_token' }; }
    const metadata = claims.metadata;
    const room = claims.video?.room;
    if (typeof metadata !== 'string' || !ADMISSION_ID.test(metadata) || typeof room !== 'string' || !claims.sub)
      return { admitted: false, reason: 'not_a_flux_grant' };
    const admission = await options.admissions.find(metadata);
    if (!admission) return { admitted: false, reason: 'unknown_admission' };
    if (admission.revokedAt) return { admitted: false, reason: 'revoked_admission' };
    // The identity is per admission: a grant of another admission, even the same person's, does not match.
    if (claims.sub !== participantIdentity(admission.userId, admission.id))
      return { admitted: false, reason: 'identity_mismatch' };
    // Only the cookie that obtained the grant; another valid session of the same person does not qualify.
    const context = await options.sessions.resolveSession(headers);
    if (!context || context.sessionId !== admission.authSessionId || context.principal.id !== admission.userId)
      return { admitted: false, reason: 'session_mismatch' };
    let roomId: string;
    try { roomId = await options.signalRoom(context.principal, admission.liveSessionId); }
    catch { return { admitted: false, reason: 'no_access' }; }
    if (roomId !== room) return { admitted: false, reason: 'room_mismatch' };
    return { admitted: true, admission, roomId };
  }

  const track = (admissionId: string, entry: { client?: WebSocket; upstream: WebSocket }) => {
    const entries = open.get(admissionId) ?? new Set();
    entries.add(entry);
    open.set(admissionId, entries);
    return () => {
      entries.delete(entry);
      if (!entries.size && open.get(admissionId) === entries) open.delete(admissionId);
    };
  };

  function proxy(request: IncomingMessage, socket: Duplex, head: Buffer, path: string, query: string, admission: LiveAdmission, roomId: string) {
    // Nothing of the browser request is forwarded but the path and query: no cookie reaches the SFU.
    const upstream = new WebSocket(`${options.config.signalUrl}${path}${query ? `?${query}` : ''}`, {
      maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: UPSTREAM_TIMEOUT_MS, perMessageDeflate: false,
    });
    const entry: { client?: WebSocket; upstream: WebSocket } = { upstream };
    const untrack = track(admission.id, entry);
    const abandon = () => { untrack(); upstream.terminate(); };
    socket.once('close', () => { if (!entry.client) abandon(); });

    upstream.once('unexpected-response', (_request, response) => {
      // The SFU refused (for example a room that has ended): pass its status on, no upgrade.
      untrack();
      refuse(socket, response.statusCode ?? 502, response.statusMessage ?? 'Refused');
      response.resume();
      upstream.terminate();
    });
    upstream.on('error', () => {
      if (entry.client) { entry.client.terminate(); return; }
      untrack();
      refuse(socket, 502, 'Media signaling unavailable');
    });
    upstream.once('open', () => {
      if (socket.destroyed || closing) { abandon(); return; }
      upstream.pause();
      server.handleUpgrade(request, socket, head, (client) => {
        entry.client = client;
        const forward = (target: WebSocket) => (data: RawData, isBinary: boolean) => {
          if (target.readyState !== WebSocket.OPEN) return;
          if (target.bufferedAmount > MAX_BUFFERED_BYTES) { client.terminate(); upstream.terminate(); return; }
          target.send(data, { binary: isBinary });
        };
        client.on('message', forward(upstream));
        upstream.on('message', forward(client));
        client.on('close', (code, reason) => { untrack(); if (upstream.readyState <= WebSocket.OPEN) upstream.close(normalCloseCode(code), reason); });
        upstream.on('close', (code, reason) => { untrack(); if (client.readyState <= WebSocket.OPEN) client.close(normalCloseCode(code), reason); });
        client.on('error', () => upstream.terminate());
        upstream.resume();
        // Revocation may have committed while this socket was opening, after its notification
        // looked for open sockets. Read once more now that the socket is registered.
        void options.admissions.find(admission.id).then((current) => {
          if (current && !current.revokedAt) return;
          client.terminate();
          upstream.terminate();
          if (current) options.onLateRevocation({ id: current.id, userId: current.userId, roomId });
        }).catch((error: unknown) => options.log.warn({ error }, 'Live admission recheck failed'));
      });
    });
  }

  const pathOf = (url: string | undefined) => {
    const parsed = new URL(url ?? '/', 'http://gate.invalid');
    if (!parsed.pathname.startsWith(`${MEDIA_GATE_PATH}/`)) return null;
    return { path: parsed.pathname.slice(MEDIA_GATE_PATH.length), query: parsed.search.slice(1), params: parsed.searchParams };
  };

  return {
    handleUpgrade(request, socket, head) {
      const target = pathOf(request.url);
      if (!target) return false;
      socket.on('error', () => socket.destroy());
      if (closing || !SIGNAL_PATHS.has(target.path)) { refuse(socket, 404, 'Not Found'); return true; }
      // Browsers always send Origin on a WebSocket upgrade. The cookie is honoured only from
      // the public origin, as on the Flux stream.
      if (request.headers.origin !== options.publicOrigin) { refuse(socket, 403, 'Forbidden'); return true; }
      void decide(request.headers, target.params).then((decision) => {
        if (!decision.admitted) {
          options.log.info({ reason: decision.reason }, 'Refused live media signaling');
          refuse(socket, 401, 'Media admission denied');
          return;
        }
        proxy(request, socket, head, target.path, target.query, decision.admission, decision.roomId);
      }).catch((error: unknown) => {
        options.log.error({ error }, 'Live media gate failed');
        refuse(socket, 503, 'Media admission unavailable');
      });
      return true;
    },

    routes(app) {
      for (const path of VALIDATE_PATHS) {
        app.get(`${MEDIA_GATE_PATH}${path}`, async (request, reply) => {
          const origin = request.headers.origin;
          if (origin !== undefined && origin !== options.publicOrigin) return reply.code(403).type('text/plain').send('Forbidden');
          const target = pathOf(request.url)!;
          const decision = await decide(request.headers, target.params);
          // 401 is final for the LiveKit client; it does not fall back to the v0 path or retry.
          if (!decision.admitted) return reply.code(401).type('text/plain').send('Media admission denied');
          let response: Response;
          try {
            response = await fetch(`${options.config.apiUrl}${path}?${target.query}`,
              { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
          } catch { return reply.code(502).type('text/plain').send('Media signaling unavailable'); }
          return reply.code(response.status).type('text/plain').send(await response.text());
        });
      }
    },

    closeAdmission(admissionId) {
      const entries = open.get(admissionId);
      if (!entries) return 0;
      open.delete(admissionId);
      // Terminated, not closed: a client that ignores the close handshake keeps nothing open.
      for (const { client, upstream } of entries) {
        client?.terminate();
        upstream.terminate();
      }
      return entries.size;
    },

    openAdmissions: () => [...open.keys()],

    close() {
      closing = true;
      for (const id of [...open.keys()]) {
        for (const { client, upstream } of open.get(id) ?? []) { client?.close(1001, 'Server shutting down'); upstream.terminate(); }
      }
      open.clear();
      server.close();
    },
  };
}
