import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, isRouteErrorResponse, useLocation, useMatches, useRevalidator, useRouteError } from 'react-router';
import { ApiError, NetworkError } from '../api/client';
import { getMe } from '../api/auth';
import { useThoughtDraft } from '../sketch/createdDraft';
import { Button, ErrorState, Spinner } from '../ui';
import { routeLabel } from './routeLabel';
import { ReloadRecovery } from './ReloadRecovery';
import { getProject } from '../project/api';
import { NavigateWithNote } from './NavigateWithNote';
import { spaceLost, useReturning } from '../place/memory';
import { isWorkspaceLocked, lockedWorkspaceId } from '../encryption/api';
import { LockedSpace } from '../encryption/LockedSpace';
import { NotAvailable } from './NotAvailable';

/** Code download/evaluation failed; retry needs a fresh document/module cache, not API revalidation. */
export class RouteCodeLoadError extends Error {
  constructor(cause: unknown) { super('The page code could not be loaded', { cause }); this.name = 'RouteCodeLoadError'; }
}

/**
 * What a failed read is called in "<place> couldn’t be loaded" (#1369): the person's word for where they were, from the address.
 * One word for one place: Messages, the Wiki, the Inbox.
 */
export function placeTitle(pathname: string): string {
  if (/^\/settings\/ai-connections/.test(pathname)) return 'Your API keys';
  if (pathname.startsWith('/settings/notifications')) return 'Notification settings';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname === '/projects') return 'Spaces';
  if (pathname === '/map' || /^\/map\//.test(pathname)) return 'My map';
  if (pathname === '/tasks') return 'My tasks';
  if (/\/map(\/|$)/.test(pathname)) return 'The map';
  if (/(?:\/docs|\/materials)(\/|$)/.test(pathname)) return 'The Wiki';
  if (/\/tasks(\/|$)/.test(pathname)) return 'Tasks';
  if (/\/github(\/|$)/.test(pathname)) return 'GitHub settings';
  if (/\/live(\/|$)/.test(pathname)) return 'The call';
  if (/^\/projects\/[^/]+\/settings/.test(pathname)) return 'The space’s settings';
  if (pathname.startsWith('/inbox')) return 'The Inbox';
  if (pathname === '/dm') return 'Messages';
  if (pathname.startsWith('/dm') || pathname.startsWith('/agents')) return 'The conversation';
  if (pathname.startsWith('/projects/')) return 'The conversation';
  return 'This page';
}

/**
 * The failure of a route's read (#1369). Under the shell (every place of the app) it is said in place, as "<place> couldn’t be loaded" with
 * Try again, and the sidebar, the header and the tab bar stay. Without a shell (the shell's own read failed, or a sign-in page) it is the whole page.
 * A place that is gone or closed is the one calm "not available" page (#1371). No raw status text anywhere.
 */
