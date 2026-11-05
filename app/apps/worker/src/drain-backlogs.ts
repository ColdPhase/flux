import type { PgBoss } from 'pg-boss';

/** After a failed handler, how long before the queue's workers look again: the poll interval of the worker before #862. */
export const FAILED_JOB_REFETCH_MS = 2_000;

type Handler = (...args: unknown[]) => Promise<unknown>;

/**
 * A backlog drains at the handler's pace, not the backstop's (#862). A worker is woken by NOTIFY, and one transaction that
 * queues several jobs sends one NOTIFY per queue, so a worker that took one job and then slept its whole 30 s backstop would
 * leave the rest waiting (a message mentioning six people delivered one push per 30 s). Every `work` registration is
 * wrapped so that, once its handler is done, the queue's workers fetch again at once; a fetch that finds nothing lets them
 * sleep. An empty queue is still not polled, and a queue's four local workers (e-mail) share the backlog because all of
 * them are woken. A failed handler wakes them after `refetchAfterFailureMs`, so its retry and the jobs behind it do not
 * wait for the backstop, and a job with no retry delay is not retried in a tight loop.
 */
export function drainBacklogs(boss: PgBoss, refetchAfterFailureMs = FAILED_JOB_REFETCH_MS) {
  const work = boss.work.bind(boss) as (...args: unknown[]) => Promise<string>;
  const wake = (queue: string) => {
    for (const worker of boss.getWipData()) if (worker.name === queue) boss.notifyWorker(worker.id);
  };
  (boss as { work: unknown }).work = (name: string, ...rest: unknown[]) => {
    const handler = rest.pop() as Handler;
    return work(name, ...rest, async (...args: unknown[]) => {
      try {
        const result = await handler(...args);
        wake(name);
        return result;
      } catch (error) {
        setTimeout(() => wake(name), refetchAfterFailureMs).unref();
        throw error;
      }
    });
  };
}
