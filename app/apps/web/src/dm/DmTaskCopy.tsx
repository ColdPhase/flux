import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DmMessage, DmPerson, DmTaskCopyPreview, DmTaskCopyResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { copyDmToTask, previewDmTaskCopy } from '../api/direct-messages';
import { Button, Icon, Overlay, useMediaQuery, MEDIA, Select, Option } from '../ui';

/**
 * Create a task from a private message (#537). Nothing is written until "Create task": first the person sees the
 * exact text that would be copied, the project, and everyone who could open the task there. Cancel and close write
 * nothing. The copy keeps no link back to this conversation.
 */
export function DmTaskCopy({ dmId, message, excerpt, participants, onClose, onCreated, onUnavailable }: {
  dmId: string; message: DmMessage; excerpt: string | undefined;
  /** The conversation's current participants, to tell who in the audience is not in it. */
  participants: readonly DmPerson[];
  onClose: () => void; onCreated: (result: DmTaskCopyResult) => void; onUnavailable: (cause: unknown) => void;
}) {
  const phone = useMediaQuery(MEDIA.navDrawer);
  const titleId = useId();
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<DmTaskCopyPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ token: string; key: string; command: string } | null>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    previewDmTaskCopy(dmId, { messageId: message.id, ...(excerpt ? { excerpt } : {}), ...(projectId ? { projectId } : {}) }, controller.signal)
      .then((next) => { setPreview(next); setLoading(false); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 401 || cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) { onUnavailable(cause); onClose(); return; }
        setLoading(false);
        setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'The preview could not load. Close this and try again.');
      });
    return () => controller.abort();
    // The preview is re-read only for another project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId, message.id, excerpt, projectId]);

  const inDm = useMemo(() => new Set(participants.map((p) => p.id)), [participants]);
  const outside = preview?.audience.filter((person) => person.kind === 'human' && !inDm.has(person.id)) ?? [];

  async function create() {
    if (!preview?.project || busy) return;
    // A retry of the same preview reuses its identities, so a lost response never makes a second task.
    if (attempt.current?.token !== preview.token) attempt.current = { token: preview.token, key: crypto.randomUUID(), command: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await copyDmToTask(dmId, { messageId: message.id, excerpt: preview.excerpt, projectId: preview.project.id, token: preview.token, clientCommandId: attempt.current.command }, attempt.current.key);
      onCreated(result);
    } catch (cause) {
      setBusy(false);
      if (cause instanceof ApiError && cause.code === 'TASK_COPY_CHANGED') {
        const fresh = (cause.body as { preview?: DmTaskCopyPreview } | null)?.preview;
        if (fresh) { setPreview(fresh); setNotice('Who can see the task changed. Check the list again before you create it.'); return; }
      }
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 401 || cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) { onUnavailable(cause); onClose(); return; }
      setError(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? cause.message : 'The task was not created. Try again.');
    }
  }

  return (
    <Overlay open placement={phone ? 'bottom' : 'center'} labelledBy={titleId} onClose={onClose} className="dm-copy" initialFocus={confirm}>
      <section className="dm-copy__in" aria-busy={loading || busy}>
        <h2 id={titleId}>Create a task from this message</h2>
        {loading && !preview ? <p className="dm-copy__muted" role="status">Checking who could see it…</p> : null}
        {preview ? (
          <>
            <blockquote className="dm-copy__quote" aria-label="Text that will be copied">{preview.excerpt}</blockquote>
            {preview.project ? (
              <>
                <div className="dm-copy__row">
                  <span className="dm-copy__label">Project</span>
                  {preview.projects.length > 1 ? (
                    <Select aria-label="Project" value={preview.project.id} disabled={busy} onChange={(next) => { setNotice(''); setError(''); setLoading(true); setProjectId(next); }}>
                      {preview.projects.map((project) => <Option key={project.id} value={project.id}>{project.name}</Option>)}
                    </Select>
                  ) : <b>{preview.project.name}</b>}
                </div>
                <div className="dm-copy__row dm-copy__audience" data-audience={preview.audience.length}>
                  <span className="dm-copy__label"><Icon name="lock" size={12} /> Who will see it</span>
                  <span className="dm-copy__people">{preview.audience.map((person) => person.name).join(', ')}</span>
                </div>
                {outside.length ? <p className="dm-copy__warn">{outside.length === 1 ? `${outside[0]!.name} is` : `${outside.length} people are`} not in this conversation and will read this text.</p> : null}
                <p className="dm-copy__muted">Only the text above is copied. The task does not link back to this conversation, and later changes here do not reach it.</p>
              </>
            ) : <p className="dm-copy__warn">You can’t add tasks to any project yet, so this text can’t be copied.</p>}
          </>
        ) : null}
        {notice ? <p className="dm-copy__notice" role="status">{notice}</p> : null}
        {error ? <p className="dm-copy__error" role="alert"><Icon name="alert" size={13} /> {error}</p> : null}
        <footer className="dm-copy__actions">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          {preview?.project ? <Button ref={confirm} variant="primary" busy={busy} disabled={loading} onClick={() => void create()}>Create task</Button> : null}
        </footer>
      </section>
    </Overlay>
  );
}
