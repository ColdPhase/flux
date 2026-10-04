import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from 'react-router';
import { DOC_LIMITS, docRef, type Doc } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, useMediaQuery } from '../ui';
import { useShellData } from '../app/data';
import { createDoc, docUrl, getDoc, previewDoc, updateDoc } from './api';
import { diffDocs, readableRefs, type DiffRow } from './diff';
import { draftKey, keep, readKept, type Fields, type Kept } from './drafts';
import { STATE_LABEL, authorLabel, longDate } from './format';
import { LinkPicker, type PickedRef } from './LinkPicker';
import { WikiBar } from './WikiParts';
import { useWiki } from './wiki-context';
import './docs.css';
import { LiveDocEditor } from '../editing/WikiEditor';

// The doc editor (#112): Markdown with a server-rendered preview, a link picker for objects of
// the project and keyboard shortcuts. A save sends If-Match with the version the editor started
// from; when someone saved in between, the text is kept and the person chooses what to do.
// Unsaved text survives a reload in this tab. It sits in the wiki's document pane (#136).

interface EditData { doc: Doc | null }

export async function docEditLoader({ params, request }: LoaderFunctionArgs): Promise<EditData> {
  const doc = params.docId ? await getDoc(params.docId, request.signal) : null;
  if (doc && doc.projectId.toLowerCase() !== (params.projectId ?? '').toLowerCase()) throw new Response('Not found', { status: 404 });
  return { doc };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

function ChangeList({ title, rows }: { title: string; rows: DiffRow[] }) {
  const changed = rows.some((row) => row.kind === 'added' || row.kind === 'removed');
  return (
    <section className="doc-conflict__side" aria-label={title}>
      <h4>{title}</h4>
      {!changed ? <p className="doc-muted">No change to the text.</p> : (
        <ol className="doc-diff doc-diff--compact">
          {rows.map((row, index) => row.kind === 'fold'
            ? <li key={index} className="doc-diff__fold">{row.count} unchanged {row.count === 1 ? 'line' : 'lines'}</li>
            : <li key={index} className={`doc-diff__row doc-diff__row--${row.kind}`}><span className="doc-diff__m" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</span>{row.kind !== 'same' ? <span className="ui-vh">{row.kind === 'added' ? 'Added: ' : 'Removed: '}</span> : null}<span className="doc-diff__t">{row.parts.map((part) => part.text).join('') || '\u00a0'}</span></li>)}
        </ol>
      )}
    </section>
  );
}

export function DocEditor() {
  const { doc } = useLoaderData() as EditData;
  const { project } = useWiki();
  const { me } = useShellData();
  const scope = `${me.user.id}:${doc?.id ?? `new:${project.id}`}`;
  return doc ? <LiveDocEditor key={scope} doc={doc} project={project} userId={me.user.id} fallback={<PrivateDocEditor key={scope} />} /> : <PrivateDocEditor key={scope} />;
}

function PrivateDocEditor() {
  const { doc } = useLoaderData() as EditData;
  const { project } = useWiki();
  const { me } = useShellData();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 1280px)');
  const storageKey = draftKey(me.user.id, doc?.id ?? null, project.id);
  const initial = useMemo<Kept>(() => readKept(storageKey) ?? {
    title: doc?.title ?? '', body: doc?.body ?? '', state: doc?.state ?? 'draft', reason: '', base: doc?.version ?? 0,
    // Only the first render reads storage; later renders keep the editor's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fields, setFields] = useState<Fields>({ title: initial.title, body: initial.body, state: initial.state, reason: initial.reason });
  const [base, setBase] = useState(initial.base);
  const [baseBody, setBaseBody] = useState(doc?.body ?? '');
  const [chosenMode, setMode] = useState<'write' | 'preview' | 'both'>(wide ? 'both' : 'write');
  // "Both" needs the width; on a narrow screen it reads as Write.
  const mode = !wide && chosenMode === 'both' ? 'write' : chosenMode;
  const [preview, setPreview] = useState<{ html: string; missing: number } | null>(null);
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const [picker, setPicker] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const reasonId = useId();
  const restored = !!readKept(storageKey) && (initial.body !== (doc?.body ?? '') || initial.title !== (doc?.title ?? ''));

  const dirty = fields.title !== (doc?.title ?? '') || fields.body !== (doc?.body ?? '') || fields.state !== (doc?.state ?? 'draft');
  useEffect(() => { keep(storageKey, dirty || fields.reason ? { ...fields, base } : null); }, [storageKey, fields, base, dirty]);

  // The preview is rendered by the server exactly as a saved version would be.
  const showPreview = mode !== 'write';
  useEffect(() => {
    if (!showPreview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewDoc(project.id, fields.body, controller.signal)
        .then((result) => setPreview({ html: result.html, missing: result.mentions.filter((item) => !item.path).length }))
        .catch(() => { if (!controller.signal.aborted) setPreview({ html: '<p>Preview is not available right now. Your text is kept.</p>', missing: 0 }); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [showPreview, fields.body, project.id]);

  const edit = (patch: Partial<Fields>) => { setFields((current) => ({ ...current, ...patch })); setAttempt(crypto.randomUUID()); setError(''); };

  const insert = useCallback((ref: PickedRef) => {
    setPicker(false);
    const area = textRef.current;
    const start = area?.selectionStart ?? fields.body.length;
    const end = area?.selectionEnd ?? start;
    const selected = fields.body.slice(start, end).trim();
    const label = (selected || ref.title || 'link').replace(/([[\]\\])/g, '\\$1');
    const text = `[${label}](${docRef(ref.type, ref.id)})`;
    const body = fields.body.slice(0, start) + text + fields.body.slice(end);
    edit({ body });
    if (mode === 'preview') setMode('write');
    requestAnimationFrame(() => { area?.focus(); area?.setSelectionRange(start + text.length, start + text.length); });
  }, [fields.body, mode]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!fields.title.trim()) { setError('Give the page a title.'); return; }
    setBusy(true); setError('');
    try {
      const command = { title: fields.title.trim(), body: fields.body, state: fields.state, ...(fields.reason.trim() ? { reason: fields.reason.trim() } : {}) };
      const saved = doc ? await updateDoc(doc.id, base, command, attempt) : await createDoc(project.id, command, attempt);
      keep(storageKey, null);
      navigate(docUrl(project.id, saved.id), { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        const latest = (cause.body as { current?: Doc } | null)?.current ?? null;
        setConflict(latest); setShowTheirs(false); setAttempt(crypto.randomUUID());
      } else if (cause instanceof ApiError && cause.status === 403) setError('You can read this project but not change its pages.');
      else if (cause instanceof ApiError && cause.status === 404) setError('This page is no longer available to you.');
      else setError(cause instanceof Error ? `${cause.message}. Your text is kept; try again.` : 'Could not save. Your text is kept; try again.');
    } finally { setBusy(false); }
  }

  /** The person saw the newer version and saves their text on top of it as the next version. */
  function keepMine() {
    if (!conflict) return;
    setBase(conflict.version); setBaseBody(conflict.body); setConflict(null); setAttempt(crypto.randomUUID());
  }
  function takeTheirs() {
    if (!conflict) return;
    keep(storageKey, null);
    setFields({ title: conflict.title, body: conflict.body, state: conflict.state, reason: '' });
    setBase(conflict.version); setBaseBody(conflict.body); setConflict(null);
  }

  const onKey = (event: KeyboardEvent) => {
    const primary = event.metaKey || event.ctrlKey;
    if (primary && (event.key === 's' || event.key === 'Enter')) { event.preventDefault(); void save(); }
    else if (primary && event.key.toLowerCase() === 'k') { event.preventDefault(); setPicker(true); }
    else if (primary && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); setMode((current) => (current === 'write' ? (wide ? 'both' : 'preview') : 'write')); }
  };

  const titles = useMemo(() => new Map([...(doc?.mentions ?? []), ...(conflict?.mentions ?? [])].filter((item) => item.title).map((item) => [`${item.type}:${item.id}`, item.title])), [doc, conflict]);
  const theirChanges = useMemo(() => (conflict ? diffDocs(readableRefs(baseBody, titles), readableRefs(conflict.body, titles)) : []), [conflict, baseBody, titles]);
  const myChanges = useMemo(() => (conflict ? diffDocs(readableRefs(baseBody, titles), readableRefs(fields.body, titles)) : []), [conflict, baseBody, fields.body, titles]);
  const back = doc ? docUrl(project.id, doc.id) : `/projects/${project.id}/docs`;

  return (
    <>
      <WikiBar meta={<span className="doc-head__k">{doc ? <>Editing version {base} · a save makes version {base + 1}</> : 'New page'}</span>} />
      <form className={`wiki-doc doc-edit${mode === 'both' ? ' doc-edit--both' : ''}`} data-shift onSubmit={(event) => void save(event)} onKeyDown={onKey} aria-labelledby={titleId}>
        <p className="wiki-doc__crumb"><Icon name="lock" size={12} /><span>Everyone in {project.name} can read it</span></p>
        {restored ? <p className="doc-notice"><Icon name="undo" size={14} />Your unsaved text from earlier is back.</p> : null}

        {conflict ? (
          <div className="doc-conflict" role="alert">
            <p><Icon name="alert" size={14} /><b>{authorLabel(conflict.author)} saved version {conflict.version}</b> while you were editing ({conflict.reason}, {longDate(conflict.createdAt)}). Nothing was overwritten, and your text is still here.</p>
            <div className="doc-conflict__acts">
              <Button variant="secondary" onClick={() => setShowTheirs((value) => !value)} aria-expanded={showTheirs}>{showTheirs ? 'Hide the changes' : 'Show their changes and yours'}</Button>
              <Button variant="primary" onClick={keepMine}>Keep my text on top of version {conflict.version}</Button>
              <Button variant="quiet" onClick={takeTheirs}>Discard mine, use theirs</Button>
            </div>
            {showTheirs ? (
              <div className="doc-conflict__both">
                <ChangeList title={`Their change in version ${conflict.version}`} rows={theirChanges} />
                <ChangeList title="Your change, not saved yet" rows={myChanges} />
              </div>
            ) : null}
            <p className="doc-conflict__what"><b>Keep my text</b> saves your text as version {conflict.version + 1}, in place of theirs: copy anything of theirs you want to keep into your text first. <b>Discard mine</b> opens their version and drops your unsaved change.</p>
          </div>
        ) : null}

        <label className="ui-vh" htmlFor={titleId}>Title</label>
        <input id={titleId} className="doc-edit__title" value={fields.title} maxLength={DOC_LIMITS.title} placeholder="Title" required
          onChange={(event) => edit({ title: event.target.value })} autoFocus={!doc} />

        <div className="doc-edit__bar">
          <div className="doc-seg" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'write'} onClick={() => setMode('write')}>Write</button>
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button>
            {wide ? <button type="button" aria-pressed={mode === 'both'} onClick={() => setMode('both')}>Both</button> : null}
          </div>
          <Button variant="quiet" icon="link" onClick={() => setPicker((open) => !open)} aria-expanded={picker} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'} data-tip={`Link to something in this project   ${mod} K`}>Link</Button>
          <span className="doc-edit__hint">Markdown · <kbd>{mod}</kbd><kbd>S</kbd> saves</span>
        </div>
        {picker ? <LinkPicker projectId={project.id} workspaceId={project.workspaceId} selfId={doc?.id ?? null} onPick={insert} onClose={() => { setPicker(false); textRef.current?.focus(); }} /> : null}

        <div className="doc-edit__panes">
          {mode !== 'preview' ? (
            <div className="doc-edit__write">
              <label className="ui-vh" htmlFor={bodyId}>Text (Markdown)</label>
              <textarea id={bodyId} ref={textRef} className="doc-edit__text" value={fields.body} maxLength={DOC_LIMITS.body} spellCheck
                placeholder={'Write in Markdown: ## Heading, **bold**, - list, [link](https://…)\nUse Link to refer to a decision, result or another page.'}
                onChange={(event) => edit({ body: event.target.value })} autoFocus={!!doc} />
            </div>
          ) : null}
          {mode !== 'write' ? (
            <div className="doc-edit__preview" aria-live="polite" aria-label="Preview">
              {preview ? <div className="doc-prose" dangerouslySetInnerHTML={{ __html: preview.html || '<p class="doc-muted">Nothing to preview yet.</p>' }} /> : <p className="doc-muted" aria-busy="true">Rendering…</p>}
              {preview?.missing ? <p className="doc-notice"><Icon name="alert" size={14} />{preview.missing === 1 ? 'One link does' : `${preview.missing} links do`} not point to anything in this project and will show as plain text.</p> : null}
            </div>
          ) : null}
        </div>

        <div className="doc-edit__save">
          <div className="doc-edit__reason">
            <label htmlFor={reasonId}>What changed <span>(optional)</span></label>
            <input id={reasonId} className="ui-input" value={fields.reason} maxLength={DOC_LIMITS.reason} placeholder={doc ? 'e.g. Added the low-light numbers' : 'e.g. First notes from the bench test'}
              onChange={(event) => edit({ reason: event.target.value })} />
          </div>
          <div className="doc-seg" role="radiogroup" aria-label="State">
            {(['draft', 'published'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={fields.state === value} onClick={() => edit({ state: value })}>{STATE_LABEL[value]}</button>
            ))}
          </div>
          <div className="doc-edit__acts">
            <Link className="ui-btn ui-btn--quiet" to={back} onClick={() => keep(storageKey, null)}>Cancel</Link>
            <Button type="submit" variant="primary" busy={busy} disabled={!!conflict || (!!doc && !dirty)} aria-keyshortcuts={isMac ? 'Meta+S' : 'Control+S'}>{doc ? 'Save version' : 'Create page'}</Button>
          </div>
        </div>
        {error ? <p className="doc-error" role="alert">{error}</p> : null}
        <p className="doc-muted doc-edit__foot">Earlier versions never change. {fields.state === 'draft' ? 'A draft is visible to the project too; publishing marks it as ready.' : 'Published pages are marked as ready to rely on.'}</p>
      </form>
    </>
  );
}
