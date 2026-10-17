import { useState } from 'react';
import type { AssistantBackgroundNote, AssistantRun } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { Button } from '../ui';
import { createSchedule, getBackgroundNote, type ScheduleScope } from './scheduleApi';

// "Do it at 14:00" next to a plan limit (F-027 AST-7 "Do it later", Journey 6): a one-off schedule of the same request, made by the
// owner's tap. It posts in the conversation the request came from, runs once at the plan's reset time and turns itself off. A
// subscription account that has not seen the note about background use sees it first; the second tap is the owner's Turn on.

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function DoItAt({ run, onDone }: { run: AssistantRun; onDone: () => void }) {
  const { me } = useShellData();
  const [note, setNote] = useState<AssistantBackgroundNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const scope: ScheduleScope = { workspaceId: run.workspaceId, ownerId: me.user.id };
  const at = run.planLimitResetsAt!;
  const time = clock(at);
  async function tap() {
    setBusy(true); setError('');
    try {
      const noteNow = note ?? await getBackgroundNote(scope);
      // The note shows once per account, before activation (AST-2.1): this tap shows it, the next one turns the schedule on.
      if (noteNow.note !== null && !note) { setNote(noteNow); return; }
      await createSchedule(scope, {
        projectId: run.projectId, text: run.prompt, schedule: { kind: 'once', at }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        postToConversation: true, conversationId: run.conversationId, ...(noteNow.note !== null ? { noteVersion: noteNow.version } : {}),
      });
      setDone(true);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Couldn’t schedule that. Try again.');
    } finally { setBusy(false); }
  }
  if (done) return <span role="status">I’ll do it at {time}. <Button variant="quiet" onClick={onDone}>Dismiss</Button></span>;
  return (
    <>
      {note?.note ? <span className="assistant-working__note">{note.note}</span> : null}
      <Button variant="secondary" busy={busy} onClick={() => void tap()}>Do it at {time}</Button>
      {error ? <span role="alert" className="assistant-working__error">{error}</span> : null}
    </>
  );
}
