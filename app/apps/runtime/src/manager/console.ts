import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CONSOLE_LIMITS, CONSOLE_UPGRADE_ANSWER, ConsoleFrameReader, ConsoleLink, encodeControl, encodeInput, encodeOpen, encodeOutput, encodeResize,
  isConsoleUpgrade, openConsoleUpgrade, parseSupervisorRequest, refuseUpgrade, requestBody, RUNTIME_PORTS, SLOT_NAME,
  type ConsoleUpgrade, type ManagerError, type SupervisorTarget,
} from '@flux/runtime-protocol';
import { authorized } from '../shared/auth.js';

// runtime-manager's relay of the sign-in console (F-022 T4 #279). The API opens it on `runtime-control`
// with the service secret, naming the slot it read from the database for the session's owner; the
// manager checks the login request against the closed set, opens the slot's console with that slot's
// secret and relays frames both ways. Each frame is read by the bounded reader and written again, so a
// malformed or oversized frame from either side ends the console. Frames are never logged: the log
// line names the slot, the outcome and the duration only.

export interface ConsoleRelayConfig {
  secret: string;
  slots: Map<string, SupervisorTarget>;
  log: (event: Record<string, unknown>) => void;
}

function relayCode(outcome: Extract<ConsoleUpgrade, { ok: false }>): ManagerError {
  if (outcome.code === 'unauthorized') return 'unauthorized';
  if (outcome.code === 'timeout') return 'timeout';
  if (outcome.code === 'unreachable') return 'unreachable';
  return outcome.status === 409 ? 'busy' : 'protocol';
}

export function relayConsole(config: ConsoleRelayConfig, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on('error', () => socket.destroy());
  if (!authorized(req.headers.authorization, config.secret)) { refuseUpgrade(socket, 401, 'Unauthorized'); return; }
  const route = /^\/v1\/slots\/([a-z0-9-]{1,16})\/login$/.exec(req.url ?? '');
  if (req.method !== 'GET' || !route || !isConsoleUpgrade(req.headers)) { refuseUpgrade(socket, 404, 'Not Found'); return; }
  const slot = route[1]!;
  const target = SLOT_NAME.test(slot) ? config.slots.get(slot) : undefined;
  if (!target) { refuseUpgrade(socket, 404, 'Not Found'); return; }
  socket.write(CONSOLE_UPGRADE_ANSWER);

  const started = Date.now();
  let outcome = 'ended';
  const upstream = new ConsoleLink(socket, new ConsoleFrameReader('to_supervisor'));
  let downstream: ConsoleLink<'from_supervisor'> | null = null;
  let opened = false;
  const early: Buffer[] = [];
  const refuse = (code: ManagerError) => {
    outcome = `refused:${code}`;
    upstream.send(encodeControl({ t: 'relay_error', code }));
    upstream.close();
  };
  const openTimer = setTimeout(() => { if (!opened) { opened = true; refuse('invalid_request'); } }, CONSOLE_LIMITS.openWithinMs);
  // The supervisor ends the PTY at 15 minutes; the relay never outlives that by more than a margin.
  const lifetime = setTimeout(() => { outcome = 'lifetime'; upstream.destroy(); downstream?.destroy(); }, CONSOLE_LIMITS.lifetimeMs + 30_000);

  async function connect(body: Record<string, unknown>) {
    const parsed = parseSupervisorRequest('login', body);
    if (!parsed.ok) { refuse(parsed.code); return; }
    const answer = await openConsoleUpgrade({ host: target!.host, port: target!.port ?? RUNTIME_PORTS.supervisor, path: '/v1/login', secret: target!.secret });
    if (!answer.ok) { refuse(relayCode(answer)); return; }
    if (!upstream.open) { answer.socket.destroy(); return; }
    const link = new ConsoleLink(answer.socket, new ConsoleFrameReader('from_supervisor'));
    downstream = link;
    link.onFrame((frame) => {
      // Only the manager speaks for the relay; a supervisor that claims to is misbehaving.
      if (frame.type === 'control' && frame.frame.t === 'relay_error') { outcome = 'protocol'; link.destroy(); return; }
      upstream.send(frame.type === 'output' ? encodeOutput(frame.data) : encodeControl(frame.frame));
    });
    link.onEnd((reason) => {
      if (reason === 'protocol') { outcome = 'protocol'; upstream.send(encodeControl({ t: 'relay_error', code: 'protocol' })); }
      upstream.close();
    });
    link.start(answer.head);
    link.send(encodeOpen(requestBody(parsed.request)));
    for (const bytes of early.splice(0)) link.send(bytes);
  }

  upstream.onFrame((frame) => {
    if (!opened) {
      opened = true;
      clearTimeout(openTimer);
      if (frame.type !== 'open') { refuse('invalid_request'); return; }
      void connect(frame.body).catch(() => refuse('protocol'));
      return;
    }
    if (frame.type === 'open') { outcome = 'protocol'; upstream.destroy(); return; }
    const bytes = frame.type === 'input' ? encodeInput(frame.data) : encodeResize(frame.cols, frame.rows);
    if (downstream) downstream.send(bytes);
    else if (early.length < 64) early.push(bytes);
  });
  upstream.onEnd((reason) => {
    clearTimeout(openTimer);
    clearTimeout(lifetime);
    downstream?.destroy();
    if (reason === 'protocol') outcome = 'protocol';
    config.log({ event: 'console', slot, outcome, ms: Date.now() - started });
  });
  upstream.start(head);
}
