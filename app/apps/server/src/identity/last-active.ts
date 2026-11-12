// "Last active" (#1225, C-58): a signed-in session that is used says so, at most once a minute for a person, never once a request.

/** What the session resolver calls whenever a signed-in session is used. It never waits and never throws. */
export interface ActivityGate {
  touch(userId: string): void;
}

/** The gate holds when each person was last let through, per process; the database's own one-minute condition bounds a second API process. */
export const ACTIVITY_INTERVAL_MS = 60_000;
/** A person's entry is forgotten after an hour without activity, so the map holds only people who are using Flux. */
const FORGET_AFTER_MS = 60 * 60_000;

/**
 * `write` records the activity (`personLastActive(db).touch`). A request passes the gate once a minute per person: the others cost one map lookup.
 * A write that fails is forgotten at once, so the next request tries again, and its error goes to `onError`, never to the request that caused it.
 */
export function createActivityGate(write: (userId: string) => Promise<unknown>, options: { now?: () => number; onError?: (error: unknown) => void } = {}): ActivityGate {
  const now = options.now ?? Date.now;
  const passed = new Map<string, number>();
  let sweptAt = now();
  return {
    touch(userId) {
      const at = now();
      const before = passed.get(userId);
      if (before !== undefined && at - before < ACTIVITY_INTERVAL_MS) return;
      passed.set(userId, at);
      if (at - sweptAt > FORGET_AFTER_MS) {
        sweptAt = at;
        for (const [id, when] of passed) if (at - when > FORGET_AFTER_MS) passed.delete(id);
      }
      void Promise.resolve().then(() => write(userId)).catch((error: unknown) => {
        if (passed.get(userId) === at) passed.delete(userId);
        options.onError?.(error);
      });
    },
  };
}
