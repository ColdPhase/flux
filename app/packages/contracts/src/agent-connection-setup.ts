/** Owner-private setup facts. None of these records proves instruction loading or Start/Resume readiness. */
export interface AgentConnectionSetupFacts {
  /** An unexpired, unrevoked token record belongs to this owner's connection and an enabled client. */
  authorizationRecorded: boolean;
  /** Current binding generation only; an open lease is not evidence that a native process is online. */
  session: { startedAt: string; expiresAt: string } | null;
  /** No supported native control adapter is shipped yet. OAuth, bootstrap and ACK cannot change this. */
  activation: 'pending';
}
