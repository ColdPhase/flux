import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { getProject } from '../project/api';
import { Button, useToast } from '../ui';
import { getDoc } from './api';

/**
 * Whether the page was deleted (#941): the space still answers and the page does not. A person who lost the space gets a 404
 * for the space too, which says nothing about the page, so that stays "access ended".
 */
export async function pageIsDeleted(projectId: string, docId: string, signal?: AbortSignal): Promise<boolean> {
  try { await getProject(projectId, signal); } catch { return false; }
  try { await getDoc(docId, signal); return false; } catch (cause) { return cause instanceof ApiError && cause.status === 404; }
}

/**
 * Tells an open page that it was deleted. A space's `project.doc_deleted.v1` event, or the editor's own sign that the server
 * stopped answering for the page (`suspect`), asks the server; the answer stays. `checking` holds back the "access ended"
 * wording for the moment the question takes.
 */
export function usePageGone(projectId: string, docId: string, userId: string, suspect: boolean) {
  const [gone, setGone] = useState(false);
  const [heard, setHeard] = useState(0);
  const [checking, setChecking] = useState(false);
  useStreamEvents(userId, (event) => { if (event.kind === 'project.doc_deleted.v1' && event.objectId === projectId) setHeard((count) => count + 1); });
  const asking = !gone && (suspect || heard > 0);
  useEffect(() => {
    if (!asking) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecking(true);
    void pageIsDeleted(projectId, docId, controller.signal).then((deleted) => {
      if (controller.signal.aborted) return;
      if (deleted) setGone(true);
      setChecking(false);
    });
    return () => { controller.abort(); setChecking(false); };
  }, [asking, heard, projectId, docId]);
  return { gone, checking: checking && !gone };
}

/**
 * What an open page becomes when someone deletes it: one plain line, no editor, and the way back to the Wiki. Text this person
 * typed during the visit is theirs to take, since the page and its versions are gone for everyone.
 */
export function PageGone({ projectName, projectId, title, mine }: { projectName: string; projectId: string; title: string; mine: string | null }) {
  const toast = useToast();
  const area = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(mine ?? ''); toast({ message: 'Your text is copied.', tone: 'success' }); }
    catch { area.current?.select(); toast({ message: 'Select the text and copy it.' }); }
  }
  return (
    <div className="wiki-page wiki-empty" data-page-gone="">
      <div role="alert">
        <h2 className="wiki-empty__t">This page was deleted</h2>
        <p className="doc-muted">Someone deleted “{title}” from {projectName}. It is gone for everyone, with its earlier versions.</p>
      </div>
      {mine ? (
        <section className="wiki-gone__mine" aria-label="Your text from this page">
          <p>You were writing here. Your text is kept in this tab until you close it.</p>
          <textarea ref={area} aria-label="Your text from the deleted page" readOnly value={mine} rows={8} />
          <Button variant="secondary" onClick={() => void copy()}>Copy my text</Button>
        </section>
      ) : null}
      <div className="wiki-empty__acts">
        <Link className="ui-btn ui-btn--primary" to={`/projects/${projectId}/docs`}>Back to the Wiki</Link>
      </div>
    </div>
  );
}
