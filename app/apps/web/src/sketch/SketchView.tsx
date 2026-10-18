import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { DEFAULT_THOUGHT_SIZE, imageTypeOf, SKETCH_LIMITS, THOUGHT_SHAPES, WORK_LIMITS, type SketchDetail } from '@flux/contracts';
import { Button, EmptyState, Icon, MEDIA, Spinner, useMediaQuery } from '../ui';
import { getProject } from '../api/sketches';
import { ApiError, NetworkError } from '../api/client';
import { stageFile } from '../composer/api';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { setReloadRetention } from '../app/reload-retention';
import { firstLine } from '../work/format';
import { DraftSaveNotSentError, useSketchDoc, type Op } from './doc';
import { useLiveSketchDoc, type LiveSketchDoc } from './live-doc';
import { useEditingCapability } from '../editing/capability';
import { audience, quote, sketchHref, when } from './format';
import { freeSpot, rectOf } from './geometry';
import { SketchList } from './SketchList';
import { SketchMap } from './SketchMap';
import { ConnectionLabels, type ConnectionTarget } from './ConnectionLabels';
import { planReparent } from './outline';
import { useOutline } from './useOutline';
import { useThoughtDraft, type DraftLine, type ThoughtDraft } from './createdDraft';
import { DraftCapture, draftReady } from './DraftCapture';
import { clipboardFile, IMAGE_CAPTION, IMAGE_THOUGHT_SIZE, imageRefusal, linkOf, pastedImageName, pastedText } from './paste';
import { useThoughtTasks } from './ThoughtTasks';
import { useRegisterLiveHere } from '../live/LiveProvider';
import './sketch.css';
import '../editing/editing.css';
import { RefLink } from '../place/origin';

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

/** Why a pasted image could not be staged, in words; nothing was drafted or shared. */
function uploadProblem(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404) return 'You can no longer add to this map, so the image was not uploaded.';
    if (error.status === 413) return 'That image is larger than 5 MB, so it was not uploaded.';
    if (error.code === 'UPLOAD_QUOTA_EXCEEDED') return 'Too many of your uploads are waiting in this project; unused ones expire after 7 days. Nothing was pasted.';
  }
  if (error instanceof NetworkError) return 'Flux could not be reached, so the image was not uploaded. Paste it again.';
  return 'The image could not be uploaded, so nothing was pasted. Paste it again.';
}

const VIEW_ONLY = 'You can look at this map but not add to it.';
/** A new single-thought draft with nothing in it yet: a paste may fill it. */
const emptyDraft = (draft: ThoughtDraft) => !draft.lines && !draft.file && !draft.text.trim();

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
  const { me } = useShellData();
  const capability = useEditingCapability();
  // Opened from a project's Map tab (#117) or a DM's Sketches (#96), the way back stays there.
  const back = projectId ? `/projects/${projectId}/map` : dmId ? `/dm/${dmId}/sketches` : '/map';
  // The live map mounts only when this API's live capability is configured (#228, #239 review);
  // otherwise the map is the ordinary one, unchanged.
  if (capability === 'loading') return <div className="sk-page sk-page--center"><Spinner label="Opening the sketch" /></div>;
  const View = capability === 'configured' ? LiveSketchView : SketchView;
  return <View key={`${me.user.id}:${sketchId}`} sketchId={sketchId} projectId={projectId} dmId={dmId} back={back} />;
}

interface ViewProps { sketchId: string; projectId?: string; dmId?: string; back?: string }

/** The ordinary map: native requests, stream refetches and local inverse undo. */
export function SketchView(props: ViewProps) {
  const { me } = useShellData();
  const doc = useSketchDoc(props.sketchId, { id: me.user.id, name: me.user.name });
  return <SketchEditor {...props} doc={doc} />;
}

/** The live map: ordered server deltas, live movement/presence and server-journal undo. */
function LiveSketchView(props: ViewProps) {
  const { me } = useShellData();
  const doc = useLiveSketchDoc(props.sketchId, { id: me.user.id, name: me.user.name });
  return <SketchEditor {...props} doc={doc} />;
}

/**
 * One sketch at `/map/:sketchId` (issue #69): the Map with its toolbar, or the same thoughts as
 * a List. Everything is edited in place; there is no management panel. Changes save as they
 * happen and arrive live from the other people who can see the sketch.
 */
