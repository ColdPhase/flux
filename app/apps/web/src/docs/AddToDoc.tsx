import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import type { DocSummary, ObjectLink } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Input, Select, Option, useToast } from '../ui';
import { useShellActions, type AddToDocView } from '../app/shellContext';
import { addDocSection, createDoc, docUrl, listProjectDocs } from './api';

// "Add to a Wiki page" from a result or decision (#112), in the Details panel. A result is written as a
// section; a decision is one live card, a reference line, never copied text (F-034). Each is a new
// version of the page, the earlier text stays in the earlier version, and the page links back.
// Once added, the form closes back to the object, whose "In the Wiki" now lists the page, and one calm
// toast says where it went, with Open (#763 D4).

export function AddToDoc({ view }: { view: AddToDocView }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const { openDetails } = useShellActions();
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || target === null) return;
    setBusy(true); setError('');
    try {
      const saved = chosen
        ? await addDocSection(chosen.id, chosen.version, view.from, attempt)
        : await createDoc(view.projectId, { title: title.trim() || view.from.title, from: view.from }, attempt);
      revalidator.revalidate();
      const where = chosen ? `Added to “${saved.title}”` : `Started “${saved.title}” in the Wiki`;
      openDetails({ kind: view.from.type, id: view.from.id, projectId: view.projectId }, { back: 'keep' });
      toast({ message: where, tone: 'success', action: { label: 'Open', onClick: () => void navigate(docUrl(view.projectId, saved.id)) } });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        setError(`Someone changed “${chosen?.title ?? 'the page'}” a moment ago. The list is refreshed; add it again to the latest version.`);
        setAttempt(crypto.randomUUID());
        setDocs(await listProjectDocs(view.projectId).catch(() => docs));
      } else if (cause instanceof ApiError && cause.status === 403) setError('You can read this project but not change its Wiki.');
      else if (cause instanceof ApiError && cause.code === 'DECISION_NOT_ACCEPTED') setError('Accept the decision first; a proposed decision stays out of the Wiki.');
      else setError(cause instanceof Error ? cause.message : 'Could not add it. Try again.');
    } finally { setBusy(false); }
  }

  const kind = view.from.type === 'result' ? 'result' : 'decision';
  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="doc" size={13} />Add to a Wiki page</p>
      <h3 className="details__title">{view.from.title}</h3>
      <p className="details__lead">{kind === 'decision'
        ? 'The decision appears in the page as one card with its reason. The card keeps itself up to date, so the page never needs rewriting.'
        : 'The result becomes a section of a Wiki page, with a link back here. Earlier text stays in the page’s earlier versions.'}</p>
      <fieldset className="wd-form" disabled={busy || docs === null}>
        <label htmlFor={selectId}>Wiki page</label>
        <Select id={selectId} value={target ?? ''} onChange={(next) => { setTarget(next); setAttempt(crypto.randomUUID()); setError(''); }}>
          {target === null ? <Option value="">Loading pages…</Option> : null}
          {(docs ?? []).map((doc) => <Option key={doc.id} value={doc.id}>{doc.title}{view.inDocs.includes(doc.id) ? ' (linked source)' : ''}{doc.state === 'draft' ? ' · draft' : ''}</Option>)}
          <Option value="new">A new page…</Option>
        </Select>
        {target === 'new' ? <Input label="Title of the new page" value={title} onChange={(event) => { setTitle(event.target.value); setAttempt(crypto.randomUUID()); }} maxLength={200} required /> : null}
      </fieldset>
      {target === null ? null : chosen ? <p className="wd-muted">{kind === 'decision'
        ? `The card goes at the end of “${chosen.title}”. A page that already has it stays as it is.`
        : `An existing section in “${chosen.title}” is updated, or a new section is added. Changes are saved in a new version; unchanged content keeps its current version.`}</p> : <p className="wd-muted">The new page starts as a draft.</p>}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      <div className="wd-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={target === null}>{!chosen ? 'Start the page' : kind === 'decision' ? 'Add the card' : 'Add or update section'}</Button>
        {chosen ? <Link className="ui-btn ui-btn--quiet" to={docUrl(view.projectId, chosen.id)}>Open the page</Link> : null}
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
