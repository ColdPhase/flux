import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { UNTITLED_SKETCH, type MovedToMap, type Sketch, type SketchDetail } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { addLink, listSpaceMaps, moveThoughtsToMap } from '../api/sketches';
import { useShellData, type ProjectSummary } from '../app/data';
import { AccountChangedError, assertSignedInAs } from '../app/personalSpace';
import { Button, Icon, MEDIA, Option, Overlay, Select, useMediaQuery, useToast } from '../ui';
import { quote } from './format';
import '../people/space.css';

/**
 * My map's "Move to a space map" (#948, guide "My map"): a selected thought goes to a space's map. The person chooses the space, and its map when it has
 * more than one; a space with none gets one made as the thought arrives. The move is one server operation (`moveThoughtsToMap`: both maps must
 * be ones the person can change), and its Undo is the same operation the other way, to where the thought was.
 */

const LAST_SPACE_KEY = 'flux.map.move-to';
const readLast = (userId: string) => { try { return localStorage.getItem(`${LAST_SPACE_KEY}:${userId}`) ?? ''; } catch { return ''; } };
const writeLast = (userId: string, projectId: string) => { try { localStorage.setItem(`${LAST_SPACE_KEY}:${userId}`, projectId); } catch { /* the choice is only a convenience */ } };

/** What went wrong, in words, for a person who is still looking at their map. Nothing was moved in any of these. */
export function moveProblem(cause: unknown): string {
  if (cause instanceof AccountChangedError) return cause.message;
  if (cause instanceof ApiError) {
    if (cause.code === 'VERSION_CONFLICT') return 'This thought changed meanwhile. Select it again and try once more.';
    if (cause.code === 'IMAGE_THOUGHT_STAYS') return 'A thought with an image stays on its map.';
    if (cause.status === 423) return 'That space is locked. An admin of the space unlocks it.';
    if (cause.status === 403) return 'You can look at that space but not add to it.';
    if (cause.status === 404) return 'That map, or the thought, is not there any more.';
  }
  return 'Flux could not be reached. Nothing was moved. Try again.';
}

interface Moving { sketchId: string; thoughts: { id: string; expectedVersion: number }[]; label: string; leavesBehind: number }

/** One thought or several, by name. */
const nameOf = (thoughts: SketchDetail['thoughts']) => thoughts.length === 1 ? quote(thoughts[0]!.text) : `${thoughts.length} thoughts`;

/**
 * The hook a map view uses: `start()` opens the window for the selected thoughts, `dialog` is the window itself (render it anywhere).
 * `onMoved` tells the view what happened, for its status line and its focus.
 */
export function useMoveToSpaceMap({ sketch, selection, versionOf, onMoved, onBack }: {
  sketch: SketchDetail | null;
  selection: string[];
  /** The version the server last confirmed for a thought. */
  versionOf: (id: string) => number | undefined;
  onMoved: () => void;
  onBack: (text: string) => void;
}): { start: (() => void) | null; dialog: ReactNode } {
  const [moving, setMoving] = useState<Moving | null>(null);
  const toast = useToast();
  const { me } = useShellData();
  const intents = useIntentKeys();
  const mine = sketch?.scope === 'private';

  const undo = useCallback(async (moved: MovedToMap, where: string) => {
    const retry = `undo-move:${moved.toSketchId}:${moved.moved.map((item) => item.thought.id).join(',')}`;
    try {
      await assertSignedInAs(me.user.id);
      const back = await moveThoughtsToMap(moved.toSketchId, {
        toSketchId: moved.fromSketchId, thoughts: moved.moved.map((item) => ({ id: item.thought.id, expectedVersion: item.thought.version })), at: moved.origin,
      }, intents.keyFor(retry));
      intents.settle(retry);
      // The thoughts are new ones again: a connection to a thought that stayed is made again onto their new ids.
      const now = new Map(back.moved.map((item) => [item.from, item.thought.id]));
      const was = new Map(moved.moved.map((item) => [item.from, item.thought.id]));
      for (const link of moved.severed) {
        const ends = [link.fromId, link.toId].map((id) => (was.has(id) ? now.get(was.get(id)!) : undefined) ?? id);
        try { await addLink(back.toSketchId, { fromId: ends[0]!, toId: ends[1]!, label: link.label }, intents.keyFor(`${retry}:${link.id}`)); } catch { /* the thought is back; the connection can be drawn again */ }
      }
      onBack(`Back on My map from ${where}`);
    } catch (cause) {
      toast({ message: cause instanceof ApiError && cause.status === 409 ? `Could not move it back: it changed on ${where}. It stays there.` : `Could not move it back. It is still on ${where}.`, tone: 'danger' });
    }
  }, [me.user.id, intents, toast, onBack]);

  const start = mine && sketch && selection.length ? () => {
    const thoughts = selection.flatMap((id) => { const thought = sketch.thoughts.find((item) => item.id === id); return thought ? [thought] : []; });
    if (!thoughts.length) return;
    const chosen = new Set(thoughts.map((thought) => thought.id));
    // A connection to a thought that stays is left behind (the window says so); one between two chosen thoughts goes along.
    const leavesBehind = sketch.links.filter((link) => chosen.has(link.fromId) !== chosen.has(link.toId)).length;
    setMoving({ sketchId: sketch.id, thoughts: thoughts.map((thought) => ({ id: thought.id, expectedVersion: versionOf(thought.id) ?? thought.version })), label: nameOf(thoughts), leavesBehind });
  } : null;

  const dialog = (
    <MoveWindow moving={moving} onClose={() => setMoving(null)}
      onMoved={(moved, project, mapTitle) => {
        setMoving(null);
        const where = `${project.name}`;
        onMoved();
        toast({ message: `Moved to ${where}${mapTitle && mapTitle !== UNTITLED_SKETCH ? ` · ${mapTitle}` : ''}`, tone: 'success', timeout: 8000, action: { label: 'Undo', key: 'Z', onClick: () => { void undo(moved, where); } } });
      }} />
  );
  return { start, dialog };
}

