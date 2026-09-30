import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { EmptyState, Spinner } from '../ui';
import { anchorPath } from './anchors';
import { getSession } from './api';

/**
 * `/projects/:projectId/live/:sessionId` — the link of an invitation in the inbox (#116/#62).
 * It opens the work the session is about, with the invitation as one quiet card there.
 * Access is checked again now; an ended or hidden session says so without details.
 */
export function LiveOpen() {
  const { projectId = '', sessionId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const invitationId = search.get('invitation');

  useEffect(() => {
    const controller = new AbortController();
    getSession(sessionId, controller.signal).then((session) => {
      if (session.projectId !== projectId || session.state === 'ended' || session.state === 'ending') { setFailed(true); return; }
      navigate(anchorPath(session), { replace: true, state: invitationId ? { liveInvitation: { sessionId: session.id, invitationId } } : null });
    }, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    });
    return () => controller.abort();
  }, [projectId, sessionId, invitationId, navigate]);

  if (!failed) return <div className="sk-page--center"><Spinner label="Opening the session" /></div>;
  return (
    <div className="view-empty pane-in">
      <EmptyState icon="together" title="This session is no longer open" action={<Link className="ui-btn ui-btn--secondary" to={`/projects/${projectId}`}>Open the project</Link>}>
        <p>Everyone may have left, or you can no longer see where it took place. Anything people saved is in the project as usual.</p>
      </EmptyState>
    </div>
  );
}
