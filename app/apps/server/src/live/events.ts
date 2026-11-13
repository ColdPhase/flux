import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { CALL_NOTICE_PAUSE_MINUTES } from '@flux/contracts';
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
 * (the event's audience, read now) in their Inbox, and by push at "Everything". Record it before `recordLiveChanged`. Not again for the
 * same starter and the same place within `CALL_NOTICE_PAUSE_MINUTES` of the last notice (#1347): the call starts all the same, and shows
 * its Join in the space, but its people are not told twice. Returns whether it told them.
 */
export async function recordLiveStarted(tx: Executor, change: { workspaceId: string; projectId: string; sessionId: string; actor: Principal }): Promise<boolean> {
  const [repeat] = (await tx.execute(sql`
    SELECT 1 FROM events e
      JOIN live_sessions earlier ON earlier.id = (e.data->>'sessionId')::uuid
      JOIN live_sessions now_ ON now_.id = ${change.sessionId}
     WHERE e.kind = ${LIVE_STARTED_EVENT} AND e.object_id = ${change.projectId} AND e.actor_id = ${principalKey(change.actor)}
       AND e.created_at > now() - ${`${CALL_NOTICE_PAUSE_MINUTES} minutes`}::interval AND earlier.id <> now_.id
       AND earlier.conversation_id IS NOT DISTINCT FROM now_.conversation_id AND earlier.work_id IS NOT DISTINCT FROM now_.work_id
       AND earlier.sketch_id IS NOT DISTINCT FROM now_.sketch_id AND earlier.doc_id IS NOT DISTINCT FROM now_.doc_id
     LIMIT 1`)).rows;
  if (repeat) return false;
  await recordForReaders(tx, LIVE_STARTED_EVENT, change);
  return true;
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
