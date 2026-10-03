import { randomUUID } from 'node:crypto';
import { createNotification, type PushSendJob } from '@flux/core';
import { notificationUnitOfWork } from '../../../apps/server/src/push/adapters.js';
import { db } from './db.js';

/** Creates notifications with real rows and policy, but captures the push jobs instead of queueing them. */
export function capturingNotifier() {
  const jobs: PushSendJob[] = [];
  const uow = notificationUnitOfWork(db, () => ({ enqueuePushSend: async (job) => { jobs.push(job); return randomUUID(); } }));
  return { jobs, notify: (input: Parameters<typeof createNotification>[1]) => createNotification(uow, input) };
}
