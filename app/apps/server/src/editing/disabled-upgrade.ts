import { EDITING_SOCKET_PATH } from '@flux/contracts';
import type { UpgradeGate } from '../http/upgrades.js';

/** Refuse before Fastify's generic WebSocket fallback can complete an unknown-route handshake. */
export function disabledEditingUpgrade(): UpgradeGate {
  return { handleUpgrade(request, socket) {
    let path: string;
    try { path = new URL(request.url ?? '/', 'http://editing.invalid').pathname; }
    catch { return false; }
    if (path !== EDITING_SOCKET_PATH) return false;
    socket.on('error', () => socket.destroy());
    if (socket.destroyed || !socket.writable) { socket.destroy(); return true; }
    const body = 'LIVE_EDITING_DISABLED';
    const timer = setTimeout(() => socket.destroy(), 1000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      () => socket.destroy());
    return true;
  } };
}
