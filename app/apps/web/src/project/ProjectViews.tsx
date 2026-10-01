import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Sketch } from '@flux/contracts';
import { Button, EmptyState, Icon, Spinner, useToast } from '../ui';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { when } from '../sketch/format';
import { createProjectSketch, listProjectSketches, useProjectShell } from './data';
import '../sketch/sketch.css';
import './project.css';

const PAGE = 50;

/**
 * The project's Map tab (#117): the sketches everyone in the project can see, newest change
 * first, and "New sketch", which starts one for this project's audience. A sketch opens inside
 * the project, so the view tabs and the audience stay in place. Private sketches stay under
 * Home's Map; nothing private appears here.
 */
export function ProjectMap() {
  const shell = useProjectShell()!;
  const { project } = shell;
  const { me } = useShellData();
  const navigate = useNavigate();
  const toast = useToast();
  const writable = project.access !== 'viewer';
  const [state, setState] = useState<{ items: Sketch[]; total: number } | 'loading' | 'failed'>(shell.sketches ?? 'loading');
  const [pages, setPages] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const attempt = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const items: Sketch[] = [];
      let total = 0;
      for (let page = 0; page < pages; page += 1) {
        const loaded = await listProjectSketches(project.workspaceId, project.id, PAGE, page * PAGE, controller.signal);
        items.push(...loaded.items); total = loaded.total;
        if ((page + 1) * PAGE >= loaded.total) break;
      }
      setState({ items, total });
    })().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState((current) => (typeof current === 'object' ? current : 'failed'));
    });
    return () => controller.abort();
  }, [project.id, project.workspaceId, pages, refresh]);

  useStreamEvents(me.user.id, (event) => { if (event.objectType === 'sketch') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));

  const start = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // A retry after a lost answer reuses the key, so it never makes two sketches.
      const sketch = await createProjectSketch(project.workspaceId, project.id, 'Untitled sketch', attempt.current);
      attempt.current = crypto.randomUUID();
      navigate(`/projects/${project.id}/map/${sketch.id}`, { state: { fresh: true } });
    } catch {
      toast({ message: 'The sketch couldn’t be created. Try again in a moment.', tone: 'danger' });
      setCreating(false);
    }
  };

  const action = writable ? <Button variant="primary" icon="plus" busy={creating} onClick={() => void start()}>New sketch</Button> : null;

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
            <EmptyState icon="map" title={`Sketch ideas for ${project.name}`} action={action}>
              <p>A map is for thinking out loud together: put thoughts down, connect one idea to several options, and move them around. Nothing on a map has to become work.</p>
              <p>Everyone in {project.name} can see a sketch made here.</p>
            </EmptyState>
          </div>
        ) : null}
        {typeof state === 'object' && state.items.length ? (
          <>
            <div className="sk-index-head">
              <div>
                <h2>Sketches</h2>
                <p className="pv-lead"><Icon name="people" size={13} />Everyone in {project.name} can see these</p>
              </div>
              {action}
            </div>
            <ul className="sk-index" aria-label={`Sketches in ${project.name}`}>
              {state.items.map((sketch) => (
                <li key={sketch.id}>
                  <Link to={`/projects/${project.id}/map/${sketch.id}`} className="sk-index__item">
                    <Icon name="map" size={16} />
                    <span className="sk-index__b">
                      <span className="sk-index__t">{sketch.title}</span>
                      <span className="sk-index__s">Started by {sketch.createdBy.id === me.user.id ? 'you' : sketch.createdBy.name} · changed {when(sketch.updatedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="pv-note">A sketch is for thinking out loud: one idea can link to several options, and nothing on it has to become work. Link a thought from work or a decision to see it in Details.</p>
            {state.items.length < state.total ? (
              <div className="sk-index-more">
                <Button onClick={() => setPages((n) => n + 1)}>Show more sketches</Button>
                <span className="sk-index__s">Showing {state.items.length} of {state.total}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
