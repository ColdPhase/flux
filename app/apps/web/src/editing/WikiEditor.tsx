import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useRevalidator } from 'react-router';
import * as Y from 'yjs';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, Direction, EditorView, RectangleMarker, drawSelection, keymap, layer, placeholder, type DecorationSet, type LayerMarker } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { DOC_LIMITS, docRef, type Doc, type DocMention, type DocVersion, type LiveDocBootstrap, type Project } from '@flux/contracts';
import { Button, useToast } from '../ui';
import { useAgentOwners } from '../agents/owners';
import { LinkPicker, type PickedRef } from '../docs/LinkPicker';
import { docUrl, getDoc, getVersion } from '../docs/api';
import { ago } from '../docs/format';
import type { PageMode } from '../docs/DocViews';
import { Faces, PageFrame, hereToo, scrollPage, useNow, useReferenceClicks } from '../docs/WikiParts';
import { RefMark, readReferences } from '../docs/WikiRead';
import { COLLABORATION_INK, shapeOfSlot, type PeerShape } from './color';
import { RefHosts, headingsOf, livePreview, setRefData, workRefs } from './livePreview';
import { LocalWiki } from './local-wiki';
import { SharedWiki } from './wiki';
import { decode64 } from './wire';
import './editing.css';

/**
 * The page's shared room (#228). A native write elsewhere (an agent, Add to docs) can start a new generation; with
 * nothing of this editor pending, the room is opened afresh (`stale`) instead of keeping text privately.
 */
export function useSharedWiki(id: string | null, userId: string, writer = true, head: LiveDocBootstrap | null = null) {
  const [client, setClient] = useState<SharedWiki | null>(null);
  const [round, setRound] = useState(0);
  const [, refresh] = useState(0);
  const first = useRef(head);
  useEffect(() => {
    if (!id) return;
    // The head the page was read with serves the first room only; a renewed room reads its own.
    const next = new SharedWiki(id, userId, writer, round === 0 ? first.current : null);
    const unsubscribe = next.subscribe(() => {
      if (next.stale) { setRound((value) => value + 1); return; }
      setClient(next); refresh((value) => value + 1);
    });
    return () => { unsubscribe(); next.destroy(); };
  }, [id, userId, writer, round]);
  return client?.id === id && client.userId === userId && client.writer === writer && !client.stale ? client : null;
}

/** The page's text where live editing is off (#239): this tab's own copy, saved as versions. */
function useLocalWiki(doc: Doc | null, userId: string) {
  const [local, setLocal] = useState<LocalWiki | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!doc) return;
    const next = new LocalWiki(doc, userId);
    // The copy is an external resource made for this page; React holds it for the editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal(next);
    const unsubscribe = next.subscribe(() => refresh((value) => value + 1));
    return () => { unsubscribe(); next.destroy(); };
    // One copy per page and person; the page's later reads do not replace text being written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, userId]);
  return doc && local ? local : null;
}

/**
 * A collaborator's named caret is drawn in its own layer, like the local selection, never as an inline widget: a
 * widget at the same position as the local cursor became a cursor stop, so Shift+ArrowLeft at the end of the text
 * stepped over the other person's caret instead of selecting the last character. Its small name tag sits above the
 * caret (as drawn, #869); the tag is `aria-hidden`, the caret names its person.
 */
