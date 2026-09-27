import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { DEFAULT_THOUGHT_SIZE, THOUGHT_SHAPES, type SketchDetail } from '@flux/contracts';
import { Button, EmptyState, Icon, MEDIA, Spinner, useMediaQuery } from '../ui';
import { getProject } from '../api/sketches';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { createWork } from '../work/api';
import { useSketchDoc, type Op } from './doc';
import { audience, quote } from './format';
import { freeSpot, rectOf } from './geometry';
import { SketchList } from './SketchList';
import { SketchMap } from './SketchMap';
import './sketch.css';

export interface Editing {
  id: string;
  isNew: boolean;
  parentId: string | null;
  /** Text to start from instead of the stored one. */
  initial?: string;
}

type Mode = 'map' | 'list';
const MODE_KEY = 'flux.sketch.mode';

function storedMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'map'; } catch { return 'map'; }
}

/** The project's name for the audience line, when the sketch belongs to one. */
function useProjectName(projectId: string | null | undefined) {
  const [loaded, setLoaded] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    getProject(projectId, controller.signal).then((project) => setLoaded({ id: project.id, name: project.name }), () => undefined);
    return () => controller.abort();
  }, [projectId]);
  return loaded && loaded.id === projectId ? loaded.name : null;
}

/** `/map/:sketchId`: a fresh view (and document) per sketch. */
export function SketchRoute() {
  const { sketchId = '' } = useParams();
  return <SketchView key={sketchId} sketchId={sketchId} />;
}

/**
 * One sketch at `/map/:sketchId` (issue #69): the Map with its toolbar, or the same thoughts as
 * a List. Everything is edited in place; there is no management panel. Changes save as they
 * happen and arrive live from the other people who can see the sketch.
 */
