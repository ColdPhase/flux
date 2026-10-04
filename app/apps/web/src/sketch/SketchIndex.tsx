import { useEffect, useState } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import type { Sketch } from '@flux/contracts';
import { Button, EmptyState, Icon, Spinner, useToast } from '../ui';
import * as api from '../api/sketches';
import { useShellData } from '../app/data';
import { ensurePersonalSpace } from '../app/personalSpace';
import { useStreamEvents } from '../api/stream';
import { audience, sketchHref, when } from './format';
import './sketch.css';

interface Listed { sketch: Sketch; projectName: string | null }
interface Loaded { items: Listed[]; total: number; workspaceId: string | null }

/** Sketches per workspace and request; the API allows up to 100. */
export const PAGE = 50;

async function projectNames(workspaceId: string, signal: AbortSignal) {
  const names = new Map<string, string>();
  for (let offset = 0; ; offset += 100) {
    const page = await api.listProjects(workspaceId, offset, signal);
    for (const project of page.items) names.set(project.id, project.name);
    if (offset + page.items.length >= page.total || !page.items.length) return names;
  }
}

/**
 * Every workspace's first `pages` pages of sketches the person can see, newest change first.
 * `total` counts all visible sketches, so the list can offer the rest instead of hiding it.
 */
async function loadSketches(pages: number, signal: AbortSignal): Promise<Loaded> {
  const workspaces = await api.listWorkspaces(signal);
  const items: Listed[] = [];
  let total = 0;
  for (const workspace of workspaces) {
    const names = await projectNames(workspace.id, signal);
    for (let page = 0; page < pages; page += 1) {
      const sketches = await api.listPrivateSketches(workspace.id, PAGE, page * PAGE, signal);
      if (page === 0) total += sketches.total;
      for (const sketch of sketches.items) items.push({ sketch, projectName: sketch.projectId ? names.get(sketch.projectId) ?? null : null });
      if ((page + 1) * PAGE >= sketches.total) break;
    }
  }
  items.sort((a, b) => b.sketch.updatedAt.localeCompare(a.sketch.updatedAt));
  return { items, total, workspaceId: workspaces[0]?.id ?? null };
}

/**
 * The Map tab at `/map`: your sketches as a calm list, and a way to start a new one. A new
 * sketch is private (only you) until it is shared; it opens with its name ready to type.
 */
export function SketchIndex() {
  const { me, directMessages } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const [state, setState] = useState<Loaded | 'loading' | 'failed'>('loading');
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadSketches(pages, controller.signal).then((loaded) => { setState(loaded); setMore(false); }, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState('failed');
    });
    return () => controller.abort();
  }, [refresh, pages]);

  useStreamEvents(me.user.id, (event) => { if (event.objectType === 'sketch') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));

  const start = async () => {
    if (creating || typeof state !== 'object') return;
    setCreating(true);
    try {
      // Nobody has to set up a workspace before thinking: the first sketch creates the personal space,
      // the same one a first Home note would (#190 HOME-3), and the shell learns about it.
      const workspaceId = state.workspaceId ?? (await ensurePersonalSpace(me.user.id)) ?? (await api.listWorkspaces())[0]!.id;
      if (!state.workspaceId) revalidator.revalidate();
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
                  <Link to={sketchHref(sketch)} className="sk-index__item">
                    <Icon name="map" size={16} />
                    <span className="sk-index__b">
                      <span className="sk-index__t">{sketch.title}</span>
                      <span className="sk-index__s">{sketch.scope === 'dm' ? `${directMessages.find((dm) => dm.id === sketch.dmId)?.audience ?? 'A direct message'}, in a direct message` : audience(sketch, me.user.id, projectName)} · changed {when(sketch.updatedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {state.items.length < state.total ? (
              <div className="sk-index-more">
                <Button busy={more} onClick={() => { setMore(true); setPages((n) => n + 1); }}>Show more sketches</Button>
                <span className="sk-index__s">Showing {state.items.length} of {state.total}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
