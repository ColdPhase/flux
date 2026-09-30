import { useEffect, useState } from 'react';
import { Link, isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from 'react-router';
import { ApiError, NetworkError } from '../api/client';
import { getMe } from '../api/auth';
import { useThoughtDraft } from '../sketch/createdDraft';
import { Button, ErrorState, Spinner } from '../ui';

/** Full-page failure when the shell itself can't load (e.g. the server is unreachable). */
export function RouteErrorPage() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const retrying = revalidator.state === 'loading';
  const sketchId = /\/map\/([0-9a-f-]{36})$/i.exec(useLocation().pathname)?.[1];
  let title = 'Something went wrong';
  let body = 'Flux hit an unexpected problem while opening this page. Nothing you wrote was lost.';
  let detail: string | undefined;
  if (error instanceof NetworkError) {
    title = 'Flux can’t be reached';
    body = 'Your device couldn’t connect to the Flux server. Check your connection; this page will work again once the server answers.';
  } else if (error instanceof ApiError && error.status === 404) {
    title = 'This place isn’t available';
    body = 'It may have been moved, or you no longer have access to it.';
  } else if (isRouteErrorResponse(error)) {
    if (error.status === 404) { title = 'This page doesn’t exist'; body = 'The address may be mistyped, or what it pointed to was moved.'; }
    detail = `${error.status} ${error.statusText}`;
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <main className="page-center">
      <ErrorState level={1} title={title} detail={detail}
        actions={<>
          <Button variant="primary" size="lg" icon={retrying ? undefined : 'refresh'} busy={retrying} onClick={() => revalidator.revalidate()}>Try again</Button>
          <Link className="ui-btn ui-btn--quiet ui-btn--lg" to="/">Go to Home</Link>
        </>}>
        <p>{body}</p>
        {sketchId ? <PrivateThoughtRecovery sketchId={sketchId} /> : null}
      </ErrorState>
    </main>
  );
}

/** A parent route can fail before the sketch mounts. Authenticate before reading private text. */
function PrivateThoughtRecovery({ sketchId }: { sketchId: string }) {
  const [personId, setPersonId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getMe(controller.signal).then((me) => setPersonId(me?.user.id ?? null), () => setPersonId(null));
    return () => controller.abort();
  }, []);
  const capture = useThoughtDraft(personId ?? '', sketchId, null);
  if (!personId || !capture.draft) return null;
  return <div className="ui-field">
    <label>Your private thought draft<textarea className="ui-input" aria-label="Recoverable thought draft" readOnly value={capture.draft.text} /></label>
    <Button variant="secondary" onClick={() => capture.set(null)}>Discard draft</Button>
  </div>;
}

/** Shown while the session is restored on a full load; appears only if that takes a moment. */
export function Booting() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 400);
    return () => window.clearTimeout(timer);
  }, []);
  return <main className="page-center booting" aria-busy="true">{visible ? <p className="booting__msg"><Spinner /> Opening Flux…</p> : null}</main>;
}
