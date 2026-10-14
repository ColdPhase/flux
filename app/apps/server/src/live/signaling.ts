import type { FastifyInstance } from 'fastify';
import { listen } from '@flux/db';
import { liveUseCases, type Database, type LivePorts } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { admissionRevocation, LIVE_ADMISSIONS_CHANNEL, type AdmissionRevocation } from './admission-revocation.js';
import { liveAdmissionStore } from './admissions.js';
import type { LiveMediaAdapter, LiveMediaConfig } from './media.js';
import { liveSignalGate, registerSignalGateShutdown, type SignalGate } from './signal-gate.js';

/** Reconciliation and retention run on this interval; the gate and trigger are the boundary. */
export const ADMISSION_RECONCILE_MS = 30_000;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface LiveSignalingOptions {
  db: Database;
  connectionString: string;
  publicOrigin: string;
  sessions: Pick<SessionResolver, 'resolveSession'>;
  ports: LivePorts;
  media: LiveMediaAdapter;
  config: LiveMediaConfig;
}

/**
 * Composition of media admission (#128): the signaling gate, and the revocation that follows
 * an ended auth session. The `auth_sessions` trigger revokes admissions in the deleting
 * transaction and notifies; this instance then closes its proxied sockets and removes the
 * affected SFU participants. Timers only reconcile what a missed notification or a restart
 * left behind. The caller dispatches `/media/*` upgrades to `gate.handleUpgrade`.
 */
export function registerLiveSignaling(app: FastifyInstance, options: LiveSignalingOptions): { gate: SignalGate; revocation: AdmissionRevocation } {
  const store = liveAdmissionStore(options.db);
  const live = liveUseCases(options.ports);
  const log = (message: string, details: Record<string, unknown>) => app.log.warn(details, message);
  const gate = liveSignalGate({
    publicOrigin: options.publicOrigin,
    config: options.config,
    sessions: options.sessions,
    admissions: store,
    signalRoom: (principal, liveSessionId) => live.signalRoom(principal, liveSessionId),
    onLateRevocation: (admission) => {
      void revocation.admissionRevoked(admission).catch((error: unknown) => log('Late live admission removal failed', { error }));
    },
    log: app.log,
  });
  const revocation = admissionRevocation({ store, media: options.media, sockets: gate, log });
  gate.routes(app);
  registerSignalGateShutdown(app, gate);

  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await revocation.reconcile();
      await store.prune(new Date(Date.now() - PRUNE_AFTER_MS), 1000);
    } catch (error) { log('Live admission reconciliation is pending', { error }); }
    finally { reconciling = false; }
  };
  const ended = (authSessionId: string) => {
    void revocation.sessionEnded(authSessionId).catch((error: unknown) =>
      log('Live media revocation after session end is pending', { error }));
  };
  const listener = listen(options.connectionString, LIVE_ADMISSIONS_CHANNEL, ended,
    () => { void reconcile(); }, (error) => log('Live admission listener interrupted', { error }));
  const timer = setInterval(() => { void reconcile(); }, ADMISSION_RECONCILE_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await listener.close();
  });
  return { gate, revocation };
}