function SketchEditor({ sketchId, projectId, dmId, back = '/map', doc }: ViewProps & { doc: LiveSketchDoc }) {
  const { me, directMessages } = useShellData();
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = location.state as { started?: number; addThoughtFromMessage?: { messageId: string; projectId: string; body: string } } | null;
  const started = routeState?.started;
  const { sketch } = doc;
  const personalOutline = useOutline(me.user.id, sketch);
  const capture = useThoughtDraft(me.user.id, sketchId, sketch);
  const [savingDraft, setSavingDraft] = useState(false);
  const draftSaveInFlight = useRef(false);
  // #252: a pasted image is staged privately before its draft exists; nothing else starts meanwhile.
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const coarse = useMediaQuery('(pointer: coarse)');
  const phone = useMediaQuery(MEDIA.phone);
  const [mode, setModeState] = useState<Mode>(storedMode);
  const handledSource = useRef<string | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<string | null>(null);
  const closeConnections = () => { setConnectionTarget(null); setConnectionDraft(null); };
  // A fragment shown in a live session (#62) opens with the presenter's thoughts selected.
  const liveSelect = (location.state as { liveSelect?: string[] | null } | null)?.liveSelect ?? null;
  const [selectionState, setSelection] = useState<string[]>(() => liveSelect ?? []);
  const [selectedFor, setSelectedFor] = useState(location.key);
  if (selectedFor !== location.key) {
    setSelectedFor(location.key);
    if (liveSelect) setSelection(liveSelect);
  }
  // AC-2: no Shift key on touch, so a tablet's toolbar can switch tapping to adding to the selection.
  const [selectSeveral, setSelectSeveral] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // #509 AC-1: the hand tool drags the plane on any pointer; the pointer tool selects and moves.
  const [hand, setHand] = useState(false);
  // #509 AC-5: the drag hint is shown only until this person's first successful connect.
  const connectedKey = `${CONNECTED_KEY}:${me.user.id}`;
  const [linkedOnce, setLinkedOnce] = useState(() => readFlag(connectedKey));
  const [connectState, setConnectFrom] = useState<string | null>(null);
  // Narrowing to the phone cancels a connection that was armed on the wider screen.
  const [wasPhone, setWasPhone] = useState(phone);
  if (wasPhone !== phone) {
    setWasPhone(phone);
    if (phone) { setConnectFrom(null); setSelectSeveral(false); setSelection((current) => current.slice(-1)); }
  }
  const [editingState, setEditing] = useState<Editing | null>(null);
  const editSaveInFlight = useRef(false);
  const dmAudience = directMessages.find((item) => item.id === (doc.sketch?.dmId ?? dmId))?.audience ?? null;
  // "Start sketch from these messages" lands here: say what happened and who sees it.
  const [status, setStatus] = useState<{ text: string; change: boolean; selection?: boolean }>(() => ({
    text: started ? `Started from ${started} ${started === 1 ? 'message' : 'messages'} · ${dmAudience ? `${dmAudience.replace(/^Only /, 'only ')} can see it` : 'it stays in this conversation'}` : '',
    change: false,
  }));
  const { hash } = location;
  const [renaming, setRenaming] = useState<boolean>(!!(location.state as { fresh?: boolean } | null)?.fresh);
  const [heights] = useState(() => new Map<string, number>());
  const rootRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const projectName = useProjectName(sketch?.projectId);
  const canWrite = sketch?.access === 'write' && !!doc.liveCanWrite;

  // UI116-4: each thought of a project sketch shows how many of the project's tasks link to it,
  // from bounded reads of the sketch's own thoughts (#170), never the project's work collection.
  // They refresh when the project's work or links change, on focus and after Create task; a
  // private or DM sketch has no linkable thoughts.
  const taskProjectId = sketch?.scope === 'project' ? sketch.projectId ?? null : null;
  const [taskRevision, setTaskRevision] = useState(0);
  const thoughtIds = useMemo(() => sketch?.thoughts.map((t) => t.id).sort() ?? [], [sketch?.thoughts]);
  const thoughtKey = thoughtIds.join(',');
  const stableIds = useMemo(() => thoughtKey ? thoughtKey.split(',') : [], [thoughtKey]);
  const tasks = useThoughtTasks(me.user.id, taskProjectId, stableIds, taskRevision);
  const workRefresh = useRef<number | null>(null);
  useEffect(() => () => { if (workRefresh.current !== null) window.clearTimeout(workRefresh.current); }, []);
  useStreamEvents(me.user.id, (event) => {
    if (!taskProjectId || event.objectType !== 'project' || event.objectId !== taskProjectId || !/^project\.(work|link|result)_/.test(event.kind)) return;
    if (workRefresh.current !== null) window.clearTimeout(workRefresh.current);
    workRefresh.current = window.setTimeout(() => { workRefresh.current = null; setTaskRevision((value) => value + 1); }, 250);
  });
  useEffect(() => {
    if (!taskProjectId) return;
    const refresh = () => { if (document.visibilityState === 'visible') setTaskRevision((value) => value + 1); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [taskProjectId]);

  const say = (text: string, change = false, selection = false) => setStatus({ text, change, selection });
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
  useEffect(() => { doc.presence(selection); }, [selection, doc.presence]);
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
    // The finished upload opens its draft; an edit started meanwhile would be closed under the person's typing.
    if (uploadingRef.current) { say('Wait for the pasted image to finish uploading'); return; }
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
    else if (ids.length === 1) say(`${quote(find(ids[0]!)?.text ?? '')} selected`, false, true);
    else say(`${ids.length} thoughts selected`, false, true);
  };

  const connectTo = (from: string, to: string) => {
    setConnectFrom(null);
    // S15: the phone views and adds only, whatever was armed before the screen narrowed.
    if (phone) return;
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
    if (!linkedOnce) { setLinkedOnce(true); writeFlag(connectedKey); }
    say(`Linked ${quote(a.text)} and ${quote(b.text)}`, true);
  };

  const pick = (id: string, extend: boolean) => {
    if (connectFrom) { connectTo(connectFrom, id); return; }
    // Phones select one thought at a time (S15); tablets add by touch while "Select several" is on.
    const additive = !phone && (extend || selectSeveral);
    const next = additive ? (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]) : [id];
    setSelection(next);
    describe(next);
  };

  const toggle = (id: string) => {
    const next = phone ? [id] : selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
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

  /** Whether a new draft may start now; says why not. `replace` lets a paste fill the open, still empty draft. */
  const blocked = (replace = false) => {
    if (!sketch) return true;
    if (!canWrite) { say(VIEW_ONLY); return true; }
    if (uploadingRef.current) { say('Wait for the pasted image to finish uploading'); return true; }
    if (editingState) { say('Finish or cancel your current edit first'); return true; }
    if (capture.draft && !(replace && emptyDraft(capture.draft) && !capture.draft.attempt && !capture.draft.unknown)) { rootRef.current?.querySelector<HTMLElement>('.sk-draft textarea, .sk-draft input')?.focus(); say('Finish or cancel your current thought draft first'); return true; }
    return false;
  };

  /** Free spots for `count` new thoughts beside the intended parent (else top left), one after another. */
  const spots = (parentId: string | null, count: number, size: { w: number; h: number }) => {
    const parent = parentId ? find(parentId) : undefined;
    const rects = (sketch?.thoughts ?? []).map((t) => rectOf(t, heights));
    const from = parent ? rectOf(parent, heights) : null;
    return Array.from({ length: count }, () => {
      const spot = freeSpot(rects, from, size, phone);
      rects.push({ ...spot, ...size });
      return spot;
    });
  };

  useEffect(() => {
    const source = routeState?.addThoughtFromMessage;
    if (!source || !sketch || handledSource.current === location.key) return;
    handledSource.current = location.key;
    if (sketch.scope !== 'project' || sketch.projectId !== source.projectId || source.projectId !== projectId
      || !/^[0-9a-f-]{36}$/i.test(source.messageId) || typeof source.body !== 'string') return;
    if (capture.draft) {
      rootRef.current?.querySelector<HTMLElement>('.sk-draft textarea, .sk-draft input')?.focus();
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    const spot = spots(null, 1, { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height })[0]!;
    capture.set({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), parentId: null,
      text: source.body.slice(0, SKETCH_LIMITS.text).trim(), x: spot.x, y: spot.y, tracked: true, sourceProjectMessageId: source.messageId });
    navigate(location.pathname, { replace: true, state: null });
  // This consumes one route-state command after the destination sketch loads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.pathname, routeState?.addThoughtFromMessage, sketch, projectId]);

  /** `at` is where a dragged dot was released (P12); the draft stays local until it is saved. */
  const add = (parentId: string | null, text = '', replace = false, at?: { x: number; y: number }) => {
    if (blocked(replace)) return;
    // S15 applies to every entry point, including + on a focused thought and clipboard drafts.
    if (phone) parentId = null;
    const [spot] = at ? [at] : spots(parentId, 1, { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height });
    capture.set({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), text, x: spot!.x, y: spot!.y, parentId, tracked: true });
    setConnectFrom(null);
    setEditing(null);
    say(!text ? (at ? 'Private connected thought draft · Enter saves, Escape cancels' : 'Private thought draft · Enter saves, Escape cancels')
      : `Private ${linkOf(text) ? 'link' : 'thought'} draft from the clipboard · Enter saves, Escape cancels`);
  };

  /** The dot without a pointer: Enter or Space starts a connection from this thought; choose the other one next. */
  const connectFromDot = (id: string) => {
    if (!canWrite || phone) return;
    if (connectFrom === id) { setConnectFrom(null); say('Connect cancelled'); return; }
    setSelection([id]);
    setConnectFrom(id);
    say(`Choose the thought to link to ${quote(find(id)?.text ?? '')} · Esc cancels`);
  };

  // #252: what is pasted becomes a private draft with the same parent rule as the Thought button; pasting into the
  // open empty draft keeps that draft's parent.
  const pasteParent = () => phone ? null : (capture.draft && emptyDraft(capture.draft) ? capture.draft.parentId : selection[selection.length - 1] ?? null);

  const pasteText = (text: string, replace: boolean) => {
    const parsed = pastedText(text);
    if (parsed.kind === 'empty') { say('Nothing to paste: the clipboard has no text or image'); return; }
    if (parsed.kind === 'too-long') { say('That paste is too long for map thoughts. Nothing was added; paste a shorter list.'); return; }
    if (parsed.kind === 'too-many') {
      say(`A paste adds at most ${SKETCH_LIMITS.pasteLines} thoughts and this one has ${parsed.count} lines. Nothing was added; paste fewer lines at a time.`);
      return;
    }
    const parentId = pasteParent();
    if (parsed.kind === 'one' && parsed.text.length <= SKETCH_LIMITS.text) { add(parentId, parsed.text, replace); return; }
    // Several lines, or one line too long for a thought (marked, so it can be shortened before Save).
    const lines = parsed.kind === 'one' ? [parsed.text] : parsed.lines;
    const places = spots(parentId, lines.length, { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height });
    capture.set({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), text: '', x: places[0]!.x, y: places[0]!.y, parentId, tracked: true,
      lines: lines.map((line, index): DraftLine => ({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), text: line, x: places[index]!.x, y: places[index]!.y })) });
    setConnectFrom(null);
    setEditing(null);
    say(`${lines.length} private draft ${lines.length === 1 ? 'thought' : 'thoughts'} from the clipboard · check, then Save`);
  };

  const pasteImage = async (file: Blob) => {
    if (!sketch) return;
    if (sketch.scope !== 'project' || !sketch.projectId) { say('Images can be added to a project’s maps only. Paste text or a link here instead.'); return; }
    const refusal = imageRefusal(file);
    if (refusal) { say(refusal); return; }
    const projectId = sketch.projectId;
    const parentId = pasteParent();
    const [spot] = spots(parentId, 1, { w: IMAGE_THOUGHT_SIZE.width, h: IMAGE_THOUGHT_SIZE.height });
    uploadingRef.current = true;
    setUploading(true);
    const retainedUpload = Symbol('private thought image upload');
    setReloadRetention('thought', retainedUpload, me.user.id, true);
    try {
      const type = imageTypeOf(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
      if (!type) { say('That file is not a PNG, JPEG, GIF or WebP image, so nothing was pasted.'); return; }
      say('Uploading the image privately · only you can see it until you save');
      const staged = await stageFile(projectId, crypto.randomUUID(), new File([file], pastedImageName(type), { type }));
      const meanwhile = capture.peek();
      if (meanwhile && !emptyDraft(meanwhile)) { say('The image stays private and unused: you started another draft meanwhile.'); return; }
      capture.set({ id: doc.newId(), linkId: doc.newId(), key: doc.newId(), text: IMAGE_CAPTION, x: spot!.x, y: spot!.y, parentId, tracked: true,
        file: { id: staged.id, name: staged.name, size: staged.size }, width: IMAGE_THOUGHT_SIZE.width, height: IMAGE_THOUGHT_SIZE.height });
      setConnectFrom(null);
      setEditing(null);
      say('Private image draft · change the caption if you like, then Save');
    } catch (error) {
      say(uploadProblem(error));
    } finally {
      setReloadRetention('thought', retainedUpload, me.user.id, false);
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const handlePaste = (data: { text: string; file: Blob | null }, replace = false) => {
    if (blocked(replace)) return;
    if (data.file) void pasteImage(data.file);
    else pasteText(data.text, replace);
  };

  /**
   * Touch devices have no paste shortcut on the map: the empty new-thought draft offers Paste, which reads the
   * clipboard through the browser's own prompt and fills that draft.
   */
  const pasteFromClipboard = async () => {
    if (blocked(true)) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    try {
      if (clipboard?.read) {
        const items = await clipboard.read();
        for (const item of items) {
          const type = item.types.find((candidate) => candidate.startsWith('image/'));
          if (type) { handlePaste({ text: '', file: await item.getType(type) }, true); return; }
        }
        const text = items.find((item) => item.types.includes('text/plain'));
        handlePaste({ text: text ? await (await text.getType('text/plain')).text() : '', file: null }, true);
        return;
      }
      if (clipboard?.readText) { handlePaste({ text: await clipboard.readText(), file: null }, true); return; }
      say('This browser doesn’t let Flux read the clipboard. Add a Thought and paste into its text instead.');
    } catch {
      say('The browser didn’t allow reading the clipboard. Add a Thought and paste into its text instead.');
    }
  };

  // Ctrl/⌘ V on the map or list, or on what holds it (the page, or the main pane a click on empty canvas focuses).
  // Elsewhere (sidebar, details) is not the map. Text fields keep their own paste (#149 shortcuts).
  const pasteHandler = useRef(handlePaste);
  useEffect(() => { pasteHandler.current = handlePaste; });
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const root = rootRef.current;
      if (!root || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && !root.contains(target) && !target.contains(root)) return;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault();
      pasteHandler.current({ text: event.clipboardData?.getData('text/plain') ?? '', file: clipboardFile(event.clipboardData) });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const saveDraft = async () => {
    let draft = capture.draft;
    if (!draft || draftSaveInFlight.current || !canWrite || !draftReady(draft)) return;
    draftSaveInFlight.current = true;
    setSavingDraft(true);
    // Normalize only unsent intent. An actual earlier attempt keeps its canonical parent
    // and payload; on a phone it may only be confirmed from existing server state.
    if (phone && draft.parentId && !(draft.lines ?? [draft]).some((row) => row.unknown)) { draft = { ...draft, parentId: null }; capture.set(draft); }
    const parent = (row: DraftLine | ThoughtDraft) => {
      const parentId = row.unknown ? null : row.attempt ? row.attempt.parentId : phone ? null : draft!.parentId;
      return parentId ? { id: parentId, linkId: row.attempt?.linkId ?? row.linkId } : null;
    };
    const items = draft.lines
      ? draft.lines.map((line) => ({ thought: line.attempt?.thought ?? { id: line.id, text: line.text.trim(), x: line.x, y: line.y }, parent: parent(line), key: line.attempt?.key ?? line.key }))
      : [{ thought: draft.attempt?.thought ?? { id: draft.id, text: draft.text.trim(), x: draft.x, y: draft.y,
        ...(draft.file ? { file: draft.file, width: draft.width, height: draft.height } : {}),
        ...(draft.sourceProjectMessageId ? { sourceProjectMessageId: draft.sourceProjectMessageId } : {}) }, parent: parent(draft), key: draft.attempt?.key ?? draft.key }];
    const existingOnly = new Set((draft.lines ?? [draft]).filter((row) => row.unknown || (phone && row.attempt?.parentId)).map((row) => row.id));
    const expectedText = new Map((draft.lines ?? [draft]).flatMap((row) => row.attempt ? [[row.id, row.attempt.thought.text] as const] : []));
    const desiredText = new Map((draft.lines ?? [draft]).map((row) => [row.id, row.text.trim()]));
    const editKeys = new Map((draft.lines ?? [draft]).map((row) => [row.id, row.editKey ?? row.key]));
    const retry = new Set((draft.lines ?? [draft]).filter((row) => !!row.attempt).map((row) => row.id));
    const saved = await doc.saveThoughts(items, { existingOnly, expectedText, desiredText, editKeys, retry, onAttempt: (item) => {
      const current = capture.peek();
      if (!current) throw new DraftSaveNotSentError();
      const row = current.lines?.find((line) => line.id === item.thought.id) ?? current;
      const attempt = { key: item.key, parentId: item.parent?.id ?? null, linkId: item.parent?.linkId ?? row.linkId, thought: item.thought };
      if (!capture.prepareAttempt(attempt)) throw new DraftSaveNotSentError();
    } });
    setSavingDraft(false);
    draftSaveInFlight.current = false;
    if (saved.length < items.length) {
      // Confirmed thoughts are shared now; only the rest stay in the draft, with their IDs and request keys.
      const retained = capture.peek() ?? draft;
      if (retained.lines && saved.length) capture.set({ ...retained, lines: retained.lines.filter((line) => !saved.includes(line.id)) });
      say('Couldn’t confirm the save. Your thought draft is kept; try again.');
      return;
    }
    capture.set(null);
    setSelection(saved);
    say(saved.length === 1 ? `Added ${quote(desiredText.get(saved[0]!) ?? items[0]!.thought.text)}` : `Added ${saved.length} thoughts`, true);
    focusThought(`.sk-node[data-id="${saved[0]}"], .sk-li-t[data-id="${saved[0]}"]`);
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

  /**
   * #510 AC-6: Tab / Shift+Tab in the List put a thought under another one. The List is the map's tree,
   * so the thought's connection to its parent moves to the new parent, keeping its label; its other
   * connections stay. Outdenting from the top branch disconnects it from its parent. One undoable step.
   */
  const reparent = (id: string, parentId: string | null, how: 'indent' | 'outdent') => {
    if (!sketch || !canWrite || phone) return;
    const thought = find(id);
    if (!thought) return;
    const plan = planReparent(sketch.thoughts, sketch.links, personalOutline.state, id, parentId, doc.newId());
    if (!plan.ok) {
      // A thought with another parent would read under that one instead (the oldest wins): say so, change nothing.
      const other = find(plan.thoughtId);
      const under = plan.under ? find(plan.under) : undefined;
      say(!other || !under ? `${quote(thought.text)} can’t be moved there. Use Connections.`
        : other.id === id ? `${quote(thought.text)} is also under ${quote(under.text)}. Use Connections to change that.`
        : `Moving ${quote(thought.text)} there would also move ${quote(other.text)}. Use Connections.`);
      return;
    }
    if (!plan.steps.length) return;
    doc.perform(plan.steps, how === 'indent' ? 'indented a thought' : 'outdented a thought');
    setSelection([id]);
    say(`${how === 'indent' ? 'Indented' : 'Outdented'} ${quote(thought.text)}`, true);
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
    doc.perform([{ kind: 'move', moves }], how === 'keyboard' ? 'moved with the keyboard' : 'moved thoughts', { coalesce: how === 'keyboard', lease: how === 'drag' ? doc.finishGesture() : undefined });
    const what = moves.length === 1 ? quote(find(moves[0]!.id)?.text ?? '') : `${moves.length} thoughts`;
    say(`Moved ${what}${how === 'keyboard' ? ' with the keyboard' : ''}`, true);
  };

  const resize = (id: string, width: number, height: number, how: 'drag' | 'keyboard') => {
    doc.perform([{ kind: 'update', id, changes: { width, height } }], 'resized a thought', { lease: how === 'drag' ? doc.finishGesture() : undefined });
    say(`Resized ${quote(find(id)?.text ?? '')}`, true);
  };

  const cycleShape = () => {
    const thoughts = selection.flatMap((id) => { const t = find(id); return t ? [t] : []; });
    if (!thoughts.length) { say('Select a thought first, then Shape'); return; }
    const next = THOUGHT_SHAPES[(THOUGHT_SHAPES.indexOf(thoughts[0]!.shape) + 1) % THOUGHT_SHAPES.length]!;
    doc.perform(thoughts.map((t): Op => ({ kind: 'update', id: t.id, changes: { shape: next } })), 'changed the shape');
    say(`Shape: ${next === 'card' ? 'card' : next === 'pill' ? 'pill' : 'circle'}`, true);
  };

  // #101, #509 (moved from #345): the selected thoughts of a project sketch become one task through the one Create window,
  // with the thoughts as its linked sources; the person completes it there. The map keeps its thoughts.
  const { openDetails, openCreate } = useShellActions();
  const makeWork = () => {
    const thoughts = selection.flatMap((id) => { const t = find(id); return t ? [t] : []; });
    if (!thoughts.length || !sketch?.projectId) { say('Select thoughts first, then Create task'); return; }
    const title = thoughts.length === 1 ? thoughts[0]!.text : `Explore: ${thoughts.map((t) => t.text).join(', ')}`;
    openCreate({
      kind: 'task',
      projectId: sketch.projectId,
      title: title.slice(0, WORK_LIMITS.title),
      sources: thoughts.map((t) => ({ ref: { type: 'thought' as const, id: t.id }, label: firstLine(t.text, 80) })),
      onCreated: () => { setTaskRevision((value) => value + 1); say(`Created a task from ${thoughts.length === 1 ? quote(thoughts[0]!.text) : `${thoughts.length} thoughts`}; the thoughts stay on the map`); },
    });
  };

  const undo = () => {
    if (editingState) { say('Finish or cancel your current edit first'); return; }
    setEditing(null);
    setConnectFrom(null);
    const label = doc.undo();
    // Only the live map's undo waits for a server receipt; the ordinary one is applied at once.
    if (doc.liveStatus === 'unavailable') say(label ? `Undid: ${label}` : 'Nothing to undo');
    else say(label ? `Undo requested: ${label}. Waiting for confirmation.` : 'No undo started');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[role="dialog"]')) return;
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
            {connectionDraft !== null ? <label>Your unsaved connection label<textarea aria-label="Recoverable connection label" readOnly value={connectionDraft} /></label> : null}
            {capture.draft ? <label>Your private thought draft<textarea aria-label="Recoverable thought draft" readOnly value={capture.draft.lines ? capture.draft.lines.map((line) => line.text).join('\n') : capture.draft.text} /></label> : null}
            {editingState ? <label>Your unsaved edit<textarea aria-label="Recoverable thought edit" readOnly value={editingState.initial} /></label> : null}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!sketch) return null;

  const busy = doc.saving ? 'Saving…' : 'Saved';
  const shared = { sketch, confirmedThoughts: doc.confirmedThoughts, meId: me.user.id, selection, connectFrom, editing, canWrite, onPick: pick, onToggle: toggle, onEdit: startEdit,
    onEditText: (text: string) => setEditing((current) => current ? { ...current, initial: text, key: doc.newId() } : null),
    onFinishEdit: (text: string | null) => { void finishEdit(text); }, onAdd: add, onRemove: remove, onEscape: escape,
    tasks, projectId: taskProjectId, onOpenTask: (id: string) => openDetails({ kind: 'work', id }) };
  const navigateThought = (id: string, previous?: string[]) => {
    if (!present.has(id)) return;
    setConnectFrom(null);
    const next = previous?.filter((item) => present.has(item)) ?? [id];
    setSelection(next);
    describe(next);
  };

  const mapMode = mode === 'map';
  const viewModes = <div className="seg sk-mode" role="radiogroup" aria-label="Show as">
    {(['map', 'list'] as const).map((m) => (
      <button key={m} type="button" role="radio" className="seg__b" aria-checked={mode === m} onClick={() => setMode(m)}>{m === 'map' ? 'Map' : 'List'}</button>
    ))}
  </div>;
  const head = (
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
            <span className="sk-aud" title="Who can see this map"><Icon name={sketch.scope === 'project' ? 'people' : 'lock'} size={12} />{audience(sketch, me.user.id, projectName, dmAudience)}</span>
          </p>
          {/* #96: a DM sketch can be copied into a project, after an exact preview in Details. */}
          {sketch.scope === 'dm' && canWrite ? (
            <Button variant="secondary" className="sk-promote" onClick={() => openDetails({ kind: 'promote-sketch', sketchId: sketch.id, title: sketch.title })}>Make it a project…</Button>
          ) : null}
          {!phone || !mapMode || (!sketch.thoughts.length && !canWrite) ? viewModes : null}
        </div>
  );
  const confirmPrevious = !!capture.draft && (capture.draft.lines ?? [capture.draft]).some((row) => row.unknown || (phone && row.attempt?.parentId));
  const pendingParents = capture.draft ? new Set((capture.draft.lines ?? [capture.draft]).map((row) => row.unknown ? null : row.attempt ? row.attempt.parentId : capture.draft!.parentId)) : new Set<string | null>();
  const attemptParent = pendingParents.size === 1 ? [...pendingParents][0] : null;
  const shownDraft = capture.draft ? { ...capture.draft, parentId: phone ? null : attemptParent ?? null } : null;
  const draftForm = (focusReady = true) => shownDraft ? <DraftCapture draft={shownDraft} focusReady={focusReady} parent={shownDraft.parentId ? find(shownDraft.parentId)?.text ?? null : null}
    confirmPrevious={confirmPrevious} mixedParents={pendingParents.size > 1}
    saving={savingDraft} canWrite={canWrite} onText={(text) => { if (capture.draft) capture.set({ ...capture.draft, text,
      key: capture.draft.attempt || capture.draft.unknown ? capture.draft.key : doc.newId(), editKey: doc.newId() }); }}
    onLines={(lines) => {
      if (!capture.draft) return;
      if (lines.length) { capture.set({ ...capture.draft, lines }); return; }
      capture.set(null); say('Pasted thoughts cancelled'); focusThought('.sk-add');
    }}
    onPaste={coarse ? () => void pasteFromClipboard() : undefined}
    onSave={() => void saveDraft()} onCancel={() => { capture.set(null); say(capture.draft?.lines ? 'Pasted thoughts cancelled' : 'Thought draft cancelled'); focusThought('.sk-add'); }} /> : null;
  const notices = (
    <>
        {doc.privateMovement ? <details className="editing-map-recovery"><summary>An unfinished movement is kept privately</summary><p>Compare these positions with the current thoughts before starting a new movement. This copy is not shared automatically.</p><ul>{doc.privateMovement.positions.map((position) => <li key={position.id}>{quote(find(position.id)?.text ?? 'Unavailable thought')} · x {Math.round(position.x)}, y {Math.round(position.y)}{position.width !== undefined ? ` · width ${Math.round(position.width)}, height ${Math.round(position.height ?? 0)}` : ''}</li>)}</ul><Button variant="quiet" onClick={doc.discardPrivateMovement}>Discard private movement copy</Button></details> : null}
        {sketch.copies.length ? (
          <ul className="sk-copies" aria-label="Project copies">
            {sketch.copies.map((copy) => (
              <li key={copy.sketchId}><Icon name="check" size={12} />Copied to <RefLink to={`/projects/${copy.projectId}/map/${copy.sketchId}`}>{copy.projectName}</RefLink> · {when(copy.copiedAt)}<span className="sk-origin__long"> · later changes here stay in this conversation</span><span className="sk-origin__short"> · not synced</span></li>
            ))}
          </ul>
        ) : null}
        {sketch.origin ? (
          <p className="sk-origin"><Icon name="lock" size={12} />Copied from a direct message by {sketch.origin.copiedBy.id === me.user.id ? 'you' : sketch.origin.copiedBy.name} · {when(sketch.origin.copiedAt)}<span className="sk-origin__long">. Only the thoughts were copied; the conversation stays private.</span><span className="sk-origin__short"> · the conversation stays private</span></p>
        ) : null}

        {/* Pressing these keeps focus in the editor. Safari and macOS Firefox never focus a pressed
            button: the editor would blur first, and leaving the field saves, even for Cancel edit. */}
        {editing && canWrite ? <div className="sk-edit-controls" role="group" aria-label="Current thought edit" onMouseDown={(event) => event.preventDefault()}>
          <Button disabled={editing.saving || !editing.initial.trim()} onClick={() => void finishEdit(editing.initial)}>{editing.saving ? 'Saving…' : 'Save edit'}</Button>
          <Button variant="secondary" disabled={editing.saving} onClick={() => void finishEdit(null)}>Cancel edit</Button>
        </div> : null}

        {!mapMode ? draftForm() : null}
        {uploading ? <p className="sk-draft sk-draft--uploading" role="status"><Icon name="image" size={14} />Uploading the pasted image privately…</p> : null}

        {editingState && (!editing || !canWrite) ? <label className="sk-draft">Your unsaved edit is kept
          <textarea aria-label="Recoverable thought edit" readOnly value={editingState.initial} />
          <Button variant="secondary" onClick={() => setEditing(null)}>Discard edit</Button>
        </label> : null}
    </>
  );
  const sayLine = doc.problem ? <span className="sk-warn">{doc.problem}</span> : status.text;
  const statusLine = (
    <p className={`sk-status${canWrite ? '' : ' sk-status--readonly'}${phone && status.selection && !doc.problem ? ' sk-status--selection' : ''}`} role="status">
      {sayLine}
      {!doc.problem && status.change ? <span className={doc.saving ? undefined : 'sk-ok'}> · {busy}</span> : null}
    </p>
  );
  const hasStatus = !!doc.problem || !!status.text;
  const helpText = phone
    ? 'Tap a thought to select it. Add a thought, then Paste, fills a draft from copied lines, a link or an image. List shows the same thoughts in order.'
    : coarse
      ? 'Tap a thought to select it, then drag it, or drag its dot onto another thought to connect them. Pinch with two fingers to zoom; Move around makes one finger drag the map. Add links a new thought to it. Select several adds taps to the selection. Thought, then Paste, turns copied lines, a link or an image into a draft. List shows the same thoughts in order.'
      : 'Drag to move, drag a thought’s dot onto another thought to connect, or release it on empty space for a connected draft thought. Drag empty space, or hold Space and drag, to move around; with the map itself focused, arrows move the view. Ctrl/⌘ + wheel or a pinch zooms around the pointer. Shift-click to select several. On a focused thought: arrows move (Shift further, Alt resizes) · Enter edits · Space selects · Enter on the dot connects · + adds a linked thought · Delete removes · Ctrl/⌘ Z undoes · Ctrl/⌘ V pastes lines, a link or an image as a draft.';

  if (mapMode && !(sketch.thoughts.length || canWrite)) {
    return (
      <div className="sk-page" ref={rootRef} onKeyDown={onKeyDown} data-live-map-status={doc.liveStatus}><div className="sk">{head}<p className="sk-empty-list">No thoughts yet.</p></div></div>
    );
  }
  // #509 AC-5 / #510 AC-5: one toolbar at the bottom, the same element in the Map and the List, so
  // switching moves nothing (Spokój rule 7). The pointer tools only act on the canvas; in the List
  // they are dimmed, not removed, so + Thought, Create task and Undo keep their places.
  const dock = canWrite && !phone ? (
    <div className="sk-tools" role="toolbar" aria-label="Sketch tools">
      <button type="button" className="sk-tool" aria-label="Select" aria-pressed={mapMode && !connectFrom && !hand} aria-disabled={!mapMode} data-tip="Select"
        onClick={() => { if (!mapMode) return; setHand(false); if (connectFrom) escape(); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M3.5 2.5 12 6.2 8 7.6 6.6 11.7z" /></svg>
      </button>
      <button type="button" className="sk-tool" aria-label="Move around" aria-pressed={mapMode && hand} aria-disabled={!mapMode} data-tip="Move around: drag to pan"
        onClick={() => { if (!mapMode) return; setHand(!hand); if (connectFrom) escape(); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8.5V3.75a1 1 0 012 0V7.5M7 7.5V2.75a1 1 0 012 0V7.5M9 7.5V3.5a1 1 0 012 0v4M11 7V5.25a1 1 0 012 0V10a4 4 0 01-4 4H7.75a4 4 0 01-3-1.4L2.75 10.1a1 1 0 011.4-1.4L5 9.9" /></svg>
      </button>
      <span className="sk-div" aria-hidden="true" />
      <button type="button" className="ui-btn ui-btn--quiet sk-add" onClick={() => add(selection[selection.length - 1] ?? null)}><Icon name="plus" size={14} />Thought</button>
      {coarse ? <button type="button" className="ui-btn ui-btn--quiet sk-select-several" aria-label="Select several" title="Select several" aria-pressed={selectSeveral} onClick={() => { setSelectSeveral(!selectSeveral); say(selectSeveral ? 'Tapping selects one thought' : 'Tap thoughts to add them to the selection'); }}><Icon name="check" size={14} /><span className="sk-bl">Select several</span></button> : null}
      {sketch.scope === 'project' ? <button type="button" className="ui-btn ui-btn--quiet sk-task-btn" aria-disabled={!selection.length} onClick={() => makeWork()} aria-label="Create task from selected thoughts"><Icon name="tasks" size={14} />Create task</button> : null}
      <span className="sk-div" aria-hidden="true" />
      <button type="button" className="sk-tool" aria-label="Undo" data-tip="Undo" aria-disabled={!doc.canUndo} onClick={undo}><Icon name="undo" size={16} /></button>
    </div>
  ) : null;
  const readonlyNote = !canWrite ? <p className="sk-readonly"><Icon name="lock" size={12} />{doc.liveStatus === 'connecting' ? 'Reconnecting to the shared map. Wait for confirmation before changing it.' : sketch.scope === 'dm'
    ? 'Nobody else is in this conversation now, so the sketch is read-only until the other person reopens it.'
    : 'You can look at this sketch; people who can change it keep it up to date.'}</p> : null;

  if (mapMode) {
    // F-026: the map fills the pane; the header, the tools and the notices float over it.
    const hint = canWrite ? (
      <div className="sk-line">
        {statusLine}
        {!hasStatus && !phone && !linkedOnce ? <p className="sk-hint">Drag empty space to move around · Drag a dot to connect or add a thought</p> : null}
      </div>
    ) : <div className="sk-line">{statusLine}</div>;
    return (
      <div className="sk-page sk-page--map" ref={rootRef} onKeyDown={onKeyDown} data-live-map-status={doc.liveStatus}>
        <div className="sk sk--map">
          <div className="sk-over">
            {head}
            {readonlyNote}
            {notices}
          </div>
          <SketchMap {...shared} coarse={coarse} compact={phone} helpId={helpId} heights={heights} dock={dock} hint={hint} viewModes={viewModes} hand={hand}
            onLabel={(linkId) => setConnectionTarget({ linkId })} onConnections={(thoughtId) => setConnectionTarget({ thoughtId })}
            bar={{ project: sketch.scope === 'project', canUndo: doc.canUndo, helpOpen, onShape: cycleShape, onTask: () => makeWork(), onUndo: undo, onHelp: () => setHelpOpen(!helpOpen) }}
            onConnect={connectTo} onAddAt={(parentId, x, y) => add(parentId, '', false, { x, y })} onConnectFrom={connectFromDot} onAddThought={() => add(selection[selection.length - 1] ?? null)}
            draftEditor={shownDraft ? draftForm : null} draft={shownDraft && !shownDraft.lines && !sketch.thoughts.some((thought) => thought.id === shownDraft.id)
              ? { x: shownDraft.x, y: shownDraft.y, parentId: shownDraft.parentId, label: shownDraft.attempt ? 'Save not confirmed' : shownDraft.unknown ? 'Saved state unknown' : 'Draft · not saved' }
              : null} onMove={move} onResize={resize} onClear={() => { if (connectFrom) return; setSelection([]); say(''); }}
            onGestureStart={doc.beginGesture} onGesturePreview={doc.previewGesture} onGestureCancel={doc.cancelGesture} ownGesture={doc.ownGesture} liveEnabled={doc.liveStatus !== 'unavailable'}
            presenceStore={doc.presenceStore} onPointer={doc.pointer}
            movers={new Map([...doc.previews?.values() ?? []].flatMap((preview) => preview.positions.map((position) => [position.id, preview.actor.name] as [string, string])))}
            livePreviews={new Map([...doc.previews?.values() ?? []].flatMap((preview) => preview.positions.map((position) => [position.id, preview] as [string, typeof preview])))} />
          {!sketch.thoughts.length ? <p className="sk-first">{phone
            ? <>An empty sketch. Start with <b>Add a thought</b>.</>
            : <>An empty sketch. Add the first thought with <b>Thought</b>, then keep adding with the <b>+</b> beside it.</>}</p> : null}
          <p className={`sk-help${helpOpen ? ' is-open' : ''}`} id={helpId}>{helpText}</p>
          {connectionTarget ? <ConnectionLabels sketch={sketch} target={connectionTarget} editable={canWrite && !phone}
            onSave={doc.saveLinkLabel} onDraftChange={setConnectionDraft} onClose={closeConnections} /> : null}
        </div>
      </div>
    );
  }

  const listHelp = canWrite && !phone
    ? 'Arrows move between thoughts and select them; Left and Right fold and unfold a branch. Enter adds a thought beside the selected one, + adds a child, Space opens it for editing, Delete removes it. Tab puts the selected thought under the one above it and Shift+Tab moves it out a level; its connection on the map moves with it. Alt with Up or Down moves it among its neighbours in your list only. Shift+F10 moves to the selected thought’s actions. Escape clears the selection, and Tab then leaves the list.'
    : 'Arrows move between thoughts; Left and Right fold and unfold a branch. Alt with Up or Down moves a thought among its neighbours in your list only.';
  const list = <SketchList {...shared} arrange={!phone} helpId={helpId} personalOutline={personalOutline} onNavigate={navigateThought}
    onReparent={reparent} onConnectFrom={connectFromDot} onConnections={(thoughtId) => setConnectionTarget({ thoughtId })}
    onTask={sketch.scope === 'project' ? () => makeWork() : null} onSay={(text) => say(text)} />;
  const connections = connectionTarget ? <ConnectionLabels sketch={sketch} target={connectionTarget} editable={canWrite && !phone}
    onSave={doc.saveLinkLabel} onDraftChange={setConnectionDraft} onClose={closeConnections} /> : null;

  if (!phone) {
    // #510 AC-5: the List keeps the map's frame. The "Sketches · name · Map|List" pill floats at the same
    // top left and the same toolbar sits at the same bottom centre; only the content between them changes.
    return (
      <div className="sk-page sk-page--map sk-page--list" ref={rootRef} onKeyDown={onKeyDown} data-live-map-status={doc.liveStatus}>
        <div className="sk sk--map">
          <div className="sk-list-scroll">
            {list}
            <p className="sk-help" id={helpId}>{listHelp}</p>
          </div>
          <div className="sk-over">
            {head}
            {readonlyNote}
            {notices}
          </div>
          <div className="sk-dock">
            <div className="sk-line">{statusLine}</div>
            {dock ? <div className="sk-dock__row">{dock}</div> : null}
          </div>
          {connections}
        </div>
      </div>
    );
  }

  return (
    <div className="sk-page" ref={rootRef} onKeyDown={onKeyDown} data-live-map-status={doc.liveStatus}>
      <div className="sk">
        {head}
        {sketch.copies.length ? (
          <ul className="sk-copies" aria-label="Project copies">
            {sketch.copies.map((copy) => (
              <li key={copy.sketchId}><Icon name="check" size={12} />Copied to <RefLink to={`/projects/${copy.projectId}/map/${copy.sketchId}`}>{copy.projectName}</RefLink> · {when(copy.copiedAt)}<span className="sk-origin__long"> · later changes here stay in this conversation</span><span className="sk-origin__short"> · not synced</span></li>
            ))}
          </ul>
        ) : null}
        {sketch.origin ? (
          <p className="sk-origin"><Icon name="lock" size={12} />Copied from a direct message by {sketch.origin.copiedBy.id === me.user.id ? 'you' : sketch.origin.copiedBy.name} · {when(sketch.origin.copiedAt)}<span className="sk-origin__long">. Only the thoughts were copied; the conversation stays private.</span><span className="sk-origin__short"> · the conversation stays private</span></p>
        ) : null}


        {canWrite ? (
          <div className={`sk-bar${doc.problem ? ' sk-bar--problem' : ''}`}>
            {/* #510 AC-4: Edit, + Child and Create task are the selected row's own actions on the phone too. */}
            <div className="sk-tools" role="toolbar" aria-label="Sketch tools">
            <button type="button" className="ui-btn ui-btn--quiet sk-add" onClick={() => add(selection[selection.length - 1] ?? null)}><Icon name="plus" size={14} />Thought</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!selection.length} onClick={() => remove(selection)} aria-label="Remove from sketch"><Icon name="trash" size={14} /><span className="sk-bl">Remove</span></button>
            <span className="sk-div" aria-hidden="true" />
            <button type="button" className="ui-btn ui-btn--quiet" aria-disabled={!doc.canUndo} onClick={undo} aria-label="Undo"><Icon name="undo" size={14} /><span className="sk-bl">Undo</span></button>
            </div>
            {statusLine}
          </div>
        ) : (
          <>
            <p className="sk-readonly"><Icon name="lock" size={12} />{doc.liveStatus === 'connecting' ? 'Reconnecting to the shared map. Wait for confirmation before changing it.' : sketch.scope === 'dm'
              ? 'Nobody else is in this conversation now, so the sketch is read-only until the other person reopens it.'
              : 'You can look at this sketch; people who can change it keep it up to date.'}</p>
            <p className="sk-status sk-status--readonly" role="status">{status.text}</p>
          </>
        )}

        {doc.privateMovement ? <details className="editing-map-recovery"><summary>An unfinished movement is kept privately</summary><p>Compare these positions with the current thoughts before starting a new movement. This copy is not shared automatically.</p><ul>{doc.privateMovement.positions.map((position) => <li key={position.id}>{quote(find(position.id)?.text ?? 'Unavailable thought')} · x {Math.round(position.x)}, y {Math.round(position.y)}{position.width !== undefined ? ` · width ${Math.round(position.width)}, height ${Math.round(position.height ?? 0)}` : ''}</li>)}</ul><Button variant="quiet" onClick={doc.discardPrivateMovement}>Discard private movement copy</Button></details> : null}

        {/* Pressing these keeps focus in the editor. Safari and macOS Firefox never focus a pressed
            button: the editor would blur first, and leaving the field saves, even for Cancel edit. */}
        {editing && canWrite ? <div className="sk-edit-controls" role="group" aria-label="Current thought edit" onMouseDown={(event) => event.preventDefault()}>
          <Button disabled={editing.saving || !editing.initial.trim()} onClick={() => void finishEdit(editing.initial)}>{editing.saving ? 'Saving…' : 'Save edit'}</Button>
          <Button variant="secondary" disabled={editing.saving} onClick={() => void finishEdit(null)}>Cancel edit</Button>
        </div> : null}

        {draftForm()}
        {uploading ? <p className="sk-draft sk-draft--uploading" role="status"><Icon name="image" size={14} />Uploading the pasted image privately…</p> : null}

        {editingState && (!editing || !canWrite) ? <label className="sk-draft">Your unsaved edit is kept
          <textarea aria-label="Recoverable thought edit" readOnly value={editingState.initial} />
          <Button variant="secondary" onClick={() => setEditing(null)}>Discard edit</Button>
        </label> : null}


        {list}
        <p className="sk-help" id={helpId}>{helpText}</p>
        {connections}
      </div>
    </div>
  );
}

const CONNECTED_KEY = 'flux.map.connected.v1';
function readFlag(key: string) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key: string) {
  try { localStorage.setItem(key, '1'); } catch { /* the hint may come back next visit */ }
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
