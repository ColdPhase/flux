import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useRouteLoaderData } from 'react-router';
import type { MeResponse } from '@flux/contracts';
import { getMe } from '../api/auth';
import { Button } from '../ui';
import { reloadRetention, reloadRetentionRevision, subscribeReloadRetention } from './reload-retention';

type Validation = { known: boolean; actor: MeResponse | null; checking: boolean };
const identity = (actor: MeResponse | null) => actor ? `${actor.user.id}:${actor.session.id}` : 'signed-out';

/** A real document reload is offered only after current-session and volatile-work checks. */
export function ReloadRecovery() {
  const app = useRouteLoaderData('app') as { me?: MeResponse } | undefined;
  const expected = app?.me ? identity(app.me) : null;
  const location = useLocation();
  useSyncExternalStore(subscribeReloadRetention, reloadRetentionRevision, reloadRetentionRevision);
  const [validation, setValidation] = useState<Validation>({ known: false, actor: null, checking: true });
  const lifetime = useRef<{ live: boolean; request: number; controller: AbortController | null } | null>(null);

  // Install/retire the ownership token in the DOM commit, not a later passive effect. A held
  // real response cannot authorize a destructive action for an already-removed/changed view.
  useLayoutEffect(() => {
    const scope = { live: true, request: 0, controller: new AbortController() as AbortController | null };
    lifetime.current = scope;
    // Reset the check synchronously with the commit so a stale result never authorizes a reload.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValidation({ known: false, actor: null, checking: true });
    void getMe(scope.controller!.signal).then((actor) => {
      if (!scope.live || lifetime.current !== scope || scope.request !== 0) return;
      setValidation({ known: expected === null || identity(actor) === expected, actor, checking: false });
    }, () => {
      if (scope.live && lifetime.current === scope && scope.request === 0) setValidation({ known: false, actor: null, checking: false });
    });
    return () => { scope.live = false; scope.controller?.abort(); if (lifetime.current === scope) lifetime.current = null; };
  }, [expected, location.key]);

  const risk = validation.known ? reloadRetention(validation.actor?.user.id ?? null) : 'unknown';
  const safe = validation.known && !validation.checking && risk === 'safe';
  const check = async (performReload: boolean) => {
    const scope = lifetime.current;
    if (!scope?.live || validation.checking) return;
    const before = validation.known ? identity(validation.actor) : expected;
    const retainedRevision = reloadRetentionRevision();
    const request = ++scope.request;
    scope.controller?.abort();
    scope.controller = new AbortController();
    setValidation((old) => ({ ...old, checking: true }));
    try {
      const actor = await getMe(scope.controller.signal);
      const current = () => scope.live && lifetime.current === scope && request === scope.request;
      if (!current()) return;
      const known = (expected === null || identity(actor) === expected) && (before === null || identity(actor) === before);
      const unchanged = retainedRevision === reloadRetentionRevision();
      setValidation({ known: known && (!performReload || unchanged), actor, checking: false });
      if (performReload && current() && known && unchanged && reloadRetention(actor?.user.id ?? null) === 'safe') window.location.reload();
    } catch {
      if (scope.live && lifetime.current === scope && request === scope.request) setValidation({ known: false, actor: null, checking: false });
    }
  };
  return <div className="reload-recovery">
    {risk === 'blocked' ? <p role="status">Keep this tab open. Some unsent work stays only in this visit. Return to your work before reloading.</p>
      : risk === 'unknown' ? <p role="status">Reload isn’t available until this tab’s work and session can be checked. Keep this tab open and return to your work.</p> : null}
    <Button variant="primary" size="lg" icon="refresh" disabled={!safe} busy={validation.checking} onClick={() => void check(true)}>Reload Flux</Button>
    {!validation.known && !validation.checking ? <Button variant="quiet" onClick={() => void check(false)}>Check again</Button> : null}
  </div>;
}
