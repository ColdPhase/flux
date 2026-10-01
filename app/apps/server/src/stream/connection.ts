import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { audienceKey } from '@flux/core';
import { STREAM_CLOSE_SLOW_CONSUMER, STREAM_CLOSE_UNAUTHENTICATED, type StreamMessage } from '@flux/contracts';
import type { SessionResolver } from '../identity/index.js';
import type { CursorCodec } from './cursor.js';
import { drain, type DeliverySources, type DeliveryTarget, type StreamWork, type Subscription } from './delivery.js';

/** Close a client whose unsent data exceeds this, or whose send does not finish in time. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const SEND_TIMEOUT_MS = 30_000;

export interface ConnectionOptions {
  sources: DeliverySources;
  sessions: SessionResolver;
  cursors: CursorCodec;
  /** Ping, session revalidation and polling interval. */
  heartbeatMs: number;
  log: FastifyInstance['log'];
}

/**
 * One subscriber. Delivery is pull-based from this recipient's `event_audience` rows: a
 * wake-up (NOTIFY flux_events, a heartbeat tick or the initial replay) reads the rows
 * after the cursor in seq order by primary key, revalidates the session, re-authorizes
 * each event for this principal as the final check, and awaits each write, so a slow
 * reader slows only its own cursor. Events the recipient could not see have no rows here.
 */
export class StreamConnection implements DeliveryTarget {
  private running = false;
  private dirty = false;
  private closed = false;
  private alive = true;
  private timer: NodeJS.Timeout | null = null;
  /** Work is counted for the initial replay only; later wake-ups come from unrelated NOTIFYs. */
  private counting = true;

  constructor(
    private readonly socket: WebSocket,
    private readonly subscription: Subscription,
    private readonly options: ConnectionOptions,
  ) {}

  get isClosed() {
    return this.closed;
  }

  cursor() {
    return this.options.cursors.encode(audienceKey(this.subscription.principal), this.subscription.visible);
  }

  async start(onReady: (work: StreamWork) => void) {
    this.socket.on('pong', () => { this.alive = true; });
    this.socket.on('message', () => undefined);
    this.timer = setInterval(() => void this.tick(), this.options.heartbeatMs);
    await this.pump();
    if (this.closed) return;
    onReady({ ...this.subscription.work });
    await this.send({ type: 'ready', cursor: this.cursor() }).catch(() => this.close(1011, 'Send failed'));
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.socket.close(code, reason);
  }

  stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.closed) return;
    if (!this.alive) {
      this.stop();
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
    try {
      if (await this.revalidate()) await this.pump();
    } catch (error) {
      this.options.log.warn({ error }, 'Stream revalidation failed');
    }
  }

  /** The session must still exist and belong to the same person; otherwise close 4401. */
  async revalidate() {
    const context = await this.options.sessions.resolveSession(this.subscription.headers);
    if (context && context.sessionId === this.subscription.sessionId && context.principal.id === this.subscription.principal.id) return true;
    this.close(STREAM_CLOSE_UNAUTHENTICATED, 'Session ended');
    return false;
  }

  async pump() {
    if (this.closed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        const count = this.counting;
        this.counting = false;
        await drain(this.options.sources, this.subscription, this, count);
      } while (this.dirty && !this.closed);
    } catch (error) {
      this.options.log.error({ error }, 'Stream delivery failed');
      this.close(1011, 'Delivery failed');
    } finally {
      this.running = false;
    }
  }

  /** Backpressure: close a client that buffers too much or does not accept a frame in time. */
  send(message: StreamMessage) {
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(STREAM_CLOSE_SLOW_CONSUMER, 'Client too slow');
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close(STREAM_CLOSE_SLOW_CONSUMER, 'Client too slow');
        resolve();
      }, SEND_TIMEOUT_MS);
      this.socket.send(JSON.stringify(message), (error) => {
        clearTimeout(timeout);
        if (error && !this.closed) reject(error);
        else resolve();
      });
    });
  }
}