class NamedCaret implements LayerMarker {
  constructor(readonly name: string, readonly ink: string, readonly shape: PeerShape, readonly left: number, readonly top: number, readonly height: number) {}
  eq(other: LayerMarker): boolean {
    return other instanceof NamedCaret && other.name === this.name && other.ink === this.ink && other.shape === this.shape
      && other.left === this.left && other.top === this.top && other.height === this.height;
  }
  draw() {
    const element = document.createElement('div'); element.className = 'editing-caret';
    element.setAttribute('aria-label', `${this.name}'s cursor`); element.dataset.shape = this.shape;
    const label = document.createElement('span'); label.textContent = this.name; element.append(label);
    const tag = document.createElement('span'); tag.className = 'editing-caret__tag'; tag.setAttribute('aria-hidden', 'true');
    tag.textContent = this.name.split(' ')[0]!;
    element.append(tag);
    this.place(element); return element;
  }
  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof NamedCaret) || previous.name !== this.name || previous.shape !== this.shape) return false;
    this.place(element); return true;
  }
  private place(element: HTMLElement) {
    element.style.left = `${this.left}px`; element.style.top = `${this.top}px`; element.style.height = `${this.height}px`;
    element.style.borderColor = this.ink;
  }
}
interface RemoteCaret { head: number; name: string; ink: string; shape: PeerShape }
const remoteCaretsChanged = StateEffect.define<RemoteCaret[]>();
const remoteCarets = StateField.define<RemoteCaret[]>({
  create: () => [],
  update(value, transaction) {
    if (transaction.docChanged) value = value.map((caret) => ({ ...caret, head: transaction.changes.mapPos(caret.head, 1) }));
    for (const effect of transaction.effects) if (effect.is(remoteCaretsChanged)) value = effect.value;
    return value;
  },
});
const remoteCaretLayer = layer({
  above: true, class: 'editing-carets',
  update: (update) => update.docChanged || update.geometryChanged || update.viewportChanged
    || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(remoteCaretsChanged))),
  markers: (view) => view.state.field(remoteCarets).flatMap((caret) => {
    const rect = RectangleMarker.forRange(view, 'editing-caret', EditorSelection.cursor(Math.min(caret.head, view.state.doc.length)))[0];
    return rect ? [new NamedCaret(caret.name, caret.ink, caret.shape, rect.left, rect.top, rect.height)] : [];
  }),
});
/**
 * Moving to the start or end of the text comes from the editor state, not the browser. CodeMirror draws a line longer
 * than 20,000 characters only around the view and the selection; after native Ctrl+End its end was not drawn yet, so
 * Shift+ArrowLeft selected nothing (#228 Gate 4). A dispatched selection is drawn and placed exactly.
 */
