import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { UNTITLED_SKETCH, type Sketch } from '@flux/contracts';
import { Button, EmptyState, Spinner, useToast } from '../ui';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { createProjectSketch, listProjectSketches, useProjectShell } from './data';
import '../sketch/sketch.css';
import './project.css';

/**
 * The project's Map tab (#117, #1438 point 7): it opens the map, the space's most recently changed one, with the other maps in the title's
 * switcher (`MapSwitcher`); there is no list of maps to pass on every visit. A space with no map shows one empty state with "New map", which
 * starts a map for this project's audience. Private maps stay under Home's Map; nothing private appears here.
 */
export function ProjectMap() {
  const shell = useProjectShell()!;
  const { project } = shell;
  const { me } = useShellData();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState<{ items: Sketch[]; total: number } | 'loading' | 'failed'>(shell.sketches ?? 'loading');
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const attempt = useRef(crypto.randomUUID());

  useEffect(() => {
    // The space's frame already read its maps: with one to open, nothing more is asked.
    if (refresh === 0 && shell.sketches?.items[0]) return undefined;
    const controller = new AbortController();
    void listProjectSketches(project.workspaceId, project.id, 1, 0, controller.signal).then((loaded) => setState(loaded))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState((current) => (typeof current === 'object' ? current : 'failed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.workspaceId, refresh]);

  useStreamEvents(me.user.id, (event) => { if (event.objectType === 'sketch') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));

  const start = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // A retry after a lost answer reuses the key, so it never makes two sketches.
      const sketch = await createProjectSketch(project.workspaceId, project.id, UNTITLED_SKETCH, attempt.current);
      attempt.current = crypto.randomUUID();
      navigate(`/projects/${project.id}/map/${sketch.id}`, { state: { fresh: true } });
    } catch {
      toast({ message: 'The map couldn’t be created. Try again in a moment.', tone: 'danger' });
      setCreating(false);
    }
  };

  // The newest map replaces this address, so Back leaves the Map tab instead of coming to it again.
  if (typeof state === 'object' && state.items[0]) return <Navigate to={`/projects/${project.id}/map/${state.items[0].id}`} replace />;
  const action = <Button variant="primary" icon="plus" busy={creating} onClick={() => void start()}>New map</Button>;

  return (
    <div className="sk-page">
      <div className="sk sk--index">
        {state === 'loading' ? <div className="sk-page--center"><Spinner label="Opening the map" /></div> : null}
        {state === 'failed' ? (
          <div className="view-empty">
            <EmptyState icon="map" title="The map couldn’t be loaded" action={<Button onClick={() => setRefresh((n) => n + 1)}>Try again</Button>}>
              <p>Flux could not be reached. Nothing was lost.</p>
            </EmptyState>
          </div>
        ) : null}
        {typeof state === 'object' ? (
          <div className="view-empty">
            <EmptyState icon="map" title={`Map ideas for ${project.name}`} action={action}>
              <p>A map is for thinking out loud together: put thoughts down, connect one idea to several options, and move them around. Nothing on a map has to become a task.</p>
            </EmptyState>
          </div>
        ) : null}
      </div>
    </div>
  );
}
