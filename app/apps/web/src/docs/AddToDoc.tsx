import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import type { DocSummary, ObjectLink } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Input } from '../ui';
import type { AddToDocView } from '../app/shellContext';
import { addDocSection, createDoc, docUrl, listProjectDocs } from './api';

// "Add to docs" from a result or decision (#112), in the Details panel. It starts a doc with the
// section for the object, or adds or updates that section in an existing doc as a new version.
// The earlier text stays in the earlier version, and the doc links back to its source.

export function AddToDoc({ view }: { view: AddToDocView }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [title, setTitle] = useState(view.from.type === 'result' ? 'What we learned' : 'Decisions and why');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectId = useId();

  useEffect(() => {
    const controller = new AbortController();
    listProjectDocs(view.projectId, controller.signal).then((items) => {
      setDocs(items);
      const already = items.find((doc) => view.inDocs.includes(doc.id));
      setTarget(already?.id ?? items[0]?.id ?? 'new');
    }, () => { if (!controller.signal.aborted) { setDocs([]); setTarget('new'); } });
    return () => controller.abort();
  }, [view.projectId, view.inDocs]);

  const chosen = docs?.find((doc) => doc.id === target) ?? null;
  const updates = chosen ? view.inDocs.includes(chosen.id) : false;
  const partial = view.inDocsComplete === false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || target === null) return;
    setBusy(true); setError('');
    try {
      const saved = chosen
        ? await addDocSection(chosen.id, chosen.version, view.from, attempt)
        : await createDoc(view.projectId, { title: title.trim() || view.from.title, from: view.from }, attempt);
      revalidator.revalidate();
      navigate(docUrl(view.projectId, saved.id));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        setError(`Someone changed “${chosen?.title ?? 'the doc'}” a moment ago. The list is refreshed; add it again to the latest version.`);
        setAttempt(crypto.randomUUID());
        setDocs(await listProjectDocs(view.projectId).catch(() => docs));
      } else if (cause instanceof ApiError && cause.status === 403) setError('You can read this project but not change its docs.');
      else setError(cause instanceof Error ? cause.message : 'Could not add it. Try again.');
    } finally { setBusy(false); }
  }

  const kind = view.from.type === 'result' ? 'result' : 'decision';
  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="doc" size={13} />Add to docs</p>
      <h3 className="details__title">{view.from.title}</h3>
      <p className="details__lead">The {kind} becomes a section of a doc, with a link back here. {kind === 'decision' ? 'Adding it again later rewrites its section with the current state; ' : ''}Earlier text stays in the doc’s earlier versions.</p>
      <fieldset className="wd-form" disabled={busy || docs === null}>
        <label htmlFor={selectId}>Doc</label>
        <select id={selectId} value={target ?? ''} onChange={(event) => { setTarget(event.target.value); setAttempt(crypto.randomUUID()); setError(''); }}>
          {target === null ? <option value="">Loading docs…</option> : null}
          {(docs ?? []).map((doc) => <option key={doc.id} value={doc.id}>{doc.title}{view.inDocs.includes(doc.id) ? ' (linked source)' : ''}{doc.state === 'draft' ? ' · draft' : ''}</option>)}
          <option value="new">A new doc…</option>
        </select>
        {target === 'new' ? <Input label="Title of the new doc" value={title} onChange={(event) => { setTitle(event.target.value); setAttempt(crypto.randomUUID()); }} maxLength={200} required /> : null}
      </fieldset>
      {target === null ? null : chosen ? <p className="wd-muted">{partial ? `An existing section in “${chosen.title}” is updated, or a new section is added, as version ${chosen.version + 1}.` : updates ? `Its section in “${chosen.title}” is rewritten as version ${chosen.version + 1}.` : `Added at the end of “${chosen.title}” as version ${chosen.version + 1}.`}</p> : <p className="wd-muted">The new doc starts as a draft.</p>}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      <div className="wd-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={target === null}>{chosen ? (partial ? 'Add or update section' : updates ? 'Update section' : 'Add section') : 'Start the doc'}</Button>
        {chosen ? <Link className="ui-btn ui-btn--quiet" to={docUrl(view.projectId, chosen.id)}>Open the doc</Link> : null}
      </div>
    </form>
  );
}

/** Docs that link to an object, from its links (the `source` of "Add to docs" or a mention). */
export function docsLinking(links: ObjectLink[], id: string) {
  const seen = new Map<string, { id: string; title: string; role: ObjectLink['role'] }>();
  for (const link of links) {
    if (link.to.id !== id || link.from.type !== 'doc') continue;
    const known = seen.get(link.from.id);
    if (!known || link.role === 'source') seen.set(link.from.id, { id: link.from.id, title: link.fromTitle, role: link.role });
  }
  return [...seen.values()];
}
