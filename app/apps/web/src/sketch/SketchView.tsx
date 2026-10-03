import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { DEFAULT_THOUGHT_SIZE, THOUGHT_SHAPES, type SketchDetail } from '@flux/contracts';
import { Button, EmptyState, Icon, MEDIA, Spinner, useMediaQuery } from '../ui';
import { getProject } from '../api/sketches';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { createWork } from '../work/api';
import { useSketchDoc, type Op } from './doc';
import { audience, quote, sketchHref, when } from './format';
import { freeSpot, rectOf } from './geometry';
import { SketchList } from './SketchList';
import { SketchMap } from './SketchMap';
import { useOutline } from './useOutline';
import { useThoughtDraft } from './createdDraft';
import { DraftCapture } from './DraftCapture';
import { useRegisterLiveHere } from '../live/LiveProvider';
import './sketch.css';

export interface Editing {
  id: string;
  initial: string;
  /** The text the editor opened on, at `version`; only a changed text is a conflict. */
  opened: string;
  version: number;
  key: string;
  attempt: number;
  saving: boolean;
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
  const { sketchId = '', projectId, dmId } = useParams();
  // Opened from a project's Map tab (#117) or a DM's Sketches (#96), the way back stays there.
  const back = projectId ? `/projects/${projectId}/map` : dmId ? `/dm/${dmId}/sketches` : '/map';
  return <SketchView key={sketchId} sketchId={sketchId} projectId={projectId} dmId={dmId} back={back} />;
}

/**
 * One sketch at `/map/:sketchId` (issue #69): the Map with its toolbar, or the same thoughts as
 * a List. Everything is edited in place; there is no management panel. Changes save as they
 * happen and arrive live from the other people who can see the sketch.
 */