function toDocumentBoundary(end: boolean, extend: boolean) {
  return (view: EditorView) => {
    const at = end ? view.state.doc.length : 0;
    view.dispatch({ selection: extend ? EditorSelection.range(view.state.selection.main.anchor, at) : EditorSelection.cursor(at), scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}
/**
 * A move by one character stays with the browser where CodeMirror has drawn the whole line. On a line it draws only in
 * part, or next to text it has not drawn, it comes from the state: WebKit's own move there left the selection collapsed
 * at the start of the line (#228 Gate 4).
 */
function byCharacter(right: boolean, extend: boolean) {
  return (view: EditorView) => {
    const head = view.state.selection.main.head;
    const forward = right === (view.textDirectionAt(head) === Direction.LTR);
    const from = forward ? head : head - 1, to = forward ? head + 1 : head;
    const drawn = (position: number) => { const line = view.lineBlockAt(position); return view.visibleRanges.some((range) => range.from <= line.from && line.to <= range.to); };
    if (from < 0 || to > view.state.doc.length || (drawn(from) && drawn(to))) return false;
    const selection = EditorSelection.create(view.state.selection.ranges.map((range) => {
      if (extend) { const moved = view.moveByChar(range, forward); return EditorSelection.range(range.anchor, moved.head, moved.goalColumn, moved.bidiLevel ?? undefined); }
      return range.empty ? view.moveByChar(range, forward) : EditorSelection.cursor(forward ? range.to : range.from);
    }), view.state.selection.mainIndex);
    if (selection.eq(view.state.selection)) return false;
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}
const stateMovement = keymap.of([
  { key: 'Mod-Home', mac: 'Cmd-ArrowUp', run: toDocumentBoundary(false, false), shift: toDocumentBoundary(false, true) },
  { key: 'Mod-End', mac: 'Cmd-ArrowDown', run: toDocumentBoundary(true, false), shift: toDocumentBoundary(true, true) },
  { key: 'ArrowLeft', run: byCharacter(false, false), shift: byCharacter(false, true) },
  { key: 'ArrowRight', run: byCharacter(true, false), shift: byCharacter(true, true) },
]);

/** Enter continues a list or a quote, as a page would; on an empty item it ends the list. */
const LIST_LINE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)|^(\s*>\s?)/;
function continueBlock(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const match = LIST_LINE.exec(line.text);
  if (!match || range.head < line.from + match[0].length) return false;
  if (!line.text.slice(match[0].length).trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'input' });
    return true;
  }
  const prefix = match[6] ?? `${match[1]}${match[2] ?? `${Number(match[3]) + 1}${match[4]}`}${match[5]}`;
  const insert = `\n${prefix}`;
  view.dispatch({ changes: { from: range.head, insert }, selection: { anchor: range.head + insert.length }, userEvent: 'input', scrollIntoView: true });
  return true;
}
/** Mod-B and Mod-I wrap the selection in bold or italic marks. */
function wrap(mark: string) {
  return (view: EditorView) => {
    if (view.state.readOnly) return false;
    const range = view.state.selection.main;
    view.dispatch({ changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      selection: range.empty ? { anchor: range.from + mark.length } : { anchor: range.from + mark.length, head: range.to + mark.length }, userEvent: 'input' });
    return true;
  };
}

const remoteMarks = StateEffect.define<DecorationSet>();
const marked = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) { value = value.map(transaction.changes); for (const effect of transaction.effects) if (effect.is(remoteMarks)) value = effect.value; return value; },
  provide: (field) => EditorView.decorations.from(field),
});
function relativeIndex(client: SharedWiki, encoded: string) {
  try { const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decode64(encoded)), client.document); return position?.type === client.text ? position.index : null; }
  catch { return null; }
}
function marks(client: SharedWiki) {
  const ranges: Range<Decoration>[] = [];
  const shape = shapes(client);
  for (const writer of client.writers) {
    const anchor = relativeIndex(client, writer.anchor), head = relativeIndex(client, writer.head);
    if (anchor === null || head === null || anchor === head) continue;
    ranges.push(Decoration.mark({ attributes: { style: `text-decoration:underline;text-decoration-color:${COLLABORATION_INK};text-underline-offset:3px`, title: `Written by ${writer.actor.name}` } }).range(Math.min(anchor, head), Math.max(anchor, head)));
  }
  for (const peer of client.peers.values()) {
    if (!peer.cursor) continue;
    const anchor = relativeIndex(client, peer.cursor.anchor), head = relativeIndex(client, peer.cursor.head);
    if (anchor === null || head === null) continue;
    // Besides the fill, a person's selection carries a line style that goes with their shape, readable without colour.
    if (anchor !== head) ranges.push(Decoration.mark({ class: 'editing-selection', attributes: { 'data-shape': shape.get(peer.actor.id) ?? 'circle', title: `Selected by ${peer.actor.name}` } }).range(Math.min(anchor, head), Math.max(anchor, head)));
  }
  return Decoration.set(ranges, true);
}
/** The same shape per person on every viewer's screen: it comes from the person's server-assigned slot in this room. */
function shapes(client: SharedWiki): Map<string, PeerShape> {
  return new Map([...client.peers.values()].map((peer) => [peer.actor.id, shapeOfSlot(peer.slot)]));
}
function carets(client: SharedWiki): RemoteCaret[] {
  const result: RemoteCaret[] = [];
  const shape = shapes(client);
  for (const peer of client.peers.values()) {
    const head = peer.cursor ? relativeIndex(client, peer.cursor.head) : null;
    if (head !== null) result.push({ head, name: peer.actor.name, ink: COLLABORATION_INK, shape: shape.get(peer.actor.id)! });
  }
  return result;
}

type Source = SharedWiki | LocalWiki;

/** The one change that turns `before` into `after`: what lies between their common start and end. */
function difference(before: string, after: string) {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > from && endAfter > from && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) { endBefore--; endAfter--; }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

