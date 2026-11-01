import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { COLLABORATION_INK, shapeOfSlot, type PeerShape } from './color';
import { Link } from 'react-router';
import * as Y from 'yjs';
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, Direction, EditorView, RectangleMarker, drawSelection, keymap, layer, type DecorationSet, type LayerMarker } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { DOC_LIMITS, docRef, type Doc, type DocState, type Project } from '@flux/contracts';
import { Button, Icon, useMediaQuery } from '../ui';
import { LinkPicker, type PickedRef } from '../docs/LinkPicker';
import { docUrl, getDoc } from '../docs/api';
import { STATE_LABEL } from '../docs/format';
import { DocProse } from '../docs/DocProse';
import { EditBar } from '../docs/PageBars';
import { useWiki } from '../docs/wiki-context';
import { SharedWiki } from './wiki';
import { decode64 } from './wire';
import './editing.css';

export function useSharedWiki(id: string | null, userId: string, writer = true) {
  const [client, setClient] = useState<SharedWiki | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!id) return;
    const next = new SharedWiki(id, userId, writer);
    // Publish from the external resource's asynchronous notifications. No render
    // creates sockets/timers, and an old resource is never returned for a new scope.
    const unsubscribe = next.subscribe(() => { setClient(next); refresh((value) => value + 1); });
    return () => { unsubscribe(); next.destroy(); };
  }, [id, userId, writer]);
  return client?.id === id && client.userId === userId && client.writer === writer ? client : null;
}

/**
 * A collaborator's named caret is drawn in its own layer, like the local selection, never as an
 * inline widget: a widget at the same position as the local cursor became a cursor stop, so
 * Shift+ArrowLeft at the end of the text stepped over the other person's caret instead of
 * selecting the last character.
 *
 * Its name never floats over the text. On a wide editor the name tag sits in a lane reserved to the right of the
 * lines, level with the caret's line (stacked below another tag that would touch it); on a narrow one the caret carries
 * only its shape, and the People strip names the same shape. A tag is `aria-hidden`: the caret names its person.
 */
const LANE_WIDTH = 136, TAG_HEIGHT = 18, TAG_GAP = 2;
let wide: MediaQueryList | null = null;
const wideEditor = () => wide ??= window.matchMedia('(min-width: 768px)');
interface Tag { left: number; dy: number; width?: number }
class NamedCaret implements LayerMarker {
  constructor(readonly name: string, readonly ink: string, readonly shape: PeerShape, readonly left: number, readonly top: number, readonly height: number, readonly tag: Tag | null) {}
  eq(other: LayerMarker): boolean { return other instanceof NamedCaret && other.name === this.name && other.ink === this.ink && other.shape === this.shape
    && other.left === this.left && other.top === this.top && other.height === this.height && other.tag?.left === this.tag?.left && other.tag?.dy === this.tag?.dy && other.tag?.width === this.tag?.width; }
  draw() {
    const element = document.createElement('div'); element.className = 'editing-caret';
    element.setAttribute('aria-label', `${this.name}'s cursor`); element.dataset.shape = this.shape;
    const label = document.createElement('span'); label.textContent = this.name; label.style.backgroundColor = this.ink; element.append(label);
    if (this.tag) {
      const tag = document.createElement('span'); tag.className = 'editing-caret__tag'; tag.setAttribute('aria-hidden', 'true'); tag.title = this.name;
      const shape = document.createElement('i'); shape.className = 'editing-shape'; shape.dataset.shape = this.shape;
      const name = document.createElement('span'); name.textContent = this.tag.width ? this.name.split(' ')[0]! : this.name;
      tag.append(shape, name); element.append(tag);
    }
    this.place(element); return element;
  }
  // A moved caret only restyles its own nodes; a changed person, shape or lane redraws it.
  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof NamedCaret) || previous.name !== this.name || previous.shape !== this.shape || !previous.tag !== !this.tag || !previous.tag?.width !== !this.tag?.width) return false;
    this.place(element); return true;
  }
  private place(element: HTMLElement) {
    element.style.left = `${this.left}px`; element.style.top = `${this.top}px`; element.style.height = `${this.height}px`;
    element.style.borderColor = this.ink;
    const tag = element.querySelector<HTMLElement>('.editing-caret__tag');
    if (tag && this.tag) { tag.style.left = `${this.tag.left - this.left}px`; tag.style.top = `${this.tag.dy}px`; tag.style.maxWidth = this.tag.width ? `${this.tag.width}px` : ''; }
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
  markers: (view) => {
    const at = view.state.field(remoteCarets).flatMap((caret) => {
      const rect = RectangleMarker.forRange(view, 'editing-caret', EditorSelection.cursor(Math.min(caret.head, view.state.doc.length)))[0];
      return rect ? [{ caret, rect }] : [];
    }).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    // Nothing to place, nothing to measure: typing alone (an IME preedit among it) must not pay for a peer's lane.
    if (!at.length) return [];
    // Level with each caret's line, but never touching the tag above it; the lane is part of the editor's own width.
    const lane = wideEditor().matches ? view.scrollDOM.clientWidth - LANE_WIDTH + 4 : null;
    let free = -Infinity;
    return at.map(({ caret, rect }) => {
      // Two people on one row keep their tags on that row, side by side, rather than the second dropping to the next row.
      const row = at.filter((other) => Math.abs(other.rect.top - rect.top) < 2);
      if (lane !== null && row.length === 2) {
        const index = row.findIndex((other) => other.caret === caret), half = (LANE_WIDTH - 8 - TAG_GAP) / 2;
        const top = Math.max(rect.top + (rect.height - TAG_HEIGHT) / 2, free); if (index === 1) free = top + TAG_HEIGHT + TAG_GAP;
        return new NamedCaret(caret.name, caret.ink, caret.shape, rect.left, rect.top, rect.height, { left: lane + index * (half + TAG_GAP), dy: top - rect.top, width: half });
      }
      const top = Math.max(rect.top + (rect.height - TAG_HEIGHT) / 2, free); free = top + TAG_HEIGHT + TAG_GAP;
      return new NamedCaret(caret.name, caret.ink, caret.shape, rect.left, rect.top, rect.height, lane === null ? null : { left: lane, dy: top - rect.top });
    });
  },
});
/**
 * Moving to the start or end of the text comes from the editor state, not the browser.
 * CodeMirror draws a line longer than 20,000 characters only around the view and the
 * selection. After native Ctrl+End from the middle of such a line, its end was not drawn yet,
 * so a native Shift+ArrowLeft selected nothing and the typed character was added instead of
 * replacing the last one (a 100,000-character text then refused it as too long; #228 Gate 4).
 * A dispatched selection is drawn and placed exactly. These follow `@codemirror/commands`.
 */