export function SketchView({ sketchId }: { sketchId: string }) {
  const { me } = useShellData();
  const doc = useSketchDoc(sketchId, { id: me.user.id, name: me.user.name });
  const { sketch } = doc;
  const coarse = useMediaQuery('(pointer: coarse)');
  const phone = useMediaQuery(MEDIA.phone);
  const [mode, setModeState] = useState<Mode>(storedMode);
  const [selectionState, setSelection] = useState<string[]>([]);
  const [connectState, setConnectFrom] = useState<string | null>(null);
  const [editingState, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState<{ text: string; change: boolean }>({ text: '', change: false });
  const [renaming, setRenaming] = useState<boolean>(!!(useLocation().state as { fresh?: boolean } | null)?.fresh);
  const [heights] = useState(() => new Map<string, number>());
  const rootRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const projectName = useProjectName(sketch?.projectId);
  const canWrite = sketch?.access === 'write';

  const say = (text: string, change = false) => setStatus({ text, change });
  const find = (id: string) => sketch?.thoughts.find((t) => t.id === id);
  // Focus moves after the next commit (a list row replaces its editor only then), and only if
  // focus is not already somewhere the person put it meanwhile.
  const pendingFocus = useRef<string | null>(null);
  const focusThought = useCallback((selector: string) => { pendingFocus.current = selector; }, []);
  useLayoutEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches('.sk-edit, .sk-li-edit') && rootRef.current?.contains(active) === false) return;
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  // Selection follows what exists: someone else may remove a selected thought meanwhile.
  const present = new Set(sketch?.thoughts.map((t) => t.id));
  const selection = selectionState.filter((id) => present.has(id));
  const connectFrom = connectState && present.has(connectState) ? connectState : null;
  const editing = editingState && present.has(editingState.id) ? editingState : null;

  const setMode = (next: Mode) => {
    setModeState(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* storage may be unavailable */ }
  };

  const describe = (ids: string[]) => {
    if (!ids.length) say('');
    else if (ids.length === 1) say(`${quote(find(ids[0]!)?.text ?? '')} selected`);
    else say(`${ids.length} thoughts selected · Connect links them`);
  };

  const connectTo = (from: string, to: string) => {
    setConnectFrom(null);
    if (from === to) { say('Connect cancelled'); return; }
    const a = find(from);
    const b = find(to);
    if (!a || !b || !sketch) return;
    if (sketch.links.some((l) => (l.fromId === from && l.toId === to) || (l.fromId === to && l.toId === from))) {
      say(`${quote(a.text)} and ${quote(b.text)} are already linked`);
      return;
    }
    doc.perform([{ kind: 'link', link: { id: doc.newId(), fromId: from, toId: to, label: null } }], 'linked two thoughts');
    setSelection([from, to]);
    say(`Linked ${quote(a.text)} and ${quote(b.text)}`, true);
  };

  const pick = (id: string, additive: boolean) => {
    if (connectFrom) { connectTo(connectFrom, id); return; }
    const next = additive ? (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]) : [id];
    setSelection(next);
    describe(next);
  };

  const toggle = (id: string) => {
    const next = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
    setSelection(next);
    describe(next);
  };

  const escape = () => {
    if (connectFrom) { setConnectFrom(null); say('Connect cancelled'); return true; }
    if (selection.length) { setSelection([]); say(''); return true; }
    return false;
  };

  const add = (parentId: string | null) => {
    if (!sketch || !canWrite) return;
    const parent = parentId ? find(parentId) : undefined;
    const rects = sketch.thoughts.map((t) => rectOf(t, heights));
    const spot = freeSpot(rects, parent ? rectOf(parent, heights) : null, { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height }, phone);
    const id = doc.newId();
    doc.perform([{ kind: 'add', thought: { id, text: 'New thought', x: spot.x, y: spot.y }, link: parent ? { id: doc.newId(), fromId: parent.id, label: null } : undefined }], 'added a thought');
    setConnectFrom(null);
    setSelection([id]);
    setEditing({ id, isNew: true, parentId: parent?.id ?? null });
    say(parent ? `New thought connected to ${quote(parent.text)} · Enter saves, Esc keeps “New thought”` : 'New thought · type its text, Enter saves');
  };

  const finishEdit = (text: string | null) => {
    const current = editing;
    setEditing(null);
    if (!current) return;
    const thought = find(current.id);
    if (!thought) return;
    const value = text?.trim() ?? '';
    const parent = current.parentId ? find(current.parentId) : undefined;
    if (value && value !== thought.text) {
      // A new thought's text belongs to the "added" step: one undo removes it.
      doc.perform([{ kind: 'update', id: thought.id, changes: { text: value } }], 'edited a thought', { undoable: !current.isNew });
    }
    const final = value || thought.text;
    if (current.isNew) say(parent ? `Added ${quote(final)}, connected to ${quote(parent.text)}` : `Added ${quote(final)}`, true);
    else if (value && value !== thought.text) say(`Edited ${quote(final)}`, true);
    else say('Edit cancelled');
    focusThought(`.sk-node[data-id="${thought.id}"], .sk-li-t[data-id="${thought.id}"]`);
  };

  const connect = () => {
    if (!sketch) return;
    if (selection.length >= 2) {
      const [first, ...rest] = selection;
      const linked = (a: string, b: string) => sketch.links.some((l) => (l.fromId === a && l.toId === b) || (l.fromId === b && l.toId === a));
      const missing = rest.filter((b) => !linked(first!, b));
      if (!missing.length) { say('These thoughts are already linked'); return; }
      doc.perform(missing.map((b): Op => ({ kind: 'link', link: { id: doc.newId(), fromId: first!, toId: b, label: null } })), 'linked thoughts');
      say(`Linked ${quote(find(first!)?.text ?? '')} to ${missing.length} ${missing.length === 1 ? 'thought' : 'thoughts'}`, true);
    } else if (selection.length === 1) {
      const next = connectFrom ? null : selection[0]!;
      setConnectFrom(next);
      say(next ? `Choose the thought to link to ${quote(find(next)?.text ?? '')} · Esc cancels` : 'Connect cancelled');
    } else {
      say('Select a thought first, then Connect');
    }
  };

  const remove = (ids: string[]) => {
    const thoughts = ids.flatMap((id) => { const t = find(id); return t ? [t] : []; });
    if (!thoughts.length) return;
    doc.perform(thoughts.map((t): Op => ({ kind: 'remove', id: t.id })), thoughts.length === 1 ? 'removed a thought' : 'removed thoughts');
    setSelection([]);
    setConnectFrom(null);
    const placed = thoughts.some((t) => t.placement);
    say(`Removed ${thoughts.length === 1 ? quote(thoughts[0]!.text) : `${thoughts.length} thoughts`} from the sketch${placed ? '; the draft itself is kept' : ''}`, true);
    focusThought('.sk-node:not([aria-pressed="true"]), .sk-li-t, .sk-canvas');
  };

  const move = (moves: { id: string; x: number; y: number }[], how: 'drag' | 'keyboard') => {
    if (!moves.length) return;
    doc.perform([{ kind: 'move', moves }], how === 'keyboard' ? 'moved with the keyboard' : 'moved thoughts', { coalesce: how === 'keyboard' });
    const what = moves.length === 1 ? quote(find(moves[0]!.id)?.text ?? '') : `${moves.length} thoughts`;
    say(`Moved ${what}${how === 'keyboard' ? ' with the keyboard' : ''}`, true);
  };

  const resize = (id: string, width: number, height: number) => {
    doc.perform([{ kind: 'update', id, changes: { width, height } }], 'resized a thought');
    say(`Resized ${quote(find(id)?.text ?? '')}`, true);
  };

  const cycleShape = () => {
    const thoughts = selection.flatMap((id) => { const t = find(id); return t ? [t] : []; });
    if (!thoughts.length) { say('Select a thought first, then Shape'); return; }
    const next = THOUGHT_SHAPES[(THOUGHT_SHAPES.indexOf(thoughts[0]!.shape) + 1) % THOUGHT_SHAPES.length]!;
    doc.perform(thoughts.map((t): Op => ({ kind: 'update', id: t.id, changes: { shape: next } })), 'changed the shape');
    say(`Shape: ${next === 'card' ? 'card' : next === 'pill' ? 'pill' : 'circle'}`, true);
  };

  // #101: selected thoughts of a project sketch become one work item in one action; the map
  // keeps its thoughts and the work links back to them.
  const { openDetails } = useShellActions();
  const workAttempt = useRef<{ ids: string; key: string } | null>(null);
  const makeWork = async () => {
    const thoughts = selection.flatMap((id) => { const t = find(id); return t ? [t] : []; });
    if (!thoughts.length || !sketch?.projectId) { say('Select thoughts first, then Create work'); return; }
    const ids = thoughts.map((t) => t.id).join(',');
    if (workAttempt.current?.ids !== ids) workAttempt.current = { ids, key: crypto.randomUUID() };
    const title = thoughts.length === 1 ? thoughts[0]!.text : `Explore: ${thoughts.map((t) => t.text).join(', ')}`;
    try {
      const item = await createWork(sketch.projectId, { title: title.slice(0, 200), sources: thoughts.map((t) => ({ type: 'thought' as const, id: t.id })) }, workAttempt.current.key);
      workAttempt.current = null;
      say(`Created work ${quote(item.title)}; the thoughts stay on the map`);
      openDetails({ kind: 'work', id: item.id });
    } catch { say('Could not create the work yet. Wait for “Saved”, then try again.'); }
  };

  const undo = () => {
    setEditing(null);
    setConnectFrom(null);
    const label = doc.undo();
    say(label ? `Undid: ${label}` : 'Nothing to undo');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA)$/.test(target.tagName)) {
      event.preventDefault();
      if (canWrite) undo();
    }
  };

  if (doc.load === 'loading' && !sketch) return <div className="sk-page sk-page--center"><Spinner label="Opening the sketch" /></div>;
  if (doc.load === 'not-found' || (!sketch && doc.load === 'failed')) {
    return (
      <div className="sk-page">
        <div className="view-empty">
          <EmptyState icon="map" title={doc.load === 'not-found' ? 'This sketch isn’t available' : 'The sketch couldn’t be opened'}
            action={doc.load === 'not-found' ? <Link className="ui-btn ui-btn--secondary" to="/map">All sketches</Link> : <Button onClick={() => void doc.reload()}>Try again</Button>}>
            <p>{doc.load === 'not-found' ? 'It may have been shared with other people only, or you no longer have access to where it lives.' : 'Flux could not be reached. Your changes are safe; try again in a moment.'}</p>
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!sketch) return null;

  const busy = doc.saving ? 'Saving…' : 'Saved';
  const shared = { sketch, meId: me.user.id, selection, connectFrom, editing, canWrite, onPick: pick, onToggle: toggle, onEdit: (id: string) => { setConnectFrom(null); setEditing({ id, isNew: false, parentId: null }); }, onFinishEdit: finishEdit, onAdd: add, onRemove: remove, onEscape: escape };

  return (
    <div className="sk-page" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="sk">
        <div className="sk-head">
          <p className="sk-lead">
            <Link to="/map" className="sk-back">Sketches</Link>
            <span aria-hidden="true" className="sk-sep">·</span>
            {renaming && canWrite ? (
              <TitleEditor sketch={sketch} onDone={(title) => {
                setRenaming(false);
                if (title && title !== sketch.title) { doc.perform([{ kind: 'rename', title }], 'renamed the sketch'); say(`Renamed to ${quote(title)}`, true); }
              }} />
            ) : (
              <button type="button" className="sk-title" disabled={!canWrite} aria-label={canWrite ? `Rename sketch ${sketch.title}` : undefined} onClick={() => setRenaming(true)}>{sketch.title}</button>
            )}
            <span className="sk-aud"><Icon name={sketch.scope === 'project' ? 'people' : 'lock'} size={12} />{audience(sketch, me.user.id, projectName)}</span>
          </p>
          <div className="seg sk-mode" role="radiogroup" aria-label="Show as">
            {(['map', 'list'] as const).map((m) => (
              <button key={m} type="button" role="radio" className="seg__b" aria-checked={mode === m} onClick={() => setMode(m)}>{m === 'map' ? 'Map' : 'List'}</button>
            ))}
          </div>
        </div>

        {canWrite ? (
          <div className="sk-bar">
            <div className="sk-tools" role="toolbar" aria-label="Sketch tools">
            <button type="button" className="ui-btn ui-btn--quiet sk-add" onClick={() => add(selection[selection.length - 1] ?? null)}><Icon name="plus" size={14} />Thought</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-pressed={!!connectFrom} onClick={connect}><Icon name="link" size={14} />Connect</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={selection.length !== 1} onClick={() => {
              if (selection.length !== 1) { say('Select one thought, then Edit'); return; }
              setConnectFrom(null);
              setEditing({ id: selection[0]!, isNew: false, parentId: null });
            }}><Icon name="edit" size={14} />Edit</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={cycleShape} aria-label="Change shape"><Icon name="shape" size={14} /><span className="sk-bl">Shape</span></button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={() => remove(selection)} aria-label="Remove from sketch"><Icon name="trash" size={14} /><span className="sk-bl">Remove</span></button>
            {sketch.scope === 'project' ? <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={() => void makeWork()} aria-label="Create work from selected thoughts"><Icon name="tasks" size={14} /><span className="sk-bl">Create work</span></button> : null}
            <span className="sk-div" aria-hidden="true" />
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!doc.canUndo} onClick={undo} aria-label="Undo"><Icon name="undo" size={14} /><span className="sk-bl">Undo</span></button>
            </div>
            <p className="sk-status" role="status">
              {doc.problem ? <span className="sk-warn">{doc.problem}</span> : status.text}
              {!doc.problem && status.change ? <span className={doc.saving ? undefined : 'sk-ok'}> · {busy}</span> : null}
            </p>
          </div>
        ) : (
          <p className="sk-readonly"><Icon name="lock" size={12} />You can look at this sketch; people who can change it keep it up to date.</p>
        )}

        {mode === 'map' ? (
          sketch.thoughts.length || canWrite ? (
            <>
              <SketchMap {...shared} coarse={coarse} compact={phone} helpId={helpId} heights={heights} onMove={move} onResize={resize} onClear={() => { if (connectFrom) return; setSelection([]); say(''); }} />
              {!sketch.thoughts.length ? <p className="sk-first">An empty sketch. Add the first thought with <b>Thought</b>, then keep adding with the <b>+</b> beside it.</p> : null}
            </>
          ) : <p className="sk-empty-list">No thoughts yet.</p>
        ) : (
          <SketchList {...shared} />
        )}

        <p className="sk-help" id={helpId}>
          {coarse
            ? 'Tap a thought to select it, then drag it. Add links a new thought to it. List shows the same thoughts in order.'
            : 'Drag to move, drag empty space to pan, Shift-click to select several. On a focused thought: arrows move (Shift further, Alt resizes) · Enter edits · Space selects · + adds a linked thought · Delete removes · Ctrl/⌘ Z undoes.'}
        </p>
      </div>
    </div>
  );
}

function TitleEditor({ sketch, onDone }: { sketch: SketchDetail; onDone(title: string | null): void }) {
  const [value, setValue] = useState(sketch.title);
  const done = useRef(false);
  const finish = (title: string | null) => { if (done.current) return; done.current = true; onDone(title?.trim() || null); };
  return (
    <input className="sk-title-edit" value={value} maxLength={200} aria-label="Sketch name" autoFocus onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)} onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
      }} />
  );
}
