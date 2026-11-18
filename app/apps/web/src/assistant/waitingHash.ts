/**
 * The address of a run's waiting changes in its conversation, `#waiting-<runId>`: the Inbox's Open on "1 thing waits for you" lands there,
 * on Approve and Skip, not at the start of the thread above them (round 15 AI P2-3).
 */
export const waitingHash = (runId: string) => `#waiting-${runId}`;
export const WAITING_HASH_PREFIX = '#waiting-';
