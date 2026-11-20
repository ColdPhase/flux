import { connect } from 'node:net';

/**
 * The start check of the model gateway path (#1556): one TCP connection from this runtime to the gateway on runtime-egress, so a blocked
 * path (a firewall rule, a missing network) is in the log when the runtime starts, before a person's run meets it. Nothing is sent.
 * `ok`, or the class of the failure as `piErrorClass` names a run's: `connection_refused`, `connect_timeout`, `dns`, `unreachable`, `other`.
 */
export function probeGateway(origin: string, timeoutMs = 5_000): Promise<string> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) || 80 });
    const done = (outcome: string) => { socket.destroy(); clearTimeout(timer); resolve(outcome); };
    const timer = setTimeout(() => done('connect_timeout'), timeoutMs);
    timer.unref();
    socket.once('connect', () => done('ok'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(
      error.code === 'ECONNREFUSED' ? 'connection_refused' : error.code === 'ETIMEDOUT' ? 'connect_timeout'
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' ? 'dns' : error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH' ? 'unreachable' : 'other'));
  });
}
