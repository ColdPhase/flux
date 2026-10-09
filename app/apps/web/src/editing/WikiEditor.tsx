import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import * as Y from 'yjs';
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, RectangleMarker, drawSelection, keymap, layer, type DecorationSet, type LayerMarker } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { DOC_LIMITS, docRef, type Doc, type DocState, type Project } from '@flux/contracts';
import { Button, Icon, useMediaQuery } from '../ui';
import { LinkPicker, type PickedRef } from '../docs/LinkPicker';
import { docUrl, getDoc } from '../docs/api';
import { STATE_LABEL } from '../docs/format';
import { WikiBar } from '../docs/WikiParts';
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

function color(id: string) {
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return ['#365fba', '#93613c', '#a54b87', '#287c6a'][Math.abs(hash) % 4]!;
}
/**
 * A collaborator's named caret is drawn in its own layer, like the local selection, never as an
 * inline widget: a widget at the same position as the local cursor became a cursor stop, so
 * Shift+ArrowLeft at the end of the text stepped over the other person's caret instead of
 * selecting the last character.
 */
class NamedCaret implements LayerMarker {
  constructor(readonly name: string, readonly ink: string, readonly left: number, readonly top: number, readonly height: number) {}
  eq(other: LayerMarker): boolean { return other instanceof NamedCaret && other.name === this.name && other.ink === this.ink
    && other.left === this.left && other.top === this.top && other.height === this.height; }
  draw() {
    const element = document.createElement('div'); element.className = 'editing-caret';
    element.setAttribute('aria-label', `${this.name}'s cursor`);
    const label = document.createElement('span'); label.textContent = this.name; element.append(label);
    this.place(element); return element;
  }
  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof NamedCaret) || previous.name !== this.name) return false;
    this.place(element); return true;
  }
  private place(element: HTMLElement) {
    element.style.left = `${this.left}px`; element.style.top = `${this.top}px`; element.style.height = `${this.height}px`;
    element.style.borderColor = this.ink; (element.firstElementChild as HTMLElement).style.backgroundColor = this.ink;
  }
}
interface RemoteCaret { head: number; name: string; ink: string }
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
    const at = RectangleMarker.forRange(view, 'editing-caret', EditorSelection.cursor(Math.min(caret.head, view.state.doc.length)))[0];
    return at ? [new NamedCaret(caret.name, caret.ink, at.left, at.top, at.height)] : [];
  }),
});
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
  for (const writer of client.writers) {
    const anchor = relativeIndex(client, writer.anchor), head = relativeIndex(client, writer.head);
    if (anchor === null || head === null || anchor === head) continue;
    ranges.push(Decoration.mark({ attributes: { style: `text-decoration:underline;text-decoration-color:${color(writer.actor.id)};text-underline-offset:3px`, title: `Written by ${writer.actor.name}` } }).range(Math.min(anchor, head), Math.max(anchor, head)));
  }
  for (const peer of client.peers.values()) {
    if (!peer.cursor) continue;
    const anchor = relativeIndex(client, peer.cursor.anchor), head = relativeIndex(client, peer.cursor.head);
    if (anchor === null || head === null) continue;
    if (anchor !== head) ranges.push(Decoration.mark({ attributes: { style: `background:${color(peer.actor.id)}25` } }).range(Math.min(anchor, head), Math.max(anchor, head)));
  }
  return Decoration.set(ranges, true);
}
function carets(client: SharedWiki): RemoteCaret[] {
  const result: RemoteCaret[] = [];
  for (const peer of client.peers.values()) {
    const head = peer.cursor ? relativeIndex(client, peer.cursor.head) : null;
    if (head !== null) result.push({ head, name: peer.actor.name, ink: color(peer.actor.id) });
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
        }))), drawSelection(), EditorView.lineWrapping, marked, remoteCarets, remoteCaretLayer, writableField,
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
        EditorView.theme({ '&': { minHeight: '260px', height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.65', overflow: 'auto' }, '.cm-content': { padding: '12px' }, '&.cm-focused': { outline: '2px solid var(--t1)', outlineOffset: '-2px' } }),
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

export function WikiPresence({ client }: { client: SharedWiki }) {
  const peers = [...client.peers.values()].filter((peer) => peer.cursor);
  return <span className="editing-people" aria-label="People editing">{peers.map((peer) => {
    const index = relativeIndex(client, peer.cursor!.head);
    const line = index === null ? null : client.text.toString().slice(0, index).split('\n').length;
    return <span key={peer.connectionId} style={{ color: color(peer.actor.id) }}>{peer.actor.name}{line === null ? ' is editing' : ` · line ${line}`}</span>;
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
  // The wiki's document pane (#197): the same bar, form and save row as the private editor, with
  // the shared working copy's status in place of a private draft (#239 review).
  return <>
    <WikiBar meta={<span className="doc-head__k">Shared working copy · last saved version {client?.head?.savedVersion ?? doc.version}</span>} />
    <form className={`wiki-doc doc-edit${displayedMode === 'both' ? ' doc-edit--both' : ''}`} data-shift aria-labelledby={titleId} onSubmit={(event) => void save(event)} onKeyDown={(event) => {
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
        {displayedMode !== 'write' ? <div className="doc-edit__preview" aria-label="Shared preview" data-live-sequence={client?.head?.sequence}><div className="doc-prose" dangerouslySetInnerHTML={{ __html: client?.html ?? doc.html }} /></div> : null}
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
          <Button type="submit" variant="primary" disabled={busy || !!metadataConflict || !client?.editable || client.pendingCount > 0 || !title.trim()}>{busy ? 'Saving…' : 'Save version'}</Button>
        </div>
      </div>
    </form>
  </>;
}
