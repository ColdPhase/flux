import { useEffect, useState } from 'react';
import { Link, Navigate, isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from 'react-router';
import { ApiError, NetworkError } from '../api/client';
import { getMe } from '../api/auth';
import { useThoughtDraft } from '../sketch/createdDraft';
import { Button, ErrorState, Spinner } from '../ui';
import { routeLabel } from './routeLabel';
import { ReloadRecovery } from './ReloadRecovery';
import { getProject } from './conversation-api';
import { useReturning } from '../place/memory';

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
  // Back, Forward or the way back to a project place that is gone or no longer allowed: not an error page (#592).
  const revoked = (error instanceof ApiError || isRouteErrorResponse(error)) && (error.status === 403 || error.status === 404);
  const pathname = useLocation().pathname;
  const returning = useReturning() && revoked && /^\/(projects|materials|dm)\/[0-9a-f-]{36}/i.test(pathname);
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
  if (returning) return <NearestAccessible pathname={pathname} />;
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

/**
 * The place a return led to is gone or closed to this person: they land on the nearest parent they can open, with one short
 * line saying so. Never an error page (#592). A place in a project goes to that project's conversation, or the project list
 * when the project is closed too; a material (whose project can no longer be read) goes to the project list; a direct
 * message goes to the list of conversations.
 */
function NearestAccessible({ pathname }: { pathname: string }) {
  if (/^\/materials\//.test(pathname)) return <Navigate to="/projects" replace state={{ note: 'That page is no longer available to you.' }} />;
  if (/^\/dm\//.test(pathname)) return <Navigate to="/dm" replace state={{ note: 'That conversation is no longer available to you.' }} />;
  return <NearestProject pathname={pathname} />;
}

function NearestProject({ pathname }: { pathname: string }) {
  const project = /^\/projects\/([0-9a-f-]{36})/i.exec(pathname)![1]!;
  const inside = !new RegExp(`^/projects/${project}/?$`, 'i').test(pathname);
  const lost = { to: '/projects', note: 'That project is no longer available to you.' };
  const [checked, setChecked] = useState<{ to: string; note: string } | null>(null);
  useEffect(() => {
    if (!inside) return;
    const controller = new AbortController();
    getProject(project, controller.signal).then(
      () => { if (!controller.signal.aborted) setChecked({ to: `/projects/${project}`, note: 'That place is no longer available to you. Here is the conversation.' }); },
      () => { if (!controller.signal.aborted) setChecked(lost); });
    return () => controller.abort();
    // `lost` is a constant of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, inside]);
  const target = inside ? checked : lost;
  return target ? <Navigate to={target.to} replace state={{ note: target.note }} />
    : <main className="page-center booting" aria-busy="true"><p className="booting__msg" role="status"><Spinner /> Opening the nearest place you can open…</p></main>;
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

/** Initial navigation waits for the actual session and matched route; no authenticated shell is invented. */
export function Booting() {
  return <main className="page-center booting" aria-busy="true"><p className="booting__msg" role="status"><Spinner /> Opening {routeLabel(window.location.pathname)}…</p></main>;
}
