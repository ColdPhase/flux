import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { authorizeTypingContext, authorizeTypingSender, normalizeTypingCommand, typingContextKey, type TypingActor, type TypingPulse } from '@flux/core';
import type { TypingCommand, TypingContext, TypingSnapshot, TypingServerMessage } from '@flux/contracts';
import { TypingHub, type TypingDelivery } from './hub.js';

/** Socket-owned identity, serial authorization/publication, and bounded commands/output. */
export class TypingConnection {
  context: TypingContext | null = null;
  private requested: TypingContext | null = null;
  private readonly connectionId = randomUUID();
  private readonly actor: TypingActor;
  private sequence = 0;
  private minimumExpiry = 0;
  private lastPublished: TypingContext | null = null;
  private lastActive = -Infinity;
  private epoch = 0;
  private stopped = false;
  private running = false;
  private readonly commands: { command: TypingCommand; generation: number }[] = [];
  private pending: TypingDelivery | null = null;
  private tokens = 8;
  private tokenAt = performance.now();
  private sending = false;
  private output: { snapshot: TypingServerMessage; epoch: number; generation: number; expiresAt: number; pulses: TypingPulse[] } | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private publication: Promise<void> | null = null;
  private terminal = false;
  private sessionCheck = false;
  private pongAt = performance.now();
  private socketClosed = false;
  private closing = false;
  private termination: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly socket: WebSocket, actor: TypingActor, private readonly hub: TypingHub, private readonly release: () => void) {
    this.actor = Object.freeze({ ...actor });
    hub.subscribers.add(this);
    socket.on('message', (data, binary) => {
      if (this.stopped) return;
      const now = performance.now();
      this.tokens = Math.min(8, this.tokens + (now - this.tokenAt) * 4 / 1000); this.tokenAt = now;
      if (this.tokens < 1) { this.close(1008, 'Typing rate exceeded'); return; }
      this.tokens--;
      let command: TypingCommand;
      try {
        const size = Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
        if (binary || size > 1024) throw new Error('Invalid command');
        command = normalizeTypingCommand(JSON.parse(String(data)));
      } catch { this.close(1008, 'Invalid typing command'); return; }
      if (command.type !== 'active' || !command.active) {
        this.epoch++; this.pending = null; this.output = null;
        // Terminal withdrawal has its own bounded publication lane. A slow
        // recipient/sender policy check must not delay an already valid stop.
        void this.withdraw().catch(() => this.close(1011, 'Typing unavailable'));
      }
      if (this.commands.length >= 4) { this.close(1008, 'Typing work exceeded'); return; }
      this.commands.push({ command, generation: this.epoch });
      void this.drain();
    });
    socket.on('close', () => {
      this.socketClosed = true;
      if (this.termination) clearTimeout(this.termination); this.termination = null;
      this.stop(); this.maybeRelease();
    });
    socket.on('error', () => this.close(1011, 'Typing unavailable'));
    socket.on('pong', () => { this.pongAt = performance.now(); });
    this.output = { snapshot: { type: 'identity', id: this.actor.actorId }, epoch: this.epoch,
      generation: hub.generation, expiresAt: performance.now() + 1000, pulses: [] };
    this.flush();
  }
  heartbeat() {
    if (this.stopped) return;
    if (performance.now() - this.pongAt > 5000) { this.close(1001, 'Typing connection ended'); return; }
    this.socket.ping();
    this.sessionCheck = true;
    void this.drain();
  }
  refresh(delivery: TypingDelivery) { if (!this.stopped) { this.pending = delivery; void this.drain(); } }
  private current(generation: number) { return !this.stopped && generation === this.epoch && this.socket.readyState === 1; }
  private async publish(context: TypingContext, active: boolean, generation?: number) {
    let waited = false;
    while (this.publication) { waited = true; await this.publication; }
    if (active && waited) {
      const canonical = this.requested ? await authorizeTypingContext(this.hub.access, this.actor, this.requested, 'write') : null;
      if (!canonical || typingContextKey(canonical) !== typingContextKey(context)) return;
    }
    if (active && (generation === undefined || !this.current(generation))) return;
    const operation = (async () => {
      const pulse = await this.hub.notifications.publish({ ...this.actor, connectionId: this.connectionId,
        context: { ...context }, sequence: ++this.sequence, active }, this.minimumExpiry);
      this.minimumExpiry = Math.max(this.minimumExpiry, pulse.expiresAt);
      this.lastPublished = active ? { ...context } : null;
    })();
    this.publication = operation;
    let failure: unknown;
    try { await operation; } catch (error) { failure = error; }
    finally { if (this.publication === operation) this.publication = null; }
    if (this.terminal) {
      this.terminal = false;
      try { await this.withdraw(); } catch (error) { failure ??= error; }
    }
    this.maybeRelease();
    if (failure) throw failure;
  }
  private async withdraw() {
    if (this.publication) { this.terminal = true; return; }
    const context = this.lastPublished;
    if (context) await this.publish(context, false);
    else { this.terminal = false; this.maybeRelease(); }
  }
  private async command(command: TypingCommand, generation: number) {
    if (command.type === 'leave' || command.type === 'watch') {
      await this.withdraw();
      if (this.context) this.hub.leave(this.context);
      this.context = this.requested = null;
      if (command.type === 'leave' || !this.current(generation)) return;
      const canonical = await authorizeTypingContext(this.hub.access, this.actor, command.context, 'read');
      if (!this.current(generation)) return;
      this.requested = { ...command.context };
      if (!canonical) {
        this.emit({ type: 'snapshot', context: { ...command.context }, availability: 'unavailable', people: [] }, generation, this.hub.generation);
        return;
      }
      if (!this.hub.watch(canonical)) { this.close(1013, 'Typing unavailable'); return; }
      this.context = { ...canonical };
      this.hub.wake();
      return;
    }
    if (!command.active) { await this.withdraw(); this.hub.wake(); return; }
    if (!this.context || !this.requested || performance.now() - this.lastActive < 1000) return;
    const context = { ...this.context };
    const canonical = await authorizeTypingContext(this.hub.access, this.actor, this.requested, 'write');
    if (!canonical || !this.current(generation) || typingContextKey(canonical) !== typingContextKey(context)) return;
    this.lastActive = performance.now();
    await this.publish(context, true, generation);
    // A stop/leave may have arrived while PostgreSQL was publishing; serial drain
    // withdraws that publication before processing a later scope or heartbeat.
  }
  private async deliver(delivery: TypingDelivery) {
    const epoch = this.epoch;
    const valid = () => this.current(epoch) && delivery.generation === this.hub.generation && this.context && typingContextKey(this.context) === typingContextKey(delivery.context);
    if (!valid() || !this.requested) return;
    const recipient = await authorizeTypingContext(this.hub.access, this.actor, this.requested, 'read');
    if (!valid()) return;
    if (!recipient || typingContextKey(recipient) !== typingContextKey(delivery.context)) {
      this.emit({ type: 'snapshot', context: { ...delivery.context }, availability: 'unavailable', people: [] }, epoch, delivery.generation);
      await this.withdraw();
      if (this.context) this.hub.leave(this.context);
      this.context = this.requested = null;
      return;
    }
    const people = new Map<string, { id: string; name: string }>();
    const approved: TypingPulse[] = [];
    let proofExpires = Infinity;
    for (const pulse of delivery.pulses) {
      if (pulse.actorId === this.actor.actorId) continue;
      const human = await authorizeTypingSender(this.hub.access, pulse);
      proofExpires = Math.min(proofExpires, performance.now() + 1000);
      if (!valid()) return;
      if (!human || !this.hub.current(pulse) || pulse.expiresAt <= delivery.databaseNow + performance.now() - delivery.observedAt) continue;
      const name = [...human.name.replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 128).join('');
      people.set(human.id, { id: human.id, name });
      approved.push(pulse);
    }
    // Recipient is current again after sender checks. Terminal/context/availability
    // fences and the short proof deadline also apply to a queued network send.
    const finalRecipient = await authorizeTypingContext(this.hub.access, this.actor, this.requested, 'read');
    if (!valid() || !finalRecipient || typingContextKey(finalRecipient) !== typingContextKey(delivery.context)) return;
    const currentIds = new Set(approved.filter((pulse) => this.hub.current(pulse) && pulse.expiresAt > delivery.databaseNow + performance.now() - delivery.observedAt).map((pulse) => pulse.actorId));
    for (const id of people.keys()) if (!currentIds.has(id)) people.delete(id);
    const complete = people.size <= 128;
    this.emit({ type: 'snapshot', context: { ...delivery.context }, availability: complete ? delivery.availability : 'unavailable',
      people: complete ? [...people.values()].sort((a, b) => a.id.localeCompare(b.id)) : [] }, epoch, delivery.generation,
      approved.filter((pulse) => currentIds.has(pulse.actorId)), proofExpires);
  }
  private async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && (this.commands.length || this.pending || this.sessionCheck)) {
        const deadline = setTimeout(() => this.close(1011, 'Typing unavailable'), 2000); deadline.unref();
        try {
          const next = this.commands.shift();
          if (next) { await this.command(next.command, next.generation); continue; }
          if (this.sessionCheck) {
            this.sessionCheck = false;
            if (!(await this.hub.access.currentHuman(this.actor))) { this.close(4401, 'Session ended'); return; }
            continue;
          }
          const delivery = this.pending!; this.pending = null;
          await this.deliver(delivery);
        } finally { clearTimeout(deadline); }
      }
    } catch {
      // No payload/identity logs. Fail closed; existing positive leases expire.
      this.close(1011, 'Typing unavailable');
    } finally {
      this.running = false;
      if (this.stopped) { try { await this.withdraw(); } catch { /* bounded expiry */ } }
      this.maybeRelease();
    }
  }
  private emit(snapshot: TypingSnapshot, epoch: number, generation: number, pulses: TypingPulse[] = [], proofExpires = Infinity) {
    this.output = { snapshot, epoch, generation, pulses, expiresAt: Math.min(performance.now() + 1000, proofExpires) };
    this.flush();
  }
  private flush() {
    if (this.sending || !this.output || this.stopped) return;
    const output = this.output; this.output = null;
    if (!this.current(output.epoch) || output.generation !== this.hub.generation || performance.now() >= output.expiresAt) return;
    if (output.snapshot.type === 'snapshot') {
      const currentIds = new Set(output.pulses.filter((pulse) => this.hub.current(pulse)).map((pulse) => pulse.actorId));
      output.snapshot.people = output.snapshot.people.filter((human) => currentIds.has(human.id));
      if (!this.hub.availableFor(output.snapshot.context)) { output.snapshot.availability = 'unavailable'; output.snapshot.people = []; }
    }
    const payload = JSON.stringify(output.snapshot);
    // Browser WebSockets do not expose protocol ping/pong. Identical checked
    // snapshots renew the client freshness lease without repeating DOM text.
    if (Buffer.byteLength(payload) > 65536 || this.socket.bufferedAmount > 65536) { this.close(1013, 'Typing unavailable'); return; }
    this.sending = true;
    this.sendTimer = setTimeout(() => this.close(1013, 'Typing unavailable'), 1000);
    this.socket.send(payload, (error) => {
      if (this.sendTimer) clearTimeout(this.sendTimer); this.sendTimer = null;
      this.sending = false;
      if (error) { this.close(1011, 'Typing unavailable'); return; }
      this.flush();
    });
  }
  private stop() {
    if (this.stopped) return;
    this.stopped = true; this.epoch++;
    this.commands.length = 0; this.pending = null; this.output = null;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.context) this.hub.leave(this.context);
    this.context = this.requested = null;
    this.hub.subscribers.delete(this);
    void this.withdraw().catch(() => undefined);
  }
  private close(code: number, reason: string) {
    if (this.closing || this.socketClosed) return;
    this.closing = true;
    this.stop(); this.socket.close(code, reason);
    // Closing transports still occupy their admission reservation until closed.
    this.termination = setTimeout(() => this.socket.terminate(), 1000); this.termination.unref();
  }
  private maybeRelease() {
    // A closed socket's unfinished query still consumes the same admission permit.
    if (this.socketClosed && !this.running && !this.publication && !this.terminal) this.release();
  }
  shutdown() { this.close(1001, 'Server shutting down'); }
}
