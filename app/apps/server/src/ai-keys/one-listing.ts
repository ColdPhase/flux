import { RateLimitedError } from '@flux/core';

/**
 * One model listing at a time for each person (#1347, audit A): a listing reads a body from a server the person names, so a session that
 * starts hundreds at once could hold the API's memory and its sockets (240 listings of a 4 MB `/models` at once delayed other requests by
 * 3.5 s). The same listing asked again while it runs (the same provider, address and key) shares the one that is running; another one is
 * refused until it ends, with a short wait. The limit is per API process.
 */
export function onePerPerson<T>() {
  const running = new Map<string, { same: string; value: Promise<T> }>();
  return async (person: string, same: string, work: () => Promise<T>): Promise<T> => {
    const current = running.get(person);
    if (current) {
      if (current.same === same) return current.value;
      throw new RateLimitedError(2, 'A list of models is already being read for you. Try again in a moment.', 'MODEL_LIST_BUSY');
    }
    const entry = { same, value: work() };
    running.set(person, entry);
    try { return await entry.value; }
    finally { if (running.get(person) === entry) running.delete(person); }
  };
}
