import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Sketch } from '@flux/contracts';
import { ApiError } from '../api/client';
import { createDmSketch, listDmSketches } from '../api/sketches';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Button, EmptyState, Icon, Spinner, useToast } from '../ui';
import { sketchHref, when } from '../sketch/format';
import '../sketch/sketch.css';
import './dm.css';

const PAGE = 50;

/**
 * The number of sketches in a direct message, for its Sketches tab (#96). It follows sketch
 * events on the stream; it is null until known and for DMs the person cannot open.
 */
export function useDmSketchCount(workspaceId: string | undefined, dmId: string | undefined, meId: string) {
  const [count, setCount] = useState<{ dmId: string; total: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!workspaceId || !dmId) return;
    const controller = new AbortController();
    listDmSketches(workspaceId, dmId, 1, 0, controller.signal).then((page) => setCount({ dmId, total: page.total }), () => undefined);
    return () => controller.abort();
  }, [workspaceId, dmId, refresh]);
  useStreamEvents(meId, (event) => { if (event.objectType === 'sketch' && event.kind === 'sketch.created.v1') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));
  return count && count.dmId === dmId ? count.total : null;
}

/**
 * `/dm/:dmId/sketches`: the sketches of one direct message (#96). They belong to the DM, so
 * exactly its current participants see them; nothing here reaches a project unless someone
 * makes a project copy on purpose.
 */
export function DmSketches() {
  const { dmId = '' } = useParams();
  const { me, directMessages } = useShellData();
  const dm = directMessages.find((item) => item.id === dmId);
  const navigate = useNavigate();
  const toast = useToast();
  const [loaded, setState] = useState<{ items: Sketch[]; total: number } | 'loading' | 'failed' | 'gone'>('loading');
  // A DM the person is not in (any more) has no sketches to show them.
  const state = dm ? loaded : 'gone';
  const [pages, setPages] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const attempt = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!dm) return;
    const controller = new AbortController();
    void (async () => {
      const items: Sketch[] = [];
      let total = 0;
      for (let page = 0; page < pages; page += 1) {
        const loaded = await listDmSketches(dm.workspaceId, dm.id, PAGE, page * PAGE, controller.signal);
        items.push(...loaded.items); total = loaded.total;
        if ((page + 1) * PAGE >= loaded.total) break;
      }
      setState({ items, total });
    })().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState(error instanceof ApiError && error.status === 404 ? 'gone' : 'failed');
    });
    return () => controller.abort();
  }, [dm, pages, refresh]);

  useStreamEvents(me.user.id, (event) => { if (event.objectType === 'sketch') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));

  const start = async () => {
    if (creating || !dm) return;
    setCreating(true);
    try {
      const sketch = await createDmSketch(dm.workspaceId, dm.id, 'Untitled sketch', [], attempt.current);
      attempt.current = crypto.randomUUID();
      navigate(sketchHref(sketch), { state: { fresh: true } });
    } catch (error) {
      toast({ message: error instanceof ApiError && error.status === 409 ? error.message : 'The sketch couldn’t be created. Try again in a moment.', tone: 'danger' });
      setCreating(false);
    }
  };

  if (state === 'gone') {
    return (
      <div className="pane-scroll"><div className="pane-in dm-gone" role="alert">
        <Icon name="lock" size={16} />
        <div><h2>This conversation isn’t available</h2><p>Only the people in a direct message can open its sketches.</p>
          <Link className="ui-btn ui-btn--secondary" to="/dm">Back to direct messages</Link></div>
      </div></div>
    );
  }
  const action = <Button variant="primary" icon="plus" busy={creating} onClick={() => void start()}>New sketch</Button>;
  const who = dm?.audience ?? 'The people in this conversation';
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
            <EmptyState icon="map" title="Sketch it out together" action={action}>
              <p>Select a few messages and choose <b>Start sketch from these messages</b>: each one becomes a thought you can move and connect.</p>
              <p>{who} can see a sketch made here. It stays in this conversation.</p>
            </EmptyState>
          </div>
        ) : null}
        {typeof state === 'object' && state.items.length ? (
          <>
            <div className="sk-index-head">
              <div>
                <h2>Sketches</h2>
                <p className="dm-sk-lead"><Icon name="lock" size={12} />{who} can see these. They stay in this conversation.</p>
              </div>
              {action}
            </div>
            <ul className="sk-index" aria-label="Sketches in this conversation">
              {state.items.map((sketch) => (
                <li key={sketch.id}>
                  <Link to={sketchHref(sketch)} className="sk-index__item">
                    <Icon name="map" size={16} />
                    <span className="sk-index__b">
                      <span className="sk-index__t">{sketch.title}</span>
                      <span className="sk-index__s">Started by {sketch.createdBy.id === me.user.id ? 'you' : sketch.createdBy.name} · changed {when(sketch.updatedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
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
