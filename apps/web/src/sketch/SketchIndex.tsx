import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Sketch } from '@flux/contracts';
import { Button, EmptyState, Icon, Spinner, useToast } from '../ui';
import * as api from '../api/sketches';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { audience, when } from './format';
import './sketch.css';

interface Listed { sketch: Sketch; projectName: string | null }

/** Every sketch the person can see, across their workspaces, newest change first. */
async function loadSketches(signal: AbortSignal): Promise<{ items: Listed[]; workspaceId: string | null }> {
  const workspaces = await api.listWorkspaces(signal);
  const items: Listed[] = [];
  for (const workspace of workspaces) {
    const [sketches, projects] = await Promise.all([api.listSketches(workspace.id, signal), api.listProjects(workspace.id, signal)]);
    const names = new Map(projects.items.map((p) => [p.id, p.name]));
    for (const sketch of sketches.items) items.push({ sketch, projectName: sketch.projectId ? names.get(sketch.projectId) ?? null : null });
  }
  items.sort((a, b) => b.sketch.updatedAt.localeCompare(a.sketch.updatedAt));
  return { items, workspaceId: workspaces[0]?.id ?? null };
}

/**
 * The Map tab at `/map`: your sketches as a calm list, and a way to start a new one. A new
 * sketch is private (only you) until it is shared; it opens with its name ready to type.
 */
export function SketchIndex() {
  const { me } = useShellData();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState<{ items: Listed[]; workspaceId: string | null } | 'loading' | 'failed'>('loading');
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadSketches(controller.signal).then(setState, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState('failed');
    });
    return () => controller.abort();
  }, [refresh]);

  useStreamEvents((event) => { if (event.objectType === 'sketch') setRefresh((n) => n + 1); });

  const start = async () => {
    if (creating || typeof state !== 'object') return;
    setCreating(true);
    try {
      // Nobody has to set up a workspace before thinking: the first sketch creates a personal one.
      const workspaceId = state.workspaceId ?? (await api.createWorkspace('Personal', crypto.randomUUID())).id;
      const sketch = await api.createPrivateSketch(workspaceId, 'Untitled sketch', crypto.randomUUID());
      navigate(`/map/${sketch.id}`, { state: { fresh: true } });
    } catch {
      toast({ message: 'The sketch couldn’t be created. Try again in a moment.', tone: 'danger' });
      setCreating(false);
    }
  };

  const action = <Button variant="primary" icon="plus" busy={creating} onClick={() => void start()}>New sketch</Button>;

  return (
    <div className="sk-page">
      <div className="sk sk--index">
        {state === 'loading' ? <div className="sk-page--center"><Spinner label="Loading sketches" /></div> : null}
        {state === 'failed' ? (
          <div className="view-empty">
            <EmptyState icon="map" title="Sketches couldn’t be loaded" action={<Button onClick={() => setRefresh((n) => n + 1)}>Try again</Button>}>
              <p>Flux could not be reached. Nothing was lost.</p>
            </EmptyState>
          </div>
        ) : null}
        {typeof state === 'object' && !state.items.length ? (
          <div className="view-empty">
            <EmptyState icon="map" title="Start a sketch" action={action}>
              <p>Maps are for thinking out loud: put thoughts down, connect them and move them around. Nothing on a map has to become work.</p>
              <p>A new sketch is private to you.</p>
            </EmptyState>
          </div>
        ) : null}
        {typeof state === 'object' && state.items.length ? (
          <>
            <div className="sk-index-head">
              <h2>Sketches</h2>
              {action}
            </div>
            <ul className="sk-index" aria-label="Your sketches">
              {state.items.map(({ sketch, projectName }) => (
                <li key={sketch.id}>
                  <Link to={`/map/${sketch.id}`} className="sk-index__item">
                    <Icon name="map" size={16} />
                    <span className="sk-index__b">
                      <span className="sk-index__t">{sketch.title}</span>
                      <span className="sk-index__s">{audience(sketch, me.user.id, projectName)} · changed {when(sketch.updatedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
