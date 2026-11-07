import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import { Button, EmptyState, Spinner } from '../ui';
import { useShellData } from '../app/data';
import { openMyMap } from '../api/sketches';
import { sketchHref } from './format';
import './sketch.css';

/**
 * `/map`: My map (#866), the person's one private map; the Sketchbook and its "Your notes" became thoughts on it. It is found
 * among their private maps, or made the first time it is opened, and then shown at its own address, where every map is shown.
 * Nothing is listed: there is one map, and its thoughts are what it holds.
 */
export function MyMap() {
  const { workspace } = useShellData();
  const [state, setState] = useState<{ to: string } | 'loading' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  // A retry after a lost answer reuses the key, so it never makes two maps.
  const key = useRef(crypto.randomUUID());
  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!workspaceId) return undefined;
    const controller = new AbortController();
    void (async () => {
      const mine = await openMyMap(workspaceId, key.current, controller.signal);
      setState({ to: sketchHref(mine) });
    })().catch(() => { if (!controller.signal.aborted) setState('failed'); });
    return () => controller.abort();
  }, [workspaceId, attempt]);

  if (!workspaceId) {
    return <div className="view-empty"><EmptyState icon="map" title="My map isn’t here yet"><p>You’re not in a company on this Flux yet. Ask an admin for an invite link.</p></EmptyState></div>;
  }
  if (state === 'failed') {
    return (
      <div className="view-empty">
        <EmptyState icon="map" title="My map couldn’t be opened" action={<Button onClick={() => { setState('loading'); setAttempt((n) => n + 1); }}>Try again</Button>}>
          <p>Flux could not be reached. Nothing was lost.</p>
        </EmptyState>
      </div>
    );
  }
  if (state === 'loading') return <div className="sk-page sk-page--center"><Spinner label="Opening My map" /></div>;
  return <Navigate replace to={state.to} />;
}
