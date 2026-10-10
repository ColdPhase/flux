import { useEffect, useState } from 'react';
import { Link, isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from 'react-router';
import { ApiError, NetworkError } from '../api/client';
import { getMe } from '../api/auth';
import { useThoughtDraft } from '../sketch/createdDraft';
import { Button, ErrorState, useMoments } from '../ui';
import { routeLabel } from './routeLabel';
import { ReloadRecovery } from './ReloadRecovery';

/** Code download/evaluation failed; retry needs a fresh document/module cache, not API revalidation. */
export class RouteCodeLoadError extends Error {
  constructor(cause: unknown) { super('The page code could not be loaded', { cause }); this.name = 'RouteCodeLoadError'; }
}

/** Full-page failure when the shell itself can't load (e.g. the server is unreachable). */
export function RouteErrorPage() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const retrying = revalidator.state === 'loading';
  const sketchId = /\/map\/([0-9a-f-]{36})$/i.exec(useLocation().pathname)?.[1];
  const destination = routeLabel(useLocation().pathname);
  const codeUnavailable = error instanceof RouteCodeLoadError;
  const unreachable = error instanceof NetworkError;
  // "This page will work again once the server answers": when the device is back online, and every
  // 10 s while the page is visible, it tries again by itself.
  useEffect(() => {
    if (!unreachable) return;
    const retry = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) revalidator.revalidate(); };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 10_000);
    return () => { window.removeEventListener('online', retry); window.clearInterval(timer); };
  }, [unreachable, revalidator]);
  let title = 'Something went wrong';
  let body = 'Flux hit an unexpected problem while opening this page. You can return to Home and try again.';
  let detail: string | undefined;
  if (codeUnavailable) {
    title = 'This page couldn’t be loaded';
    body = `Flux couldn’t open ${destination}. Check your connection. Return to your work or reload when this tab can do so safely.`;
  } else if (error instanceof NetworkError) {
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
          {codeUnavailable
            ? <ReloadRecovery />
            : <Button variant="primary" size="lg" icon={retrying ? undefined : 'refresh'} busy={retrying} onClick={() => revalidator.revalidate()}>Try again</Button>}
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

/**
 * Shown while the session is restored on a full load. The splash is the markup index.html already shows, so the
 * hand-over from the static page to React is invisible. With small moments off it is the plain line, at once.
 */
export function Booting() {
  const moments = useMoments();
  if (!moments) {
    return (
      <main className="page-center booting" aria-busy="true">
        <div className="boot boot--plain" role="status"><p className="boot__text">Opening Flux…</p></div>
      </main>
    );
  }
  return (
    <main className="page-center booting" aria-busy="true">
      <div className="boot boot--moment" role="status" aria-label="Opening Flux">
        <div className="boot__lockup">
          <svg className="boot__logo" viewBox="0 0 24 24" width="56" height="56" aria-hidden="true"><path d="M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z" className="boot__tile"/><g className="boot__face" transform="translate(12 12) scale(1.14) translate(-12 -12.4)" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.3 11.2V13.8M14.7 11.2V13.8"/><path d="M7.3 8.1 10.5 7.2" strokeWidth="1.55"/></g></svg>
          <b>flux</b>
        </div>
        <i className="boot__bar" aria-hidden="true"><u /></i>
      </div>
    </main>
  );
}
