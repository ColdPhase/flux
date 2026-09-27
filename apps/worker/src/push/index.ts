import type { PgBoss } from 'pg-boss';
import { PUSH_SEND_JOB, loadPushSenderConfig, type Database, type PushSendJob } from '@flux/core';
import { createPushAgent, deliverPush } from './deliver.js';

export { deliverPush, RetryableDeliveryError, type DeliveryOutcome } from './deliver.js';

/**
 * Consumes push.send jobs. Without VAPID configuration jobs complete as skipped and the
 * notification stays in the inbox; misconfiguration (partial or mismatched keys) stops startup.
 */
export async function registerPushWorker(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv = process.env) {
  const config = loadPushSenderConfig(env);
  if (config.status === 'unavailable') console.warn(`${config.reason}; notifications stay in the in-app inbox`);
  const agent = config.status === 'available' ? createPushAgent(config) : undefined;
  const log = (message: string, details?: Record<string, unknown>) => console.warn(message, details ?? {});
  await boss.work<PushSendJob>(PUSH_SEND_JOB, async (jobs) => {
    for (const job of jobs) {
      const result = await deliverPush({ db, config, agent, log }, job.data);
      console.log(JSON.stringify({ job: PUSH_SEND_JOB, id: job.id, subscriptionId: job.data.subscriptionId, ...result }));
    }
  });
  return config.status;
}
