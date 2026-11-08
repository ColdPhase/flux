/** PostgreSQL's SQLSTATE for the transaction it cancelled to break a deadlock. */
const DEADLOCK_DETECTED = '40P01';

/** Whether this failure, or what it wraps, is a cancelled deadlock victim. */
export function isDeadlock(error: unknown): boolean {
  for (let candidate = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; candidate && typeof candidate === 'object' && depth < 4;
    candidate = candidate.cause as typeof candidate, depth += 1) {
    if (candidate.code === DEADLOCK_DETECTED) return true;
  }
  return false;
}

/**
 * Runs `attempt` (which opens its own transaction) again, once, when PostgreSQL cancelled it as the victim of a deadlock. The cancelled
 * transaction kept nothing, so a second run starts from the rows as they are; the other transaction in the deadlock has usually
 * committed by then. A second deadlock, and every other failure, is the caller's.
 *
 * For a command whose many row locks are taken in an order only the database knows, such as a cascading delete (#1052): the notice
 * generator holds a message `FOR SHARE` and a space's delete locks that space's messages in its own order, so two messages of one space in
 * the running batch can, in theory, make the two wait for each other.
 */
export async function afterDeadlock<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    return attempt();
  }
}
