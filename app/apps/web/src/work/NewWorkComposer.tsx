import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import { useDraft } from '../app/drafts';
import { useShellActions } from '../app/shellContext';
import { Button } from '../ui';
import { createWork } from './api';

/** Private account/project draft; editing this component does not reconcile the task list. */
/** `folded`: shown only once asked for ("+" on a phone, #318) or while it holds a draft, a pending add or an error. */
export function NewWorkComposer({ userId, projectId, folded = false }: { userId: string; projectId: string; folded?: boolean }) {
  const draft = useDraft(userId, `project-work:${projectId}`);
  // An uncertain native response can be retried after source/back or reload with the same key.
  const pending = useDraft(userId, `project-work:${projectId}:pending`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    const original = draft.text;
    const revision = draft.revision;
    const title = original.trim();
    if (!title || busy) return;
    let attempt = crypto.randomUUID() as string;
    try {
      const previous: unknown = JSON.parse(pending.text);
      if (previous && typeof previous === 'object' && 'title' in previous && previous.title === title &&
        'key' in previous && typeof previous.key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previous.key)) attempt = previous.key;
    } catch { /* No valid pending command for this title. */ }
    const command = JSON.stringify({ title, key: attempt });
    const pendingRevision = pending.setText(command);
    setBusy(true); setError('');
    try {
      const item = await createWork(projectId, { title }, attempt);
      // Keep the matching replay key while denied removal leaves submitted text on disk.
      // All mounted subscribers see a successful clear; an intervening edit never clears.
      if (draft.clearIfMatches(original, revision) === 'device') pending.clearIfMatches(command, pendingRevision);
      if (mounted.current) {
        revalidator.revalidate();
        openDetails({ kind: 'work', id: item.id });
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not add the task.');
    } finally { if (mounted.current) setBusy(false); }
  }

  if (folded && !draft.text && !busy && !error) return null;
  return <>
    <form className="ws-add" onSubmit={(event) => void add(event)}>
      <label className="ui-vh" htmlFor="ws-add">New task</label>
      <input id="ws-add" className="ui-input" value={draft.text} maxLength={200} disabled={busy}
        aria-describedby={draft.text || draft.storage === 'visit' ? 'ws-draft-state' : undefined}
        placeholder="Add a task, e.g. Order a ToF sensor"
        onChange={(event) => { draft.setText(event.target.value); pending.clear(); setError(''); }} />
      <Button type="submit" variant="secondary" icon="plus" busy={busy} disabled={!draft.text.trim()}>Add task</Button>
    </form>
    {draft.text || draft.storage === 'visit' ? <p id="ws-draft-state" className="ws-draft-state" role="status">
      {draft.storage === 'visit' || (pending.text && pending.storage === 'visit')
        ? draft.text ? 'Draft kept for this visit. Reloading may lose it.'
          : 'Draft changes are kept for this visit. Reloading may restore older text.'
        : 'Draft kept on this device'}
    </p> : null}
    {error ? <p className="wd-error" role="alert">{error}</p> : null}
  </>;
}
