import { randomUUID } from 'node:crypto';
import { LIVE_STARTED_EVENT, principalKey, type Principal } from '@flux/core';
import type { Executor } from '@flux/db';
import { eventPorts } from '../events.js';

/**
 * A call in a space started, someone joined or left it, or it ended (#1175, #862): the space's open tabs read its calls again at once
 * instead of looking on a timer. Like every event it names the space and nothing else (the session's id is in `data`, never sent to a
 * browser); what is live, where and with whom is read through discovery, which checks each call's place for the reader.
 */
export const LIVE_CHANGED_EVENT = 'project.live_changed.v1';

/**
 * Records `project.live_changed.v1` in `tx` for the people who can read the space now. Agents never join a call, so they are not asked
 * about. It is the transaction's last write: the event's insert takes the sequence lock, which is held to commit.
 */
export async function recordLiveChanged(tx: Executor, change: { workspaceId: string; projectId: string; sessionId: string; actor: Principal }) {
  await recordForReaders(tx, LIVE_CHANGED_EVENT, change);
}

/**
 * Records `project.live_started.v1` (F-041): a call of the space started. The notification worker tells each of the space's other people
 * (the event's audience, read now) in their Inbox, and by push at "Everything". Record it before `recordLiveChanged`.
 */
export async function recordLiveStarted(tx: Executor, change: { workspaceId: string; projectId: string; sessionId: string; actor: Principal }) {
  await recordForReaders(tx, LIVE_STARTED_EVENT, change);
}

async function recordForReaders(tx: Executor, kind: string, change: { workspaceId: string; projectId: string; sessionId: string; actor: Principal }) {
  const events = eventPorts(tx);
  const event = { kind, workspaceId: change.workspaceId, objectId: change.projectId };
  const recipients: string[] = [];
  for (const candidate of await events.repository.candidates(change.workspaceId)) {
    if (candidate.kind === 'human' && await events.authorize(candidate, event)) recipients.push(principalKey(candidate));
  }
  if (!recipients.length) return;
  await events.repository.insert({ id: randomUUID(), kind, objectId: change.projectId,
    actorId: principalKey(change.actor), data: { sessionId: change.sessionId }, workspaceId: change.workspaceId }, recipients);
}
