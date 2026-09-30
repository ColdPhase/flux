import { InvalidInputError } from '../access/errors.js';
import type { PersonalRunUnitOfWork } from './ports.js';
import { announce } from './progress.js';
import { STALE_AFTER_SECONDS } from './service.js';

/** End crashed runs and their owner-only progress in the same transaction; never retry compute. */
export async function recoverPersonalRuns(uow: PersonalRunUnitOfWork, limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('Recovery batch must be between 1 and 100');
  return uow.run(async (ports) => {
    const ended = await ports.runs.endStaleAny(STALE_AFTER_SECONDS, limit);
    for (const run of ended) await announce(ports, run);
    return ended.length;
  });
}
