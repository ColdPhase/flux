import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Draft, Material, Page, Project } from '@flux/contracts';
import { listDrafts } from '../drafts/api';
import { useDraft } from '../drafts/store';
import { readableError } from '../conversations/errors';
import { listMaterials, publishMaterial } from './api';

/** The material form as it is kept between visits: one value of the shared draft store (#94), per account and pane. */
interface MaterialFormSnapshot { open: boolean; title: string; body: string; url: string; sourceDraft: Draft | null; mutationId: string }

function savedMaterialForm(text: string): MaterialFormSnapshot {
  try {
    const value = JSON.parse(text || '{}') as Partial<MaterialFormSnapshot>;
    return { open: value.open === true, title: value.title ?? '', body: value.body ?? '', url: value.url ?? '', sourceDraft: value.sourceDraft ?? null, mutationId: value.mutationId ?? crypto.randomUUID() };
  } catch { return { open: false, title: '', body: '', url: '', sourceDraft: null, mutationId: crypto.randomUUID() }; }
}

interface Options {
  userId: string; project: Project; inThread: boolean; writable: boolean;
  /** The materials the route loaded, and how many the project has. */
  initial: Material[]; initialTotal: number;
  /** A refused read or write: the pane checks whether the person still has access. */
  onDenied: (cause: unknown) => void;
  /** A material was saved: the pane reads its sources and replies again. */
  onSaved: () => void;
}

/**
 * The project's sources in a conversation pane (#36): the list with its paging, and the form that saves a
 * new material, optionally from one of the person's private drafts. The form's text survives a reload.
 */
export function useProjectMaterials({ userId, project, inThread, writable, initial, initialTotal, onDenied, onSaved }: Options) {
  // The stream's pane and a thread's pane keep their own form.
  const stored = useDraft(userId, `material-form:${project.id}${inThread ? ':thread' : ''}`);
  const [saved] = useState(() => savedMaterialForm(stored.text));
  const [items, setItems] = useState(initial);
  const [offset, setOffset] = useState(initial.length);
  const [total, setTotal] = useState(initialTotal);
  const [moreBusy, setMoreBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(saved.open);
  const [sourcesOpen, setSourcesOpen] = useState(saved.open);
  const [title, setTitle] = useState(saved.title);
  const [body, setBody] = useState(saved.body);
  const [url, setUrl] = useState(saved.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mutationId, setMutationId] = useState(saved.mutationId);
  const [privateDrafts, setPrivateDrafts] = useState<Draft[]>([]);
  const [sourceDraft, setSourceDraft] = useState<Draft | null>(saved.sourceDraft);
  const keep = stored.setText;
  useEffect(() => {
    // A closed, empty form is no draft: nothing is kept for it.
    const empty = !formOpen && !title && !body && !url && !sourceDraft;
    keep(empty ? '' : JSON.stringify({ open: formOpen, title, body, url, sourceDraft, mutationId } satisfies MaterialFormSnapshot));
  }, [keep, formOpen, title, body, url, sourceDraft, mutationId]);
  useEffect(() => {
    if (!formOpen || !writable) return;
    const controller = new AbortController();
    listDrafts(project.workspaceId, controller.signal).then((page) => setPrivateDrafts(page.items.filter((item) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === userId))).catch(() => { /* publication remains available without a draft */ });
    return () => controller.abort();
  }, [formOpen, writable, project.workspaceId, userId]);

  /** A newer first page from the pane's refresh: it leads, and materials loaded beyond it stay. */
  const merge = useCallback((latest: Page<Material>) => {
    setItems((current) => [...latest.items, ...current.filter((item) => !latest.items.some((next) => next.materialId === item.materialId))]);
    setTotal(latest.total);
  }, []);
  async function loadMore() {
    if (moreBusy || offset >= total) return;
    setMoreBusy(true);
    try {
      const page = await listMaterials(project.id, undefined, offset);
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.materialId === item.materialId))]);
      setOffset((current) => current + page.items.length);
      setTotal(page.total);
    } catch (cause) { onDenied(cause); setError(readableError(cause)); }
    finally { setMoreBusy(false); }
  }
  // Every edit is a new publication intent: a retry of the same text reuses the key, a changed text does not.
  const edit = (change: () => void) => { change(); setMutationId(crypto.randomUUID()); };
  function chooseDraft(id: string) {
    const chosen = privateDrafts.find((item) => item.id === id) ?? null;
    edit(() => { setSourceDraft(chosen); if (chosen) { setTitle(chosen.title); setBody(chosen.body); } });
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!writable || !title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await publishMaterial(project.id, { title: title.trim(), body, ...(url.trim() ? { url: url.trim() } : {}), ...(sourceDraft ? { sourceDraftId: sourceDraft.id, sourceDraftVersion: sourceDraft.version } : {}), clientMutationId: mutationId });
      setTitle(''); setBody(''); setUrl(''); setSourceDraft(null); setMutationId(crypto.randomUUID()); setFormOpen(false); onSaved();
    } catch (cause) { onDenied(cause); setError(readableError(cause)); }
    finally { setBusy(false); }
  }
  return {
    items, total, more: offset < total, moreBusy, loadMore, merge,
    sourcesOpen, setSourcesOpen, trayOpen: sourcesOpen || (writable && formOpen),
    form: {
      open: formOpen, setOpen: setFormOpen, busy, error, privateDrafts, sourceDraft, chooseDraft, submit,
      title, body, url,
      setTitle: (value: string) => edit(() => setTitle(value)), setBody: (value: string) => edit(() => setBody(value)), setUrl: (value: string) => edit(() => setUrl(value)),
    },
  };
}
export type ProjectMaterials = ReturnType<typeof useProjectMaterials>;
