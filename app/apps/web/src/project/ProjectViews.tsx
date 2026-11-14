import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { UNTITLED_SKETCH, type Sketch } from '@flux/contracts';
import { Button, EmptyState, Icon, MEDIA, Spinner, useMediaQuery, useToast } from '../ui';
import { DockRow } from '../sketch/DockRow';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { createProjectSketch, listProjectSketches, useProjectShell } from './data';
import '../sketch/sketch.css';
import './project.css';

/**
 * The project's Map tab (#117, #1438 point 7, #1424): it opens the map, the space's most recently changed one, with the other maps in the title's
 * switcher (`MapSwitcher`); there is no list of maps to pass on every visit. A space with no map opens the map's own empty canvas, and the map is
 * made, silently, when the first thought is added: nothing to name or start first. Private maps stay under Home's Map; nothing private appears here.
 */
export function ProjectMap() {
  const shell = useProjectShell()!;
  const { project } = shell;
  const { me } = useShellData();
  const navigate = useNavigate();
  const toast = useToast();
  const phone = useMediaQuery(MEDIA.phone);
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

  // The first thought makes the map: the map opens with a draft thought ready to type, as "Add to map" from a message does.
  const start = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // A retry after a lost answer reuses the key, so it never makes two maps.
      const sketch = await createProjectSketch(project.workspaceId, project.id, UNTITLED_SKETCH, attempt.current);
      attempt.current = crypto.randomUUID();
      navigate(`/projects/${project.id}/map/${sketch.id}`, { replace: true, state: { addThoughtFromMessage: { projectId: project.id, body: '' } } });
    } catch {
      toast({ message: 'The map couldn’t be created. Try again in a moment.', tone: 'danger' });
      setCreating(false);
    }
  };

  // The newest map replaces this address, so Back leaves the Map tab instead of coming to it again.
  if (typeof state === 'object' && state.items[0]) return <Navigate to={`/projects/${project.id}/map/${state.items[0].id}`} replace />;

  if (state === 'loading') return <div className="sk-page"><div className="sk sk--index"><div className="sk-page--center"><Spinner label="Opening the map" /></div></div></div>;
  if (state === 'failed') {
    return (
      <div className="sk-page"><div className="sk sk--index"><div className="view-empty">
        <EmptyState icon="map" title="The map couldn’t be loaded" action={<Button onClick={() => setRefresh((n) => n + 1)}>Try again</Button>}>
          <p>Flux could not be reached. Nothing was lost.</p>
        </EmptyState>
      </div></div></div>
    );
  }
  // The map's own frame with nothing on it: the same header pill, canvas, hint and Thought button the made map has (and on the phone its one button).
  return (
    <div className="sk-page sk-page--map" data-empty-map="">
      <div className="sk sk--map">
        <div className="sk-canvas-wrap"><div className="sk-canvas" onDoubleClick={() => void start()} /></div>
        <div className="sk-over">
          <div className="sk-head"><p className="sk-lead"><span className="sk-title">{UNTITLED_SKETCH}</span></p></div>
        </div>
        <p className="sk-first">{phone ? <>An empty map. Start with <b>Add a thought</b>.</> : <>An empty map. Add the first thought with <b>Thought</b>, then keep adding with the <b>+</b> beside it.</>}</p>
        {phone ? (
          <div className="sk-phone"><button type="button" className="sk-fab sk-add" disabled={creating} onClick={() => void start()}><Icon name="plus" size={18} />Add a thought</button></div>
        ) : (
          <div className="sk-dock"><DockRow>
            <div className="sk-tools" role="toolbar" aria-label="Map tools">
              <button type="button" className="ui-btn ui-btn--quiet sk-add" disabled={creating} onClick={() => void start()}><Icon name="plus" size={16} />Thought</button>
            </div>
          </DockRow></div>
        )}
      </div>
    </div>
  );
}
