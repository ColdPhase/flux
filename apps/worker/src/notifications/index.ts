import type { PgBoss } from 'pg-boss';
import { EVENTS_CHANNEL, listen } from '@flux/db';
import {
  GENERATOR_BATCH,
  NOTIFICATION_EMAIL_JOB,
  deliverNotificationEmail,
  generateNotifications,
  loadNotificationMailConfig,
  type Database,
  type EmailJob,
  type NotificationMailer,
} from '@flux/core';
import { emailUnitOfWork, generatorUnitOfWork, smtpNotificationMailer } from './adapters.js';

export { emailUnitOfWork, generatorUnitOfWork, pushPreferenceCheck, smtpNotificationMailer } from './adapters.js';

const POLL_MS = 2000;

/**
 * Turns committed events into notifications (issue #116). A LISTEN on the event channel wakes
 * the generator right after a commit; a short poll catches anything a lost wake-up missed.
 * Runs are serialized in this process, and the cursor row lock serializes worker replicas.
 */
export function startNotificationGenerator(options: { db: Database; boss: PgBoss; connectionString: string; emailAvailable: boolean; log?: (message: string, details?: Record<string, unknown>) => void }) {
  const { db, boss, connectionString, emailAvailable, log = (message, details) => console.warn(message, details ?? {}) } = options;
  const uow = generatorUnitOfWork(db, boss);
  let running = false;
  let again = false;
  let stopped = false;
  // After a failed event the generator waits 2, 4, 8 … 60 s before retrying it.
  let stalls = 0;
  let retryAt = 0;
  const tick = async () => {
    if (stopped || Date.now() < retryAt) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        let processed = GENERATOR_BATCH;
        while (!stopped && processed === GENERATOR_BATCH) {
          const result = await generateNotifications(uow, { emailAvailable, log });
          processed = result.processed;
          if (result.created) console.log(JSON.stringify({ job: 'notification.generate', ...result }));
          if (result.stalled) {
            stalls += 1;
            retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** stalls);
            again = false;
            break;
          }
          stalls = 0;
        }
      } while (again && !stopped);
    } catch (error) {
      log('Notification generation failed; retrying on the next wake-up', { error: (error as Error).message });
    } finally {
      running = false;
    }
  };
  const listener = listen(connectionString, EVENTS_CHANNEL, () => void tick(), () => void tick(), (error) => log('Event listener interrupted', { error: error.message }));
  const timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listener.close();
    },
  };
}

/**
 * Consumes notification email jobs. Without SMTP, email rows are never queued and any left
 * over complete as skipped; the notification stays in the inbox.
 */
export async function registerNotificationEmailWorker(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv = process.env, mailer?: NotificationMailer) {
  const config = loadNotificationMailConfig(env);
  if (config.status === 'unavailable') console.warn(`${config.reason}; notifications stay in the inbox and push`);
  const smtp = config.status === 'available' ? mailer ?? smtpNotificationMailer(config) : null;
  const options = {
    available: config.status === 'available',
    origin: config.status === 'available' ? config.origin : '',
    uow: emailUnitOfWork(db),
    mailer: smtp ?? { send: async () => ({ kind: 'failed' as const, message: 'email unavailable' }) },
  };
  // A few sends at once and a short poll: one slow SMTP answer never holds up everyone's mail.
  await boss.work<EmailJob>(NOTIFICATION_EMAIL_JOB, { localConcurrency: 4, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      const result = await handleEmailJob(boss, options, job.data);
      console.log(JSON.stringify({ job: NOTIFICATION_EMAIL_JOB, id: job.id, emailId: job.data.emailId, ...result }));
    }
  });
  return { available: config.status === 'available', close: () => (smtp && 'close' in smtp ? (smtp as { close(): void }).close() : undefined) };
}

/**
 * One email job: deliver, or when the person's quiet hours cover now, queue the same row again
 * for the end of the window (the row stays `queued`, so it is still sent at most once).
 */
export async function handleEmailJob(boss: PgBoss, options: Parameters<typeof deliverNotificationEmail>[0], job: EmailJob) {
  const result = await deliverNotificationEmail(options, job);
  if (result.outcome === 'deferred') {
    await boss.send(NOTIFICATION_EMAIL_JOB, job, { startAfter: result.until, singletonKey: `${job.emailId}:${result.until.getTime()}` });
  }
  return result;
}