/** What binds the page's text to its source: the shared room, or this tab's own copy. */
function binding(source: Source): Extension {
  const history = (run: ((view: EditorView) => boolean) | undefined, view: EditorView) => {
    // A peer can fill space left by our old deletion. Undo/redo is synchronous: if its result exceeds the body quota,
    // reverse it before this fixed batch seals or a browser paint occurs. Only the final valid merged update leaves.
    if (!run || !source.writable || source.pendingBytes + DOC_LIMITS.body * 8 + 65536 > 1024 * 1024) return false;
    const undos = source.undo.undoStack.length, redos = source.undo.redoStack.length;
    const result = run(view);
    if (source.text.length > DOC_LIMITS.body) {
      if (source.undo.undoStack.length < undos) source.undo.redo();
      else if (source.undo.redoStack.length < redos) source.undo.undo();
      source.refuseInput('This inverse would exceed 100,000 characters after another writer’s changes. The shared text stays as it was; compare the current text first.');
    }
    return result;
  };
  const shared = source instanceof SharedWiki ? source : null;
  return [
    Prec.high(EditorView.domEventHandlers({ beforeinput: (event, view) => { if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); const found = yUndoManagerKeymap.find((item) => item.key === (event.inputType === 'historyUndo' ? 'Mod-z' : 'Mod-y')); history(found?.run, view); return true; } return false; } })),
    yCollab(source.text, null, { undoManager: source.undo }),
    keymap.of(yUndoManagerKeymap.map((item) => ({ ...item,
      run: (view: EditorView) => history(item.run, view),
      shift: item.shift ? (view: EditorView) => history(item.shift, view) : undefined,
    }))),
    EditorState.transactionFilter.of((transaction) => {
      if (transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) {
        if (!source.writable) return [];
        if (transaction.newDoc.length > DOC_LIMITS.body) { source.refuseInput('The shared text limit is 100,000 characters. This input was not shared.'); return []; }
        let units = 0;
        transaction.changes.iterChanges((from, to, _fromNew, _toNew, insert) => { units += to - from + insert.length; });
        if (source.pendingBytes + 4 * units + 65536 > 1024 * 1024) { source.refuseInput('Wait for the pending text to be shared before making this larger edit.'); return []; }
      }
      return transaction;
    }),
    shared ? [
      marked, remoteCarets, remoteCaretLayer,
      // Only a person writing here has a caret others see: a page that is open but not in use publishes none.
      EditorView.updateListener.of((update) => {
        if (update.view.hasFocus && (update.selectionSet || update.docChanged || update.focusChanged)) { const selection = update.state.selection.main; shared.setCursor(selection.anchor, selection.head); }
      }),
      EditorView.domEventHandlers({ blur: () => { shared.blur(); return false; } }),
    ] : [],
  ];
}

interface PageEditorProps { doc: Doc; project: Project; userId: string; mode: PageMode }

/**
 * The Wiki page, edited where it is read (#869). The text is the page's Markdown, drawn as the page (livePreview);
 * with live editing it is the shared room's Y.Text (#228), typing is seen as it happens and versions save by
 * themselves; without it, this tab's copy saves as the next version a moment after typing rests.
 */