function ErrorPage({ shell }: { shell: boolean }) {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const retrying = revalidator.state === 'loading';
  const sketchId = /\/map\/([0-9a-f-]{36})$/i.exec(useLocation().pathname)?.[1];
  const pathname = useLocation().pathname;
  const noun = placeTitle(pathname);
  const codeUnavailable = error instanceof RouteCodeLoadError;
  const unreachable = error instanceof NetworkError;
  // Back, Forward or the way back to a project place that is gone or no longer allowed: not an error page (#592).
  const revoked = (error instanceof ApiError || isRouteErrorResponse(error)) && (error.status === 403 || error.status === 404);
  // Or a space the person was just removed from while one of its places was open (#862): the same calm landing, not an error page.
  const space = /^\/projects\/([0-9a-f-]{36})/i.exec(pathname)?.[1];
  const back = useReturning();
  const returning = revoked && (back ? /^\/(projects|materials|dm)\/[0-9a-f-]{36}/i.test(pathname) : !!space && spaceLost(space));
  // "This page will work again once the server answers": when the device is back online, and every
  // 10 s while the page is visible, it tries again by itself.
  useEffect(() => {
    if (!unreachable) return;
    const retry = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) revalidator.revalidate(); };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 10_000);
    return () => { window.removeEventListener('online', retry); window.clearInterval(timer); };
  }, [unreachable, revalidator]);
  // When Try again brings the place back, the button that had focus goes with this page: focus moves to the place itself (`#content`), not to
  // the start of the document, so a keyboard or screen reader user goes on where they were (#1369). A place that focuses something of its own keeps it.
  const tried = useRef(false);
  useEffect(() => () => {
    if (!tried.current) return;
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) document.getElementById('content')?.focus({ preventScroll: true });
    });
  }, []);
  if (returning) return <NearestAccessible pathname={pathname} />;
  // F-030 (#655): a place whose workspace is an encrypted one that waits to be unlocked shows the locked panel, not an error.
  if (isWorkspaceLocked(error)) return <LockedSpace workspaceId={lockedWorkspaceId(error)} />;
  if (revoked) {
    const title = isRouteErrorResponse(error) && error.status === 404 ? 'This page doesn’t exist' : 'This place isn’t available';
    // A map's unsaved private thought outlives the place: the person removed from its space still reads and can discard it (#1402 kept it out).
    return <NotAvailable title={title} bare={!shell}>{sketchId ? <PrivateThoughtRecovery sketchId={sketchId} /> : null}</NotAvailable>;
  }

  const tryAgain = <Button variant={shell ? 'secondary' : 'primary'} size={shell ? 'md' : 'lg'} icon={retrying ? undefined : 'refresh'} busy={retrying} onClick={() => { tried.current = true; revalidator.revalidate(); }}>Try again</Button>;
  const home = <Link className="ui-btn ui-btn--quiet ui-btn--lg" to="/">Go to Home</Link>;
  let title: string;
  let body: string;
  let actions: ReactNode = tryAgain;
  if (codeUnavailable) {
    title = 'This page couldn’t be loaded';
    body = `Flux couldn’t open ${routeLabel(pathname)}. Check your connection. Return to your work or reload when this tab can do so safely.`;
    actions = <><ReloadRecovery />{home}</>;
  } else if (unreachable) {
    title = shell ? `${noun} couldn’t be loaded` : 'Flux can’t be reached';
    body = 'Your device couldn’t connect to the Flux server. Check your connection; this will load again once the server answers.';
  } else if (error instanceof ApiError && error.status === 429) {
    // The floor of rate limits (#838): reads already waited and asked again; this is what is left after that. Calm, no raw detail.
    title = shell ? `${noun} couldn’t be loaded` : 'Flux is busy right now';
    body = 'Too many requests came from this connection in a short time. Wait a moment and try again; nothing you wrote is lost.';
  } else if (error instanceof ApiError) {
    // A temporary answer of the server is not an unexpected problem (#1369).
    title = shell ? `${noun} couldn’t be loaded` : 'Flux isn’t answering';
    body = 'Flux didn’t answer just now. Nothing was lost; try again in a moment.';
  } else {
    title = 'Something went wrong';
    body = 'Flux hit an unexpected problem while opening this page. You can return to Home and try again.';
    actions = <>{tryAgain}{shell ? null : home}</>;
  }
  const state = (
    <ErrorState level={shell ? 2 : 1} title={title} actions={actions}>
      <p>{body}</p>
      {sketchId ? <PrivateThoughtRecovery sketchId={sketchId} /> : null}
    </ErrorState>
  );
  return shell ? <div className="pane-scroll"><div className="pane-in">{state}</div></div> : <main className="page-center">{state}</main>;
}

/** The boundary of the shell's own read, of the root and of the sign-in pages: nothing of the shell is there to keep. */
export function RouteErrorPage() {
  return <ErrorPage shell={false} />;
}

/** The boundary of every place of the app: it is said inside the shell, which stays (#1369); outside the shell it is the whole page. */
export function PlaceError() {
  const inShell = useMatches().some((match) => match.id === 'app');
  return <ErrorPage shell={inShell} />;
}

/**
 * The place a return led to is gone or closed to this person: they land on the nearest parent they can open, with one short
 * line saying so. Never an error page (#592). A place in a project goes to that project's conversation, or the project list
 * when the project is closed too; a material (whose project can no longer be read) goes to the project list; a direct
 * message goes to the list of conversations.
 */
function NearestAccessible({ pathname }: { pathname: string }) {
  if (/^\/materials\//.test(pathname)) return <NavigateWithNote to="/projects" note="That page is no longer available to you." />;
  if (/^\/dm\//.test(pathname)) return <NavigateWithNote to="/dm" note="That conversation is no longer available to you." />;
  return <NearestProject pathname={pathname} />;
}

function NearestProject({ pathname }: { pathname: string }) {
  const project = /^\/projects\/([0-9a-f-]{36})/i.exec(pathname)![1]!;
  const inside = !new RegExp(`^/projects/${project}/?$`, 'i').test(pathname);
  const lost = { to: '/projects', note: 'That space is no longer available to you.' };
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
  return target ? <NavigateWithNote to={target.to} note={target.note} />
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
