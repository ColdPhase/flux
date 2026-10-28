import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { ObjectLink, Project, Sketch, Thought } from '@flux/contracts';
import { ApiError } from '../api/client';
import { getSketch } from '../api/sketches';
import { listProjectSketches } from '../project/data';
import { Button, Icon, Select, Option } from '../ui';
import { linkObjects } from './api';
import { RefLink } from '../place/origin';

// "Linked thoughts" in task Details (#289, #44 scenario 2): a task made first in Tasks is connected to a map
// thought from here. The map's task count and its chooser read the same links, so they show the new task after
// the link is saved. Only thoughts of project maps are offered; private and DM sketches are never linkable.
// Every step is a button or a select, so keyboard and touch use the same controls (HIG-41, HIG-17).

interface TaskThoughtLinksProps {
  item: { id: string; title: string };
  project: Project;
  /** The task's links, as the panel reads them. Thoughts it came from are listed under "Came from". */
  links: ObjectLink[];
  reload: () => void;
}

const LINK_FAILURE = 'Could not link it. Try again.';

/**
 * The task's thought linking as one state two places share (#488): the "Link thought" action in the panel's one row of
 * actions, and the linked thoughts with their picker below it, which appear only once there is something to show.
 */
export function useThoughtLinks({ item, project, links, reload }: TaskThoughtLinksProps) {
  const [open, setOpen] = useState(false);
  const [maps, setMaps] = useState<{ items: Sketch[] } | 'failed' | null>(null);
  const [mapId, setMapId] = useState('');
  const [loaded, setLoaded] = useState<{ mapId: string; thoughts: Thought[] } | { mapId: string; failed: true } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  // Bumped when a refused choice may have changed the map, so its thoughts are read again.
  const [reloads, setReloads] = useState(0);
  const toggle = useRef<HTMLButtonElement>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const sectionId = useId();
  const panelId = useId();
  const mapFieldId = useId();

  // Every thought already connected to this task, whatever the role, is not offered again.
  const connected = links.filter((link) => link.from.type === 'work' && link.from.id === item.id && link.to.type === 'thought');
  const connectedIds = new Set(connected.map((link) => link.to.id));
  const listed = connected.filter((link) => link.role !== 'source');
  const current = loaded?.mapId === mapId ? loaded : null;
  const candidates = current && 'thoughts' in current ? current.thoughts.filter((thought) => !connectedIds.has(thought.id)) : [];

  // Maps and a map's thoughts load only while the picker is open; a late answer for a closed or changed picker is dropped.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listProjectSketches(project.workspaceId, project.id, 100, 0, controller.signal)
      .then((page) => setMaps({ items: page.items.filter((sketch) => sketch.scope === 'project' && sketch.projectId === project.id) }))
      .catch(() => { if (!controller.signal.aborted) setMaps('failed'); });
    return () => controller.abort();
  }, [open, project.id, project.workspaceId]);

  useEffect(() => {
    if (!open || !mapId) return;
    const controller = new AbortController();
    getSketch(mapId, controller.signal)
      .then((sketch) => setLoaded({ mapId, thoughts: sketch.thoughts }))
      .catch(() => { if (!controller.signal.aborted) setLoaded({ mapId, failed: true }); });
    return () => controller.abort();
  }, [open, mapId, reloads]);

  const close = () => { setOpen(false); toggle.current?.focus(); };
  // Escape closes the open picker from its button as well as from inside it; the Details panel keeps its own Escape otherwise.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (open && event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close(); }
  };

  // The same thought chosen again after a lost response reuses its Idempotency-Key, so the link is never stored twice.
  async function link(thought: Thought) {
    const key = JSON.stringify([item.id, thought.id]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError(''); setStatus('');
    try {
      await linkObjects(project.id, { from: { type: 'work', id: item.id }, to: { type: 'thought', id: thought.id } }, attempt.current.id);
      attempt.current = null;
      setStatus(`Linked “${thought.text}” to this task.`);
      setOpen(false);
      reload();
      toggle.current?.focus();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) setError('You can read this task but not change it.');
      else if (cause instanceof ApiError && cause.status === 404) setError('That thought is no longer on a map you can read. Choose another.');
      else if (cause instanceof ApiError && cause.status === 422) setError('That thought was deleted while you were choosing. Choose another thought.');
      else setError(LINK_FAILURE);
      // The list stays on screen until the map's thoughts arrive again, so a refused choice never leaves the picker on "Loading thoughts…".
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 422)) setReloads((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  // The button's ref stays apart from the state the views read.
  return { toggle, links: { item, project, open, setOpen, maps, mapId, setMapId, current, candidates, busy, error, setError, status, setStatus, sectionId, panelId, mapFieldId, listed, close, onKeyDown, link } };
}

export type ThoughtLinks = ReturnType<typeof useThoughtLinks>['links'];

/** "Link thought": one small action beside Hand off and Result. */
export function LinkThoughtButton({ links, toggle }: { links: ThoughtLinks; toggle: RefObject<HTMLButtonElement | null> }) {
  return (
    <Button ref={toggle} variant="secondary" size="sm" icon="link" disabled={links.busy} aria-expanded={links.open} aria-controls={links.panelId}
      onKeyDown={links.onKeyDown} onClick={() => { links.setError(''); links.setStatus(''); links.setOpen((value) => !value); }}>Link thought</Button>
  );
}

/** The thoughts the task is linked to and the picker that adds one; empty and closed it shows nothing (Spokój rule 4). */
export function LinkedThoughts({ links }: { links: ThoughtLinks }) {
  const { item, project, open, maps, mapId, setMapId, current, candidates, busy, error, status, sectionId, panelId, mapFieldId, listed, close, onKeyDown, link } = links;
  if (!listed.length && !open && !status && !error) return null;
  return (
    <section className="details__sec" aria-labelledby={sectionId} onKeyDown={onKeyDown}>
      <h4 id={sectionId}>Linked thoughts</h4>
      {listed.length ? (
        <ul className="wd-links">
          {listed.map((entry) => {
            const body = <><span>{entry.toTitle || 'Untitled thought'}</span><small>On the map</small><Icon name="chevron-right" size={14} /></>;
            return <li key={entry.id}>{entry.sketchId ? <RefLink className="wd-link" to={`/projects/${project.id}/map/${entry.sketchId}#thought-${entry.to.id}`}>{body}</RefLink> : <span className="wd-link">{body}</span>}</li>;
          })}
        </ul>
      ) : null}
      {open ? (
        <div id={panelId} className="wd-pick" role="group" aria-label={`Thoughts to link to ${item.title}`}>
          <div className="wd-actions wd-pick__cancel">
            <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
          </div>
          {maps === null ? <p className="wd-muted" role="status">Loading maps…</p>
            : maps === 'failed' ? <p className="wd-error" role="alert">Could not load this project’s maps.</p>
              : !maps.items.length ? <p className="wd-muted">This project has no map yet. Add a thought on a map first.</p>
                : (
                  <>
                    <div className="wd-pick__map">
                      <label htmlFor={mapFieldId}>Map</label>
                      <div className="wd-pick__field">
                        <Select id={mapFieldId} value={mapId} disabled={busy} onChange={(next) => setMapId(next)}>
                          <Option value="">Choose a map</Option>
                          {maps.items.map((sketch) => <Option key={sketch.id} value={sketch.id}>{sketch.title}</Option>)}
                        </Select>
                      </div>
                    </div>
                    {!mapId ? null : !current ? <p className="wd-muted" role="status">Loading thoughts…</p>
                      : 'failed' in current ? <p className="wd-error" role="alert">Could not load this map’s thoughts.</p>
                        : !candidates.length ? <p className="wd-muted">No other thought on this map to link.</p>
                          : (
                            <ul className="wd-links" aria-label="Thoughts on this map">
                              {candidates.map((thought) => (
                                <li key={thought.id}>
                                  <button type="button" className="wd-link" disabled={busy} onClick={() => void link(thought)}>
                                    <span>{thought.text}</span><Icon name="link" size={14} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                  </>
                )}
          <p className="wd-pick__keys wd-muted">Choose a thought to link it. Cancel, or Escape, closes this without a change.</p>
        </div>
      ) : null}
      {status ? <p className="wd-muted" role="status">{status}</p> : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
    </section>
  );
}