/** The window: a space, then its map. Centred on a computer, a bottom sheet on a phone (the New space window's surface). */
function MoveWindow({ moving, onClose, onMoved }: { moving: Moving | null; onClose: () => void; onMoved: (moved: MovedToMap, project: ProjectSummary, mapTitle: string) => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={moving !== null} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Move to a space map" className="newspace-win">
      {moving ? <MoveForm moving={moving} onClose={onClose} onMoved={onMoved} /> : null}
    </Overlay>
  );
}

function MoveForm({ moving, onClose, onMoved }: { moving: Moving; onClose: () => void; onMoved: (moved: MovedToMap, project: ProjectSummary, mapTitle: string) => void }) {
  const { me, projects, workspace } = useShellData();
  const intents = useIntentKeys();
  // The spaces the person is in: a company admin who reaches one without being in it does not see it in their sidebar either.
  const spaces = projects.filter((project) => project.member !== false);
  const [projectId, setProjectId] = useState(() => { const last = readLast(me.user.id); return spaces.some((space) => space.id === last) ? last : spaces.length === 1 ? spaces[0]!.id : ''; });
  // What was read last, for the space it was read for: no entry for the chosen space yet means it is loading, `items: null` that it could not be read.
  const [maps, setMaps] = useState<{ projectId: string; items: Sketch[] | null } | null>(null);
  const [mapId, setMapId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = { title: useId(), space: useId(), map: useId(), note: useId() };
  const project = spaces.find((space) => space.id === projectId);
  // A space lives in the company's workspace unless it is an encrypted one, which names its own.
  const workspaceId = project?.workspaceId ?? workspace?.id;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!project || !workspaceId) return undefined;
    const controller = new AbortController();
    listSpaceMaps(workspaceId, project.id, controller.signal).then(
      (page) => { setMaps({ projectId: project.id, items: page.items }); setMapId(page.items[0]?.id ?? ''); },
      () => { if (!controller.signal.aborted) setMaps({ projectId: project.id, items: null }); });
    return () => controller.abort();
  }, [project, workspaceId]);

  const read = project && maps?.projectId === project.id ? maps : null;
  const loaded = read?.items ?? null;
  const target = loaded?.find((item) => item.id === mapId) ?? null;
  const ready = !!project && loaded !== null && !busy;

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!project || !workspaceId || !loaded || busy) return;
    setBusy(true);
    setError('');
    const attempt = `move:${moving.sketchId}:${moving.thoughts.map((thought) => `${thought.id}@${thought.expectedVersion}`).join(',')}:${mapId || project.id}`;
    try {
      await assertSignedInAs(me.user.id);
      // A space with no map gets its first one in the same change as the thought arrives: a move that fails leaves no empty map behind (#1116).
      // One key per attempt, so a retry after a lost answer moves once.
      const moved = await moveThoughtsToMap(moving.sketchId, target ? { toSketchId: target.id, thoughts: moving.thoughts }
        : { inSpace: { workspaceId, projectId: project.id }, thoughts: moving.thoughts }, intents.keyFor(attempt));
      intents.settle(attempt);
      writeLast(me.user.id, project.id);
      onMoved(moved, project, target?.title ?? UNTITLED_SKETCH);
    } catch (cause) {
      if (mounted.current) setError(moveProblem(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <form className="newspace" aria-labelledby={ids.title} noValidate onSubmit={(event) => void submit(event)}>
      <div className="newspace__head">
        <h2 id={ids.title}>Move to a space map</h2>
        <button type="button" className="newspace__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <p className="pick__none" style={{ margin: 0 }}>{moving.label}</p>
      <div className="newspace__field">
        <label className="newspace__label" htmlFor={ids.space}>Space</label>
        {spaces.length ? (
          <Select id={ids.space} value={projectId} placeholder="Choose a space" disabled={busy} onChange={(next) => { setProjectId(next); setError(''); }}>
            {spaces.map((space) => <Option key={space.id} value={space.id}>{space.name}</Option>)}
          </Select>
        ) : <p className="newspace__error">You are not in a space yet. Make one with New space.</p>}
      </div>
      <div className="newspace__field">
        <label className="newspace__label" htmlFor={ids.map}>Map{loaded && loaded.length > 1 ? <span>{loaded.length} maps in this space</span> : null}</label>
        <Select id={ids.map} value={mapId} placeholder={!project ? 'Choose a space first' : read && !read.items ? 'The maps could not be read' : !read ? 'Loading maps…' : 'A new map'}
          disabled={busy || !loaded || !loaded.length} onChange={(next) => { setMapId(next); setError(''); }}>
          {(loaded ?? []).map((item) => <Option key={item.id} value={item.id}>{item.title}</Option>)}
        </Select>
        {loaded && !loaded.length ? <p className="pick__none" style={{ margin: 0 }} role="status">{project!.name} has no map yet. One is made for this thought.</p> : null}
      </div>
      {moving.leavesBehind ? <p className="pick__none" id={ids.note} style={{ margin: 0 }}>
        {moving.leavesBehind === 1 ? 'Its connection to a thought that stays on My map is left behind.' : `${moving.leavesBehind} connections to thoughts that stay on My map are left behind.`}</p> : null}
      {error ? <p role="alert" className="newspace__error"><Icon name="alert" size={14} />{error}</p> : null}
      <div className="newspace__foot">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!ready} aria-describedby={moving.leavesBehind ? ids.note : undefined}>Move</Button>
      </div>
    </form>
  );
}