export function SketchView({ sketchId, projectId, dmId, back = '/map' }: { sketchId: string; projectId?: string; dmId?: string; back?: string }) {
  const { me, directMessages } = useShellData();
  const started = (useLocation().state as { started?: number } | null)?.started;
  const doc = useSketchDoc(sketchId, { id: me.user.id, name: me.user.name });
  const { sketch } = doc;
  const personalOutline = useOutline(me.user.id, sketch);
  const capture = useThoughtDraft(me.user.id, sketchId, sketch);
  const [savingDraft, setSavingDraft] = useState(false);
  const draftSaveInFlight = useRef(false);
  const coarse = useMediaQuery('(pointer: coarse)');
  const phone = useMediaQuery(MEDIA.phone);
  const [mode, setModeState] = useState<Mode>(storedMode);
  const location = useLocation();
  // A fragment shown in a live session (#62) opens with the presenter's thoughts selected.
  const liveSelect = (location.state as { liveSelect?: string[] | null } | null)?.liveSelect ?? null;
  const [selectionState, setSelection] = useState<string[]>(() => liveSelect ?? []);
  const [selectedFor, setSelectedFor] = useState(location.key);
  if (selectedFor !== location.key) {
    setSelectedFor(location.key);
    if (liveSelect) setSelection(liveSelect);
  }
  const [connectState, setConnectFrom] = useState<string | null>(null);
  const [editingState, setEditing] = useState<Editing | null>(null);
  const editSaveInFlight = useRef(false);
  const dmAudience = directMessages.find((item) => item.id === (doc.sketch?.dmId ?? dmId))?.audience ?? null;
  // "Start sketch from these messages" lands here: say what happened and who sees it.
  const [status, setStatus] = useState<{ text: string; change: boolean }>(() => ({
    text: started ? `Started from ${started} ${started === 1 ? 'message' : 'messages'} · ${dmAudience ? `${dmAudience.replace(/^Only /, 'only ')} can see it` : 'it stays in this conversation'}` : '',
    change: false,
  }));
  const { hash } = location;
  const [renaming, setRenaming] = useState<boolean>(!!(location.state as { fresh?: boolean } | null)?.fresh);
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
  // A project sketch anchors a session; "Show this" points at the selected thoughts, if any.
  const projectSketch = sketch?.scope === 'project' && sketch.projectId ? sketch : null;
  const firstSelected = selection.length === 1 ? sketch?.thoughts.find((t) => t.id === selection[0])?.text : null;
  useRegisterLiveHere(projectSketch ? { projectId: projectSketch.projectId!, context: { type: 'sketch', id: projectSketch.id }, label: projectSketch.title } : null,
    projectSketch ? { ref: { type: 'sketch', id: projectSketch.id, version: projectSketch.version, ...(selection.length ? { selectedThoughtIds: selection.slice(0, 100) } : {}) },
      label: firstSelected ? (firstSelected.length > 60 ? `${firstSelected.slice(0, 59)}…` : firstSelected) : projectSketch.title,
      what: selection.length === 0 ? 'map' : selection.length === 1 ? 'thought on the map' : `${selection.length} thoughts on the map` } : null);
  const editing = editingState && present.has(editingState.id) ? editingState : null;
  const startEdit = (id: string) => {
    const thought = find(id);
    if (!thought || !canWrite || editSaveInFlight.current) return;
    if (editingState) {
      rootRef.current?.querySelector<HTMLTextAreaElement>('.sk-edit, .sk-li-edit')?.focus();
      say('Finish or cancel your current edit first');
      return;
    }
    setConnectFrom(null);
    doc.clearProblem();
    setEditing({ id, initial: thought.text, opened: thought.text, version: thought.version, key: doc.newId(), attempt: 0, saving: false });
  };

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

  // A search result (#114) opens the sketch with its thought selected and focused, once.
  const arrivedThought = hash.startsWith('#thought-') ? hash.slice('#thought-'.length) : null;
  const handledArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedThought || handledArrival.current === arrivedThought || !sketch?.thoughts.some((t) => t.id === arrivedThought)) return;
    handledArrival.current = arrivedThought;
    personalOutline.reveal(arrivedThought);
    setSelection([arrivedThought]);
    describe([arrivedThought]);
    focusThought(`.sk-node[data-id="${arrivedThought}"], .sk-li-t[data-id="${arrivedThought}"]`);
    // describe/focusThought only read state that this effect's dependencies already cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivedThought, sketch]);

  // A live fragment can select several thoughts, including ones inside collapsed branches.
  // Handle the arrival once: later deliberate collapsing must not be undone by graph updates.
  const handledLiveArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!liveSelect || !sketch || handledLiveArrival.current === location.key) return;
    handledLiveArrival.current = location.key;
    const ids = liveSelect.filter((id) => sketch.thoughts.some((thought) => thought.id === id));
    for (const id of ids) personalOutline.reveal(id);
    if (ids[0]) focusThought(`.sk-node[data-id="${ids[0]}"], .sk-li-t[data-id="${ids[0]}"]`);
    // The outline is deliberately read only for this arrival, not every subsequent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSelect, sketch, location.key]);

  const escape = () => {
    if (connectFrom) { setConnectFrom(null); say('Connect cancelled'); return true; }
    if (selection.length) { setSelection([]); say(''); return true; }
    return false;
  };

  const add = (parentId: string | null) => {
    if (!sketch || !canWrite) return;
    if (editingState) { say('Finish or cancel your current edit first'); return; }
    if (capture.draft) { rootRef.current?.querySelector<HTMLTextAreaElement>('.sk-draft textarea')?.focus(); say('Finish or cancel your current thought draft first'); return; }
    const parent = parentId ? find(parentId) : undefined;
    const rects = sketch.thoughts.map((t) => rectOf(t, heights));
    const spot = freeSpot(rects, parent ? rectOf(parent, heights) : null, { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height }, phone);
    capture.set({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), text: '', x: spot.x, y: spot.y, parentId });
    setConnectFrom(null);
    setEditing(null);
    say('Private thought draft · Enter saves, Escape cancels');
  };

  const saveDraft = async () => {
    const draft = capture.draft;
    if (!draft || draftSaveInFlight.current || !canWrite || !draft.text.trim()) return;
    draftSaveInFlight.current = true;
    setSavingDraft(true);
    const saved = await doc.saveThought({ id: draft.id, text: draft.text.trim(), x: draft.x, y: draft.y },
      draft.parentId ? { id: draft.parentId, linkId: draft.linkId } : null, draft.key);
    setSavingDraft(false);
    draftSaveInFlight.current = false;
    if (!saved) { say('Couldn’t confirm the save. Your thought draft is kept; try again.'); return; }
    personalOutline.group(draft.id, draft.parentId, false);
    capture.set(null);
    setSelection([draft.id]);
    say(`Added ${quote(draft.text.trim())}`, true);
    focusThought(`.sk-node[data-id="${draft.id}"], .sk-li-t[data-id="${draft.id}"]`);
  };

  const finishEdit = async (text: string | null) => {
    const current = editing;
    if (!current || editSaveInFlight.current) return;
    const thought = find(current.id);
    if (!thought) return;
    const value = text?.trim() ?? '';
    if (text === null || !value || (value === thought.text && (current.version === thought.version || value === current.opened))) {
      setEditing(null);
      doc.clearProblem();
      say('Edit cancelled');
      focusThought(`.sk-node[data-id="${thought.id}"], .sk-li-t[data-id="${thought.id}"]`);
      return;
    }
    editSaveInFlight.current = true;
    setEditing({ ...current, initial: text, saving: true });
    const saved = await doc.saveText(current.id, value, { text: current.opened, version: current.version }, current.key);
    editSaveInFlight.current = false;
    if (!saved) {
      setEditing({ ...current, initial: text, saving: false, attempt: current.attempt + 1 });
      say('Your edit is kept. Cancel to inspect the current shared version.');
      return;
    }
    setEditing(null);
    say(`Edited ${quote(value)}`, true);
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
    if (editingState) { say('Finish or cancel your current edit first'); return; }
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
    if (editingState) { say('Finish or cancel your current edit first'); return; }
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

  // A sketch opens only where it lives, so the tabs and the header's audience are never wrong: a project
  // sketch inside its project (#117, #189), a DM's sketch inside its DM (#96), a private one in Home's Map.
  // Links that cannot know the place (search, doc links) arrive at `/map/:id` and move here.
  const here = projectId ? `/projects/${projectId}/map/${sketchId}` : dmId ? `/dm/${dmId}/sketches/${sketchId}` : `/map/${sketchId}`;
  if (sketch && sketchHref(sketch) !== here) return <Navigate replace to={`${sketchHref(sketch)}${hash}`} state={location.state} />;
  if (doc.load === 'loading' && !sketch) return <div className="sk-page sk-page--center"><Spinner label="Opening the sketch" /></div>;
  if (doc.load === 'not-found' || (!sketch && doc.load === 'failed')) {
    return (
      <div className="sk-page">
        <div className="view-empty">
          <EmptyState icon="map" title={doc.load === 'not-found' ? 'This sketch isn’t available' : 'The sketch couldn’t be opened'}
            action={doc.load === 'not-found' ? <Link className="ui-btn ui-btn--secondary" to={back}>All sketches</Link> : <Button onClick={() => void doc.reload()}>Try again</Button>}>
            <p>{doc.load === 'not-found' ? 'It may have been shared with other people only, or you no longer have access to where it lives.' : 'Flux could not be reached. Your changes are safe; try again in a moment.'}</p>
            {capture.draft ? <label>Your private thought draft<textarea aria-label="Recoverable thought draft" readOnly value={capture.draft.text} /></label> : null}
            {editingState ? <label>Your unsaved edit<textarea aria-label="Recoverable thought edit" readOnly value={editingState.initial} /></label> : null}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!sketch) return null;

  const busy = doc.saving ? 'Saving…' : 'Saved';
  const shared = { sketch, meId: me.user.id, selection, connectFrom, editing, canWrite, onPick: pick, onToggle: toggle, onEdit: startEdit,
    onEditText: (text: string) => setEditing((current) => current ? { ...current, initial: text, key: doc.newId() } : null),
    onFinishEdit: (text: string | null) => { void finishEdit(text); }, onAdd: add, onRemove: remove, onEscape: escape };
  const navigateThought = (id: string, previous?: string[]) => {
    if (!present.has(id)) return;
    setConnectFrom(null);
    const next = previous?.filter((item) => present.has(item)) ?? [id];
    setSelection(next);
    describe(next);
  };

  return (
    <div className="sk-page" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="sk">
        <div className="sk-head">
          <p className="sk-lead">
            <Link to={back} className="sk-back">Sketches</Link>
            <span aria-hidden="true" className="sk-sep">·</span>
            {renaming && canWrite ? (
              <TitleEditor sketch={sketch} onDone={(title) => {
                setRenaming(false);
                if (title && title !== sketch.title) { doc.perform([{ kind: 'rename', title }], 'renamed the sketch'); say(`Renamed to ${quote(title)}`, true); }
              }} />
            ) : (
              <button type="button" className="sk-title" disabled={!canWrite} aria-label={canWrite ? `Rename sketch ${sketch.title}` : undefined} onClick={() => setRenaming(true)}>{sketch.title}</button>
            )}
            <span className="sk-aud"><Icon name={sketch.scope === 'project' ? 'people' : 'lock'} size={12} />{audience(sketch, me.user.id, projectName, dmAudience)}</span>
          </p>
          {/* #96: a DM sketch can be copied into a project, after an exact preview in Details. */}
          {sketch.scope === 'dm' && canWrite ? (
            <Button variant="secondary" className="sk-promote" onClick={() => openDetails({ kind: 'promote-sketch', sketchId: sketch.id, title: sketch.title })}>Make it a project…</Button>
          ) : null}
          <div className="seg sk-mode" role="radiogroup" aria-label="Show as">
            {(['map', 'list'] as const).map((m) => (
              <button key={m} type="button" role="radio" className="seg__b" aria-checked={mode === m} onClick={() => setMode(m)}>{m === 'map' ? 'Map' : 'List'}</button>
            ))}
          </div>
        </div>

        {sketch.copies.length ? (
          <ul className="sk-copies" aria-label="Project copies">
            {sketch.copies.map((copy) => (
              <li key={copy.sketchId}><Icon name="check" size={12} />Copied to <Link to={`/projects/${copy.projectId}/map/${copy.sketchId}`}>{copy.projectName}</Link> · {when(copy.copiedAt)}<span className="sk-origin__long"> · later changes here stay in this conversation</span><span className="sk-origin__short"> · not synced</span></li>
            ))}
          </ul>
        ) : null}
        {sketch.origin ? (
          <p className="sk-origin"><Icon name="lock" size={12} />Copied from a direct message by {sketch.origin.copiedBy.id === me.user.id ? 'you' : sketch.origin.copiedBy.name} · {when(sketch.origin.copiedAt)}<span className="sk-origin__long">. Only the thoughts were copied; the conversation stays private.</span><span className="sk-origin__short"> · the conversation stays private</span></p>
        ) : null}

        {canWrite ? (
          <div className={`sk-bar${doc.problem ? ' sk-bar--problem' : ''}`}>
            <div className={`sk-tools${sketch.scope === 'project' ? ' sk-tools--seven' : ''}`} role="toolbar" aria-label="Sketch tools">
            <button type="button" className="ui-btn ui-btn--quiet sk-add" onClick={() => add(selection[selection.length - 1] ?? null)}><Icon name="plus" size={14} />Thought</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-pressed={!!connectFrom} onClick={connect} aria-label="Connect"><Icon name="link" size={14} /><span className="sk-bl">Connect</span></button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={selection.length !== 1} onClick={() => {
              if (selection.length !== 1) { say('Select one thought, then Edit'); return; }
              startEdit(selection[0]!);
            }} aria-label="Edit"><Icon name="edit" size={14} /><span className="sk-bl">Edit</span></button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={cycleShape} aria-label="Change shape"><Icon name="shape" size={14} /><span className="sk-bl">Shape</span></button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={() => remove(selection)} aria-label="Remove from sketch"><Icon name="trash" size={14} /><span className="sk-bl">Remove</span></button>
            {sketch.scope === 'project' ? <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={() => void makeWork()} aria-label="Create work from selected thoughts"><Icon name="tasks" size={14} /><span className="sk-bl sk-bl--long">Create work</span><span className="sk-bl sk-bl--short">Task</span></button> : null}
            <span className="sk-div" aria-hidden="true" />
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!doc.canUndo} onClick={undo} aria-label="Undo"><Icon name="undo" size={14} /><span className="sk-bl">Undo</span></button>
            </div>
            <p className="sk-status" role="status">
              {doc.problem ? <span className="sk-warn">{doc.problem}</span> : status.text}
              {!doc.problem && status.change ? <span className={doc.saving ? undefined : 'sk-ok'}> · {busy}</span> : null}
            </p>
          </div>
        ) : (
          <p className="sk-readonly"><Icon name="lock" size={12} />{sketch.scope === 'dm'
            ? 'Nobody else is in this conversation now, so the sketch is read-only until the other person reopens it.'
            : 'You can look at this sketch; people who can change it keep it up to date.'}</p>
        )}

        {/* Pressing these keeps focus in the editor. Safari and macOS Firefox never focus a pressed
            button: the editor would blur first, and leaving the field saves, even for Cancel edit. */}
        {editing && canWrite ? <div className="sk-edit-controls" role="group" aria-label="Current thought edit" onMouseDown={(event) => event.preventDefault()}>
          <Button disabled={editing.saving || !editing.initial.trim()} onClick={() => void finishEdit(editing.initial)}>{editing.saving ? 'Saving…' : 'Save edit'}</Button>
          <Button variant="secondary" disabled={editing.saving} onClick={() => void finishEdit(null)}>Cancel edit</Button>
        </div> : null}

        {capture.draft ? <DraftCapture draft={capture.draft} parent={capture.draft.parentId ? find(capture.draft.parentId)?.text ?? null : null}
          saving={savingDraft} canWrite={canWrite} onText={(text) => { if (capture.draft) capture.set({ ...capture.draft, text, key: doc.newId() }); }}
          onSave={() => void saveDraft()} onCancel={() => { capture.set(null); say('Thought draft cancelled'); focusThought('.sk-add'); }} /> : null}

        {editingState && (!editing || !canWrite) ? <label className="sk-draft">Your unsaved edit is kept
          <textarea aria-label="Recoverable thought edit" readOnly value={editingState.initial} />
          <Button variant="secondary" onClick={() => setEditing(null)}>Discard edit</Button>
        </label> : null}

        {mode === 'map' ? (
          sketch.thoughts.length || canWrite ? (
            <>
              <SketchMap {...shared} coarse={coarse} compact={phone} helpId={helpId} heights={heights} onMove={move} onResize={resize} onClear={() => { if (connectFrom) return; setSelection([]); say(''); }} />
              {!sketch.thoughts.length ? <p className="sk-first">An empty sketch. Add the first thought with <b>Thought</b>, then keep adding with the <b>+</b> beside it.</p> : null}
            </>
          ) : <p className="sk-empty-list">No thoughts yet.</p>
        ) : (
          <SketchList {...shared} personalOutline={personalOutline} onNavigate={navigateThought} />
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