function toDocumentBoundary(end: boolean, extend: boolean) {
  return (view: EditorView) => {
    const at = end ? view.state.doc.length : 0;
    view.dispatch({ selection: extend ? EditorSelection.range(view.state.selection.main.anchor, at) : EditorSelection.cursor(at), scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}
/**
 * A move by one character stays with the browser where CodeMirror has drawn the whole line, as
 * before. On a line it draws only in part (its far end is replaced by one tall gap, as on a line
 * longer than 20,000 characters) or next to text it has not drawn (the end of such a line right
 * after Ctrl+End) it comes from the state: WebKit's own move there left the selection collapsed
 * at the start of the line, so eight Shift+ArrowLeft presses at the end of a 100,000-character
 * text selected nothing and the next Backspace removed nothing. A state move enters the
 * selection at once, so a keyboard selection that the next typed character replaces a few
 * milliseconds later could reach the 40 ms cursor tick and show the other person a caret one
 * character early (#228 Gate 4).
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

interface EditorHandle { insert(text: string): void; focus(): void }
function CollaborativeText({ client, handleRef }: { client: SharedWiki; handleRef: React.RefObject<EditorHandle | null> }) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!client.text || !parent.current) return;
    const history = (run: ((view: EditorView) => boolean) | undefined, view: EditorView) => {
      // A peer can fill space left by our old deletion. Undo/redo is synchronous:
      // if its result exceeds the body quota, reverse it before this fixed batch
      // seals or a browser paint occurs. Only the final valid merged update leaves.
      if (!run || !client.editable || client.pendingBytes + DOC_LIMITS.body * 8 + 65536 > 1024 * 1024) return false;
      const undos = client.undo.undoStack.length, redos = client.undo.redoStack.length;
      const result = run(view);
      if (client.text.length > DOC_LIMITS.body) {
        if (client.undo.undoStack.length < undos) client.undo.redo();
        else if (client.undo.redoStack.length < redos) client.undo.undo();
        client.refuseInput('This inverse would exceed 100,000 characters after another writer’s changes. The shared text stays as it was; compare the current text first.');
      }
      return result;
    };
    const writable = StateEffect.define<boolean>();
    const writableField = StateField.define<boolean>({ create: () => client.editable, update: (value, transaction) => transaction.effects.reduce((current, effect) => effect.is(writable) ? effect.value : current, value), provide: (field) => EditorView.editable.from(field) });
    const view = new EditorView({ parent: parent.current, state: EditorState.create({
      doc: client.text.toString(),
      extensions: [Prec.high(EditorView.domEventHandlers({ beforeinput: (event, view) => { if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); const binding = yUndoManagerKeymap.find((binding) => binding.key === (event.inputType === 'historyUndo' ? 'Mod-z' : 'Mod-y')); history(binding?.run, view); return true; } return false; } })),
        yCollab(client.text, null, { undoManager: client.undo }), keymap.of(yUndoManagerKeymap.map((binding) => ({ ...binding,
          run: (view: EditorView) => history(binding.run, view),
          shift: binding.shift ? (view: EditorView) => history(binding.shift, view) : undefined,
        }))), stateMovement, drawSelection(), EditorView.lineWrapping, marked, remoteCarets, remoteCaretLayer, writableField,
        EditorView.contentAttributes.of({ 'aria-label': 'Shared Markdown', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' }),
        EditorState.transactionFilter.of((transaction) => {
          if (transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) {
            if (!client.editable) return [];
            if (transaction.newDoc.length > DOC_LIMITS.body) { client.refuseInput('The shared text limit is 100,000 characters. This input was not shared.'); return []; }
            let units = 0;
            transaction.changes.iterChanges((from, to, _fromNew, _toNew, insert) => { units += to - from + insert.length; });
            if (client.pendingBytes + 4 * units + 65536 > 1024 * 1024) { client.refuseInput('Wait for the pending text to be shared before making this larger edit.'); return []; }
          }
          return transaction;
        }),
        EditorView.updateListener.of((update) => { if (update.selectionSet || update.docChanged) { const selection = update.state.selection.main; client.setCursor(selection.anchor, selection.head); } }),
        EditorView.domEventHandlers({ blur: () => { client.blur(); return false; } }),
        EditorView.theme({ '&': { minHeight: '260px', height: '100%', fontSize: 'var(--fs-md)' }, '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', overflow: 'auto' }, '.cm-content': { padding: '12px' }, '&.cm-focused': { outline: '2px solid var(--t1)', outlineOffset: '-2px' } }),
      ],
    }) });
    handleRef.current = { insert: (text) => { if (!client.editable || view.state.doc.length + text.length > DOC_LIMITS.body) return; const selection = view.state.selection.main; view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length }, userEvent: 'input' }); view.focus(); }, focus: () => view.focus() };
    let scheduled = false, destroyed = false;
    const update = () => {
      if (scheduled) return;
      scheduled = true;
      // y-sync can report a local transaction from inside a CodeMirror update. Defer
      // decorations/editability until that update has completed; never reenter dispatch.
      queueMicrotask(() => { scheduled = false; if (!destroyed) view.dispatch({ effects: [writable.of(client.editable), remoteMarks.of(marks(client)), remoteCaretsChanged.of(carets(client))] }); });
    };
    const unsubscribe = client.subscribe(update); update();
    return () => { destroyed = true; unsubscribe(); handleRef.current = null; view.destroy(); };
  }, [client, client.text, handleRef]);
  return <div className="editing-code" ref={parent} data-live-wiki-editor data-live-generation={client.head.generation} data-live-sequence={client.head.sequence} data-live-command={client.lastLocalCommand ?? undefined} data-live-input-revision={client.inputRevision} data-live-command-revision={client.sealedRevision} data-live-command-batches={JSON.stringify(client.sealedBatches)} />;
}

/** The 1-based line of a text index, without copying or splitting the whole text on every update. */
function lineAt(text: string, index: number) {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line++;
  return line;
}
export function WikiPresence({ client }: { client: SharedWiki }) {
  const peers = [...client.peers.values()].filter((peer) => peer.cursor);
  const shape = shapes(client);
  return <span className="editing-people" aria-label="People editing">{peers.map((peer) => {
    const index = relativeIndex(client, peer.cursor!.head);
    const line = index === null ? null : lineAt(client.text.toString(), index);
    return <span key={peer.connectionId}><i className="editing-shape" data-shape={shape.get(peer.actor.id)} aria-hidden="true" />{peer.actor.name}{line === null ? ' is editing' : ` · line ${line}`}</span>;
  })}</span>;
}

export function LiveDocEditor({ doc, project, userId, fallback }: { doc: Doc; project: Project; userId: string; fallback: React.ReactNode }) {
  const client = useSharedWiki(doc.id, userId);
  const wide = useMediaQuery('(min-width: 1280px)');
  const [mode, setMode] = useState<'write' | 'preview' | 'both'>('write');
  const [title, setTitle] = useState(doc.title);
  const [state, setState] = useState<DocState>(doc.state);
  const [reason, setReason] = useState('');
  const [metadataBase, setMetadataBase] = useState({ title: doc.title, state: doc.state, version: doc.version });
  const [metadataConflict, setMetadataConflict] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [compare, setCompare] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const comparison = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const formId = useId();
  const { compact } = useWiki();
  const [legacy] = useState(() => { try { const value = JSON.parse(sessionStorage.getItem(`flux:doc-edit:${userId}:${doc.id}`) ?? 'null') as { body?: string } | null; return typeof value?.body === 'string' && value.body.length <= DOC_LIMITS.body ? value.body : null; } catch { return null; } });
  if (client?.status === 'unavailable') return fallback;
  const privateText = client?.privateBody ?? legacy;
  const displayedMode = wide ? mode : mode === 'both' ? 'write' : mode;
  const save = async (event?: FormEvent) => {
    event?.preventDefault(); if (!client || busy || !title.trim()) return;
    setBusy(true); setError(null);
    try {
      const prior = client.pendingSave;
      const titleChanged = title.trim() !== metadataBase.title, stateChanged = state !== metadataBase.state;
      const receipt = await client.save(prior ? { title: prior.title, state: prior.state, reason: prior.reason } : { ...(titleChanged ? { title: title.trim() } : {}), ...(stateChanged ? { state } : {}), reason }, titleChanged || stateChanged ? metadataBase.version : undefined);
      setSaved(receipt.savedDoc?.version ?? client.head.savedVersion); setReason('');
      if (receipt.savedDoc) { setMetadataBase({ title: receipt.savedDoc.title, state: receipt.savedDoc.state, version: receipt.savedDoc.version }); setTitle(receipt.savedDoc.title); setState(receipt.savedDoc.state); }
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'A version could not be saved. Your shared text remains visible.');
      if (!client.pendingSave) {
        try { const current = await getDoc(doc.id); if (current.title !== metadataBase.title || current.state !== metadataBase.state) setMetadataConflict(current); }
        catch { /* The original fields and private copy stay in this editor. */ }
      }
    }
    finally { setBusy(false); }
  };
  const insert = (ref: PickedRef) => { handleRef.current?.insert(`[${ref.title.replace(/[\\[\]]/g, '\\$&')}](${docRef(ref.type, ref.id)})`); setPicker(false); };
  const busySave = busy || !!client?.pendingSave;
  const saveDisabled = busy || !!metadataConflict || !client?.editable || (client?.pendingCount ?? 0) > 0 || !title.trim();
  // The wiki's document pane (#197): the same bar, form and save row as the private editor, with
  // the shared working copy's status in place of a private draft (#239 review).
  return <>
    <EditBar back={docUrl(project.id, doc.id)} backLabel="Back to the page" historyTo={`${docUrl(project.id, doc.id)}/history`}
      meta={<span className="doc-head__k">Shared working copy · last saved version {client?.head?.savedVersion ?? doc.version}</span>}
      primary={<Button type="submit" form={formId} variant="primary" className="wiki-bar__primary" data-slot="primary" icon="check" disabled={saveDisabled} aria-label={busy ? 'Saving…' : 'Save version'}><span className="wiki-bar__label">{busy ? 'Saving…' : 'Save version'}</span></Button>} />
    <form id={formId} className={`wiki-doc doc-edit${displayedMode === 'both' ? ' doc-edit--both' : ''}`} data-shift aria-labelledby={titleId} onSubmit={(event) => void save(event)} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 's' || event.key === 'Enter')) { event.preventDefault(); void save(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPicker(true); }
    }}>
      <p className="wiki-doc__crumb"><Icon name="lock" size={12} /><span>Everyone in {project.name} can read it, and sees typing as it happens. Save keeps an immutable version.</span></p>
      <p className="editing-status" role="status" data-live-status={client?.status ?? 'connecting'}>{client?.status === 'live' ? (client.pendingCount ? `${client.pendingCount} changes waiting to be shared` : 'All changes shared') : client?.status === 'private' ? 'Pending text kept privately' : 'Connecting to the shared working copy…'}{client?.text ? <WikiPresence client={client} /> : null}</p>
      {client?.problem || error ? <p className="doc-notice" role="alert">{error ?? client?.problem}</p> : null}
      {metadataConflict ? <section className="doc-notice"><p>Version {metadataConflict.version} now uses “{metadataConflict.title}” · {STATE_LABEL[metadataConflict.state]}. Review it before saving your metadata.</p><Button type="button" variant="secondary" onClick={() => { setTitle(metadataConflict.title); setState(metadataConflict.state); setMetadataBase({ title: metadataConflict.title, state: metadataConflict.state, version: metadataConflict.version }); setMetadataConflict(null); }}>Use their metadata</Button><Button type="button" variant="quiet" onClick={() => { setMetadataBase({ title: metadataConflict.title, state: metadataConflict.state, version: metadataConflict.version }); setMetadataConflict(null); }}>Keep my metadata on version {metadataConflict.version}</Button></section> : null}
      {saved ? <p className="doc-notice" role="status">Version {saved} saved. Later typing stays in the shared working copy.</p> : null}
      {privateText ? <section className="doc-notice"><span>A private copy from an earlier session is available.</span><Button type="button" variant="secondary" onClick={() => setCompare(!compare)}>{compare ? 'Close comparison' : 'Compare private text'}</Button>{compare ? <><textarea ref={comparison} aria-label="Earlier private text" readOnly value={privateText} /><p>Select the text you want to bring into the working copy, then place its cursor.</p><Button type="button" disabled={!client?.editable} onClick={() => { const area = comparison.current; if (!area || area.selectionStart === area.selectionEnd) { setError('Select text in the private copy before importing.'); return; } handleRef.current?.insert(privateText.slice(area.selectionStart, area.selectionEnd)); }}>Insert selected text</Button>{client?.hasPrivateArchive ? <Button type="button" variant="quiet" onClick={() => client.discardPrivateArchive()}>Discard earlier private copy</Button> : null}</> : null}</section> : null}
      <label className="ui-vh" htmlFor={titleId}>Title</label>
      <input id={titleId} className="doc-edit__title" placeholder="Title" value={client?.pendingSave?.title ?? title} maxLength={DOC_LIMITS.title} disabled={busySave || !client?.editable} onChange={(event) => setTitle(event.target.value)} required />
      <div className="doc-edit__bar">
        <div className="doc-seg" role="group" aria-label="Editor view">{(['write', 'preview', ...(wide ? ['both'] : [])] as ('write' | 'preview' | 'both')[]).map((value) => <button type="button" key={value} aria-pressed={displayedMode === value} onClick={() => setMode(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
        <Button type="button" variant="quiet" icon="link" disabled={!client?.editable} onClick={() => setPicker(true)}>Link</Button>
        <span className="doc-edit__hint">Markdown · shared as you type</span>
      </div>
      {picker ? <LinkPicker projectId={project.id} workspaceId={project.workspaceId} selfId={doc.id} onPick={insert} onClose={() => setPicker(false)} /> : null}
      <div className="doc-edit__panes">
        {client?.text ? <div className="doc-edit__write" hidden={displayedMode === 'preview'}><CollaborativeText client={client} handleRef={handleRef} /></div> : <p aria-busy="true">Opening text…</p>}
        {displayedMode !== 'write' ? <div className="doc-edit__preview" aria-label="Shared preview" data-live-sequence={client?.head?.sequence}><DocProse html={client?.html ?? doc.html} /></div> : null}
      </div>
      <div className="doc-edit__save">
        <div className="doc-edit__reason">
          <label htmlFor={reasonId}>Reason for this version</label>
          <input id={reasonId} className="ui-input" value={client?.pendingSave?.reason ?? reason} maxLength={DOC_LIMITS.reason} onChange={(event) => setReason(event.target.value)} disabled={busySave} />
        </div>
        <div className="doc-seg" role="radiogroup" aria-label="State">
          {(['draft', 'published'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={(client?.pendingSave?.state ?? state) === value} disabled={busySave} onClick={() => setState(value)}>{STATE_LABEL[value]}</button>)}
        </div>
        <div className="doc-edit__acts">
          <Link className="ui-btn ui-btn--quiet" to={docUrl(project.id, doc.id)}>Back to doc</Link>
          {compact ? <Button type="submit" variant="primary" disabled={saveDisabled}>{busy ? 'Saving…' : 'Save version'}</Button> : null}
        </div>
      </div>
    </form>
  </>;
}
