import {
  docPath, docSectionsPath, docVersionPath, docVersionsPath, projectDocPreviewPath, projectDocsPath, workspaceDocsPath,
  type CreateDocCommand, type Doc, type DocPreview, type DocSectionSource, type DocSummary, type DocVersion, type DocVersionSummary,
  type Page, type UpdateDocCommand,
} from '@flux/contracts';
import { request } from '../api/client';

// Project docs (#112). Create and change commands carry an Idempotency-Key that a retry of the
// same submission reuses; changes send If-Match with the version the person started from.

const LIMIT = 100;

async function everything<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; offset <= 10_000; offset += LIMIT) {
    const page = await request<Page<T>>(`${path}?limit=${LIMIT}&offset=${offset}`, { signal });
    items.push(...page.items);
    if (!page.items.length || offset + page.items.length >= page.total) break;
  }
  return items;
}

const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });

export const listProjectDocs = (projectId: string, signal?: AbortSignal) => everything<DocSummary>(projectDocsPath(projectId), signal);
export const listWorkspaceDocs = (workspaceId: string, signal?: AbortSignal) => everything<DocSummary>(workspaceDocsPath(workspaceId), signal);
export const getDoc = (id: string, signal?: AbortSignal) => request<Doc>(docPath(id), { signal });
export const listVersions = (id: string, signal?: AbortSignal) => everything<DocVersionSummary>(docVersionsPath(id), signal);
export const getVersion = (id: string, version: number, signal?: AbortSignal) => request<DocVersion>(docVersionPath(id, version), { signal });
export const previewDoc = (projectId: string, body: string, signal?: AbortSignal) =>
  request<DocPreview>(projectDocPreviewPath(projectId), { method: 'POST', body: { body }, signal });
export const createDoc = (projectId: string, command: CreateDocCommand, idempotencyKey: string) =>
  request<Doc>(projectDocsPath(projectId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const updateDoc = (id: string, version: number, command: UpdateDocCommand, idempotencyKey: string) =>
  request<Doc>(docPath(id), { method: 'PATCH', body: command, headers: { ...ifMatch(version), ...key(idempotencyKey) } });
export const addDocSection = (id: string, version: number, from: DocSectionSource, idempotencyKey: string) =>
  request<Doc>(docSectionsPath(id), { method: 'POST', body: { from }, headers: { ...ifMatch(version), ...key(idempotencyKey) } });

export const docUrl = (projectId: string, docId: string) => `/projects/${projectId}/docs/${docId}`;
