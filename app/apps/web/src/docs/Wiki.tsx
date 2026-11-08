import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Outlet, redirect, useLoaderData, useNavigate, useParams, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import { DOC_LIMITS, type DocSummary, type Project } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { useToast } from '../ui';
import { getProject } from '../project/api';
import { createDoc, docUrl, listProjectDocs } from './api';
import { readMarkdownFile } from './markdown-file';
import { WikiContext, type WikiState } from './wiki-context';
import './docs.css';

// A space's Wiki as drawn (#869): two columns only, the sidebar and the page. There is no pages column: the page's
// title is the page switcher, and the page is edited where it is read.

interface WikiData { project: Project; docs: DocSummary[] }

const pageKey = (projectId: string) => `flux.project-wiki.${projectId}`;

function readKey(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

export async function wikiLoader({ params, request }: LoaderFunctionArgs): Promise<WikiData> {
  const [project, docs] = await Promise.all([getProject(params.projectId!, request.signal), listProjectDocs(params.projectId!, request.signal)]);
  // The Wiki tab opens a page: the one last open here in this tab, else the latest change.
  if (docs.length && new URL(request.url).pathname.replace(/\/+$/, '') === `/projects/${params.projectId}/docs`) {
    const remembered = readKey(pageKey(project.id));
    throw redirect(docUrl(project.id, (docs.find((doc) => doc.id === remembered) ?? docs[0]!).id));
  }
  return { project, docs };
}

/** The list follows a move to another page (a new or imported one), not a comparison change in History. */
export function wikiShouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  if (currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

export function WikiLayout() {
  const { project, docs } = useLoaderData() as WikiData;
  const { docId } = useParams();
  useEffect(() => { if (docId) writeKey(pageKey(project.id), docId); }, [project.id, docId]);
  const navigate = useNavigate();
  const toast = useToast();
  const intents = useIntentKeys();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  // A refused import is about that attempt: opening another page clears it.
  const [errorFor, setErrorFor] = useState(docId ?? null);
  if (errorFor !== (docId ?? null)) { setErrorFor(docId ?? null); if (importError) setImportError(''); }
  const fileRef = useRef<HTMLInputElement>(null);
  const importErrorId = useId();

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setImportError('');
    setImporting(true);
    try {
      const read = await readMarkdownFile(file);
      if (!read.ok) { setImportError(read.error); return; }
      // The same file chosen again after a lost answer reuses its key (#178): one page, never two.
      const intent = JSON.stringify(['import', project.id, file.name, read.title, read.body]);
      const doc = await createDoc(project.id, { title: read.title, body: read.body, cause: { kind: 'import', fileName: file.name.slice(0, DOC_LIMITS.fileName) } }, intents.keyFor(intent));
      intents.settle(intent);
      toast({ message: `Imported “${doc.title}”.`, tone: 'success' });
      navigate(docUrl(project.id, doc.id));
    } catch (cause) {
      setImportError(cause instanceof ApiError && cause.status === 403 ? 'You can read this space but not add pages to it.'
        : cause instanceof ApiError ? `“${file.name}” was not imported: ${cause.message.replace(/\.$/, '')}.`
          : `“${file.name}” was not imported. Check the connection and try again.`);
    } finally { setImporting(false); }
  }
  const startImport = useCallback(() => { if (!importing) fileRef.current?.click(); }, [importing]);

  const value = useMemo<WikiState>(() => ({ project, docs, importing, importError, importErrorId, startImport }),
    [project, docs, importing, importError, importErrorId, startImport]);
  return (
    <WikiContext.Provider value={value}>
      <div className="wiki-frame">
        <div className="wiki-main pane-scroll"><Outlet /></div>
        <input ref={fileRef} type="file" accept=".md,.markdown,text/markdown,text/x-markdown" hidden tabIndex={-1}
          onChange={(event) => void importFile(event)} />
      </div>
    </WikiContext.Provider>
  );
}
