import type { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeGate {
  /** true means this gate owns the request, including an eventual refusal. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/** A target that is not a path (`GET http://[/media/rtc`, `*media/rtc`) is refused with a 400 before any gate reads it: a browser sends nothing else than `/…`. */
function refuseTarget(socket: Duplex) {
  socket.on('error', () => socket.destroy());
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

/** Exactly one application listener owns dispatch; detached ws servers never attach another. */
export function registerUpgradeDispatcher(server: Server, fallback: EventEmitter,
  gates: readonly (UpgradeGate | null | undefined)[]): () => void {
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Nothing below parses a target that does not start with `/`: Node's parser accepts targets that `new URL` throws on, and a throw here
    // is the end of the process (#1060 review).
    if (request.url?.charCodeAt(0) !== 47) { refuseTarget(socket); return; }
    for (const gate of gates) if (gate?.handleUpgrade(request, socket, head)) return;
    // Existing event and conversation-typing routes keep @fastify/websocket's 1 KiB bound.
    fallback.emit('upgrade', request, socket, head);
  };
  server.on('upgrade', upgrade);
  return () => server.off('upgrade', upgrade);
}