export function PageEditor({ doc, project, userId, mode }: PageEditorProps) {
  const shared = useSharedWiki(mode.live ? doc.id : null, userId, true, mode.live ? mode.head : null);
  const ordinary = !mode.live || shared?.status === 'unavailable';
  const local = useLocalWiki(ordinary ? doc : null, userId);
  const source: Source | null = ordinary ? local : shared?.text ? shared : null;
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const toast = useToast();
  const owners = useAgentOwners(project);
  const onClick = useReferenceClicks();
  const now = useNow();
  const [title, setTitle] = useState(doc.title);
  const [view, setView] = useState<EditorView | null>(null);
  const [revision, setRevision] = useState(0);
  const [picker, setPicker] = useState<{ top: number; left: number } | null>(null);
  const [sources, setSources] = useState<Map<string, string>>(new Map());
  const [compare, setCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = useRef<HTMLDivElement>(null);
  const comparison = useRef<HTMLTextAreaElement>(null);
  const hosts = useMemo(() => new RefHosts(), []);
  const placed = useSyncExternalStore(hosts.subscribe, hosts.get);
  const collab = useMemo(() => new Compartment(), []);
  const editability = useMemo(() => new Compartment(), []);
  const landing = useRef<() => void>(() => undefined);
  const changed = useRef<() => void>(() => undefined);

  // The view is made once, with the text the page was read with; its source is bound when it is ready.
  useEffect(() => {
    if (!parent.current) return;
    let timer = 0;
    changed.current = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setRevision((value) => value + 1), 300); };
    const openPicker = (target: EditorView) => {
      if (!target.state.facet(EditorView.editable)) return false;
      const at = target.coordsAtPos(target.state.selection.main.head);
      const box = parent.current?.getBoundingClientRect();
      setPicker(at && box ? { top: at.bottom - box.top + 6, left: Math.max(0, Math.min(at.left - box.left, box.width - 440)) } : { top: 0, left: 0 });
      return true;
    };
    const created = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: mode.live ? mode.head?.body ?? doc.body : doc.body,
        extensions: [
          livePreview(hosts), EditorView.lineWrapping, drawSelection(), placeholder('Write something…'), stateMovement,
          keymap.of([{ key: 'Enter', run: continueBlock }, { key: 'Mod-b', run: wrap('**') }, { key: 'Mod-i', run: wrap('*') }, { key: 'Mod-k', run: openPicker }]),
          EditorView.contentAttributes.of({ 'aria-label': 'Page text', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' }),
          EditorView.updateListener.of((update) => { if (update.docChanged) changed.current(); }),
          collab.of([]), editability.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
        ],
      }),
    });
    setView(created);
    return () => { window.clearTimeout(timer); created.destroy(); };
    // One view for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new page opens with the caret in its text, once its text can be written.
  const wantsCaret = useRef((location.state as { writeAt?: string } | null)?.writeAt === 'start');

  // Bind the source: the view takes its text (unchanged when the read text is already it) and edits it from now on.
  const text = source?.text;
  useEffect(() => {
    if (!view) return;
    const refocus = view.hasFocus;
    view.dispatch({ effects: [collab.reconfigure([]), editability.reconfigure([EditorView.editable.of(false), EditorState.readOnly.of(true)])] });
    if (!source || !text) return;
    // Only what differs is replaced, so the caret keeps its place when a room is opened afresh.
    const change = difference(view.state.doc.toString(), text.toString());
    if (change) view.dispatch({ changes: change });
    view.dispatch({ effects: collab.reconfigure(binding(source)) });
    let scheduled = false, gone = false, editable: boolean | null = null, hadFocus = refocus;
    const update = () => {
      if (scheduled) return;
      scheduled = true;
      // y-sync can report a local transaction from inside a CodeMirror update: never reenter dispatch.
      queueMicrotask(() => {
        scheduled = false;
        if (gone) return;
        const effects: StateEffect<unknown>[] = [];
        if (editable !== source.writable) {
          // Focus the page had when it stopped taking input comes back with the input (an ended reconnect, a reopened room).
          if (!source.writable && view.hasFocus) hadFocus = true;
          editable = source.writable;
          effects.push(editability.reconfigure([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]));
        }
        if (source instanceof SharedWiki) effects.push(remoteMarks.of(marks(source)), remoteCaretsChanged.of(carets(source)));
        if (effects.length) view.dispatch({ effects });
        if (editable && (wantsCaret.current || (hadFocus && (!document.activeElement || document.activeElement === document.body)))) {
          wantsCaret.current = false; hadFocus = false; view.focus();
        }
      });
    };
    const unsubscribe = source.subscribe(update); update();
    return () => { gone = true; unsubscribe(); };
  }, [view, source, text, collab, editability]);


  // What the references in the text lead to, read again when they change and when the window gets focus.
  const mentions: DocMention[] = shared?.mentions.length ? shared.mentions : doc.mentions;
  const mentionKey = mentions.map((item) => `${item.type}:${item.id}:${item.path ?? ''}`).join();
  const mentionsRef = useRef(mentions);
  useEffect(() => { mentionsRef.current = mentions; });
  const rowsRef = useRef<{ key: string; rows: Map<string, import('@flux/contracts').NativeWorkRow>; read: boolean }>({ key: '', rows: new Map(), read: false });
  const push = useCallback(() => {
    if (!view) return;
    view.dispatch({ effects: setRefData.of({ rows: rowsRef.current.rows, read: rowsRef.current.read, mentions: new Map(mentionsRef.current.map((item) => [`${item.type}:${item.id}`, item])) }) });
    // The mentions change with the shared preview; `mentionKey` says when they did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, mentionKey]);
  const [focusTick, setFocusTick] = useState(0);
  const readTick = useRef(0);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setFocusTick((value) => value + 1); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!view) return;
    const refs = workRefs(view.state.doc.toString());
    const key = refs.join();
    if (!refs.length) { rowsRef.current = { key, rows: new Map(), read: true }; push(); return; }
    if (key === rowsRef.current.key && focusTick === readTick.current && rowsRef.current.read) { push(); return; }
    readTick.current = focusTick;
    const controller = new AbortController();
    let retry = 0;
    const load = () => readReferences(project.id, refs, controller.signal).then(({ rows, sources: found }) => {
      if (controller.signal.aborted) return;
      rowsRef.current = { key, rows, read: true };
      setSources(found);
      push();
    }, () => { if (!controller.signal.aborted) retry = window.setTimeout(() => void load(), 5000); });
    // Until this read answers, nothing is called missing: a read cut short by the next change starts again.
    rowsRef.current = { key, rows: rowsRef.current.rows, read: false };
    void load();
    return () => { controller.abort(); window.clearTimeout(retry); };
  }, [view, revision, focusTick, project.id, push]);

  // The view's state is outside React: `revision` says when its text changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const headings = useMemo(() => (view ? headingsOf(view.state) : []), [view, revision]);
  const go = (id: string) => {
    const heading = headings.find((item) => item.id === id);
    const scroller = parent.current?.closest<HTMLElement>('.wiki-main');
    if (!heading || !view || !scroller) return;
    landing.current();
    landing.current = scrollPage(scroller, () => {
      if (!view.dom.isConnected) return null;
      const block = view.lineBlockAt(Math.min(heading.at, view.state.doc.length));
      return scroller.scrollTop + view.documentTop + block.top - scroller.getBoundingClientRect().top - 24;
    });
  };
  useEffect(() => () => landing.current(), []);

  // Someone else renamed the page: its title follows the saved version.
  const savedVersion = shared?.head?.savedVersion ?? doc.version;
  const knownVersion = useRef(doc.version);
  useEffect(() => {
    if (savedVersion <= knownVersion.current) return;
    knownVersion.current = savedVersion;
    const controller = new AbortController();
    getDoc(doc.id, controller.signal).then((latest) => setTitle(latest.title), () => undefined);
    return () => controller.abort();
  }, [savedVersion, doc.id]);

  const rename = async (next: string) => {
    if (local) { await local.rename(next); setTitle(local.title); }
    else if (shared) {
      const receipt = await shared.save({ title: next });
      setTitle(receipt.savedDoc?.title ?? next);
    } else throw new Error('The page is still opening');
    revalidator.revalidate();
  };

  // History's Restore: the earlier version becomes the page again, for everyone writing here, as the next version.
  // It comes in the navigation's state (a button's action), never in an address.
  const restoreWanted = (location.state as { restore?: number } | null)?.restore;
  const [restore, setRestore] = useState<DocVersion | null>(null);
  useEffect(() => {
    if (!restoreWanted || !Number.isInteger(restoreWanted) || restoreWanted < 1) return;
    const controller = new AbortController();
    getVersion(doc.id, restoreWanted, controller.signal).then(setRestore, () => { if (!controller.signal.aborted) setError('That version could not be read. Try again from History.'); });
    return () => controller.abort();
  }, [restoreWanted, doc.id]);
  const restoring = useRef<number | null>(null);
  useEffect(() => {
    if (!restore || restoring.current === restore.version || !source?.editable) return;
    restoring.current = restore.version;
    const base = docUrl(project.id, doc.id);
    const done = (message: string) => { toast({ message }); navigate(base, { replace: true, state: null }); };
    void (async () => {
      try {
        if (source instanceof LocalWiki) await source.restore(restore);
        else {
          source.document.transact(() => { source.text.delete(0, source.text.length); source.text.insert(0, restore.body); }, 'restore');
          const receipt = await source.save({ ...(restore.title !== title ? { title: restore.title } : {}), reason: `Restored version ${restore.version}` });
          if (receipt.savedDoc) setTitle(receipt.savedDoc.title);
        }
        done(`Version ${restore.version} is the page again.`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The version could not be restored.');
        navigate(base, { replace: true, state: null });
      }
    })();
  }, [restore, source, source?.editable, project.id, doc.id, navigate, toast, title]);

  const insert = (ref: PickedRef) => {
    setPicker(null);
    if (!view) return;
    const range = view.state.selection.main;
    const label = (view.state.sliceDoc(range.from, range.to).trim() || ref.title || 'link').replace(/([[\]\\])/g, '\\$1');
    const link = `[${label}](${docRef(ref.type, ref.id)})`;
    view.dispatch({ changes: { from: range.from, to: range.to, insert: link }, selection: { anchor: range.from + link.length }, userEvent: 'input' });
    view.focus();
  };

  const people = shared ? [...new Map([...shared.peers.values()].filter((peer) => peer.actor.id !== userId).map((peer) => [peer.actor.id, { id: peer.actor.id, name: peer.actor.name }])).values()] : [];
  const docTime = Date.parse(doc.createdAt);
  const at = (time: number | null) => ago(new Date(time ?? docTime).toISOString(), now);
  const state = local
    ? local.conflict ? 'Not saved · this page changed' : local.saving || local.dirty ? 'Saving…' : local.problem ? 'Not saved yet' : `Saved · ${at(local.savedAt)}`
    : !shared || shared.status === 'connecting' ? `Saved · ${at(docTime)}`
      : shared.status === 'reconnecting' ? 'Reconnecting · your text is kept'
        : shared.status === 'private' ? 'Not saved · your text is kept in this tab'
          : shared.pendingCount ? 'Saving…' : `Saved · ${at(shared.savedAt)}`;
  const legacy = useMemo(() => {
    try { const value = JSON.parse(sessionStorage.getItem(`flux:doc-edit:${userId}:${doc.id}`) ?? 'null') as { body?: string } | null; return typeof value?.body === 'string' && value.body.length <= DOC_LIMITS.body ? value.body : null; }
    catch { return null; }
  }, [userId, doc.id]);
  const privateText = shared ? shared.privateBody ?? legacy : null;
  const problem = error ?? shared?.problem ?? local?.problem ?? null;
  const conflict = local?.conflict ?? null;

  const notices = <>
    {problem ? <p className="doc-notice" role="alert">{problem}</p> : null}
    {local?.restored && !conflict ? <p className="doc-notice" role="status">Your unsaved text from earlier in this tab is back.</p> : null}
    {conflict ? (
      <div className="doc-notice doc-conflict" role="alert">
        <p><b>{conflict.author.name}</b> saved this page while you were writing. Your text is still here.</p>
        <p>“Keep my text” saves your text as the next version, in place of theirs. <Link to={`${docUrl(project.id, doc.id)}/history?from=${local?.base ?? conflict.version - 1}&to=${conflict.version}`}>See their change</Link></p>
        <Button variant="secondary" onClick={() => local?.keepMine()}>Keep my text</Button>
        <Button variant="quiet" onClick={() => local?.takeTheirs()}>Use their version</Button>
      </div>
    ) : null}
    {privateText ? (
      <section className="doc-notice">
        <span>A private copy from an earlier session is available.</span>
        <Button type="button" variant="secondary" onClick={() => setCompare(!compare)}>{compare ? 'Close comparison' : 'Compare private text'}</Button>
        {compare ? <>
          <textarea ref={comparison} aria-label="Earlier private text" readOnly value={privateText} />
          <p>Select the text you want to bring into the page, then place its cursor.</p>
          <Button type="button" disabled={!shared?.editable} onClick={() => {
            const area = comparison.current;
            if (!area || area.selectionStart === area.selectionEnd || !view) { setError('Select text in the private copy before importing.'); return; }
            const range = view.state.selection.main;
            view.dispatch({ changes: { from: range.from, to: range.to, insert: privateText.slice(area.selectionStart, area.selectionEnd) }, userEvent: 'input' });
          }}>Insert selected text</Button>
          {shared?.hasPrivateArchive ? <Button type="button" variant="quiet" onClick={() => shared.discardPrivateArchive()}>Discard earlier private copy</Button> : null}
        </> : null}
      </section>
    ) : null}
  </>;

  return (
    <PageFrame docId={doc.id} title={title} headings={headings} onHeading={go} rename={rename} notices={notices} onBodyClick={onClick}
      meta={<>{state}{people.length ? ` · ${hereToo(people)}` : ''}</>}
      metaData={{ 'data-live-status': shared?.status ?? (ordinary ? 'ordinary' : 'connecting'), 'data-live-pending': shared?.pendingCount ?? (local?.dirty ? 1 : 0) }}
      faces={<Faces people={people} />}
      shown={{ title, body: () => view?.state.doc.toString() ?? doc.body, version: savedVersion, current: true }}>
      <div ref={parent} className="doc-prose wiki-editor" data-live-wiki-editor={shared ? '' : undefined}
        data-live-generation={shared?.head?.generation} data-live-sequence={shared?.head?.sequence} data-live-command={shared?.lastLocalCommand ?? undefined}
        data-live-input-revision={shared?.inputRevision} data-live-command-revision={shared?.sealedRevision}
        data-live-command-batches={shared ? JSON.stringify(shared.sealedBatches) : undefined} />
      {placed.map(({ key, host, mark }) => createPortal(<RefMark mark={mark.kind === 'decision' ? { ...mark, source: sources.get(mark.row.id) } : mark} owners={owners} />, host, key))}
      {picker ? (
        <div className="wiki-picker" style={{ top: picker.top, left: picker.left }} ref={(node) => { node?.scrollIntoView({ block: 'nearest' }); }}>
          <LinkPicker projectId={project.id} workspaceId={project.workspaceId} selfId={doc.id} onPick={insert} onClose={() => { setPicker(null); view?.focus(); }} />
        </div>
      ) : null}
    </PageFrame>
  );
}
