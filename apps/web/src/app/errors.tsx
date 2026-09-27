import { useEffect, useState } from 'react';
import { Link, isRouteErrorResponse, useRevalidator, useRouteError } from 'react-router';
import { NetworkError } from '../api/client';
import { Button, ErrorState, Spinner } from '../ui';

/** Full-page failure when the shell itself can't load (e.g. the server is unreachable). */
export function RouteErrorPage() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const retrying = revalidator.state === 'loading';
  let title = 'Something went wrong';
  let body = 'Flux hit an unexpected problem while opening this page. Nothing you wrote was lost.';
  let detail: string | undefined;
  if (error instanceof NetworkError) {
    title = 'Flux can’t be reached';
    body = 'Your device couldn’t connect to the Flux server. Check your connection; this page will work again once the server answers.';
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
      </ErrorState>
    </main>
  );
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
