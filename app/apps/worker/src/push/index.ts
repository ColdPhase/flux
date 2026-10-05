import type { PgBoss } from 'pg-boss';
import { PUSH_SEND_JOB, loadPushSenderConfig, vapidSubjectWarning, type Database, type PushSendJob } from '@flux/core';
import { createPushAgent, deliverPush, type VapidAuthorizer } from './deliver.js';

export { createVapidAuthorizer, deliverPush, type VapidAuthorizer } from './deliver.js';
export { RetryableDeliveryError, type DeliveryOutcome } from '@flux/core';

/**
 * Consumes push.send jobs. Without VAPID configuration jobs complete as skipped and the
 * notification stays in the inbox; misconfiguration (partial or mismatched keys) stops startup.
 * `vapid` is the worker's one VAPID authorizer, so every delivery reuses its JWT per push service.
 */
export async function registerPushWorker(boss: PgBoss, db: Database, vapid: VapidAuthorizer, env: NodeJS.ProcessEnv = process.env) {
  const config = loadPushSenderConfig(env);
  if (config.status === 'unavailable') console.warn(`${config.reason}; notifications stay in the in-app inbox`);
  const subjectWarning = config.status === 'available' ? vapidSubjectWarning(config.subject) : null;
  if (subjectWarning) console.warn(subjectWarning);
  const agent = config.status === 'available' ? createPushAgent(config) : undefined;
  const log = (message: string, details?: Record<string, unknown>) => console.warn(message, details ?? {});
  await boss.work<PushSendJob>(PUSH_SEND_JOB, async (jobs) => {
    for (const job of jobs) {
      const result = await deliverPush({ db, config, agent, vapid, log }, job.data);
      // Quiet hours began after this job was queued: the same send waits until they end (#116).
      if (result.outcome === 'deferred') await boss.send(PUSH_SEND_JOB, job.data, { startAfter: result.until, singletonKey: `${job.data.notificationId}:${job.data.subscriptionId}:${result.until.getTime()}` });
      console.log(JSON.stringify({ job: PUSH_SEND_JOB, id: job.id, subscriptionId: job.data.subscriptionId, ...result }));
    }
  });
  return config.status;
}
