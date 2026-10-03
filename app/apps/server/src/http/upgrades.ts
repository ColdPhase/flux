import type { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeGate {
  /** true means this gate owns the request, including an eventual refusal. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/** Exactly one application listener owns dispatch; detached ws servers never attach another. */
export function registerUpgradeDispatcher(server: Server, fallback: EventEmitter,
  gates: readonly (UpgradeGate | null | undefined)[]): () => void {
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    for (const gate of gates) if (gate?.handleUpgrade(request, socket, head)) return;
    // Existing event and conversation-typing routes keep @fastify/websocket's 1 KiB bound.
    fallback.emit('upgrade', request, socket, head);
  };
  server.on('upgrade', upgrade);
  return () => server.off('upgrade', upgrade);
}
