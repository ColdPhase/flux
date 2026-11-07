import { InvalidInputError } from '../access/errors.js';
import type { PersonalRunUnitOfWork } from './ports.js';
import { announce } from './progress.js';
import { STALE_AFTER_SECONDS } from './service.js';

/** A run this long past its last change, and not in the runtime's report, has lost its worker (#860). */
const LOST_AFTER_SECONDS = 120;

/** Ends the runs the runtime no longer has, so a lost run does not hold a place on the server for everyone (#860). */
export async function recoverLostRuntimeRuns(uow: PersonalRunUnitOfWork, running: readonly string[], limit = 100): Promise<number> {
  return uow.run(async (ports) => {
    const ended = await ports.runs.endLostRuntime(running, LOST_AFTER_SECONDS, limit);
    for (const run of ended) await announce(ports, run);
    return ended.length;
  });
}

/** End crashed runs and their owner-only progress in the same transaction; never retry compute. */
export async function recoverPersonalRuns(uow: PersonalRunUnitOfWork, limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('Recovery batch must be between 1 and 100');
  return uow.run(async (ports) => {
    const ended = await ports.runs.endStaleAny(STALE_AFTER_SECONDS, limit);
    for (const run of ended) await announce(ports, run);
    return ended.length;
  });
}
