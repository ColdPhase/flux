import WebSocket from 'ws';
import type { TypingCommand, TypingContext, TypingSnapshot, TypingServerMessage } from '@flux/contracts';
import { apiUrl, publicOrigin, type Browser } from './http.js';

export class TypingClient {
  readonly messages: TypingSnapshot[] = [];
  readonly frames: TypingServerMessage[] = [];
  readonly closed: Promise<number>;
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      this.frames.push(message as TypingServerMessage);
      if (message.type === 'snapshot') this.messages.push(message as TypingSnapshot);
    });
    this.closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  }
  static async connect(browser: Browser, origin: string | null = publicOrigin, endpoint = apiUrl) {
    const headers: Record<string, string> = { cookie: browser.cookieHeader() };
    if (origin !== null) headers.origin = origin;
    const socket = new WebSocket(new URL('/api/v1/typing', endpoint.replace(/^http/, 'ws')), { headers });
    const client = new TypingClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('unexpected-response', (_request, response) => {
        response.resume(); reject(new Error(`Typing upgrade ${response.statusCode}`)); socket.terminate();
      });
      socket.on('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error); });
    });
    await client.until(() => client.frames[0]?.type === 'identity', 'authenticated own-account acknowledgement');
    return client;
  }
  send(command: TypingCommand) { this.socket.send(JSON.stringify(command)); }
  async until(check: () => boolean, label: string, timeout = 8000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out: ${label}; ${this.messages.length} typing frames`);
  }
  async watch(context: TypingContext, availability = 'ready') {
    this.send({ type: 'watch', context });
    await this.until(() => this.messages.some((message) => message.context.id === context.id && message.availability === availability), 'watch');
  }
  async close() { this.socket.close(1000); await this.closed; }
}
