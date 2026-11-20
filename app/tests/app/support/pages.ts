import type { Doc } from '@flux/contracts';
import type { ClientResponse, RequestOptions } from './http.js';

/**
 * A Wiki page made or edited through the doc API, for a test that needs something to cite: a message's source, a task's source, a plan.
 * Until #1508 tests saved a "material" for this; every saved source is a Wiki page now, and a citation names a version of a page as
 * `{ materialId, version }`, so the page is returned in that shape too.
 */
export interface SavedPage { materialId: string; id: string; projectId: string; version: number; title: string; body: string }

interface Requester { request(method: string, path: string, options?: RequestOptions): Promise<ClientResponse> }

const saved = (response: ClientResponse, status: number, what: string): SavedPage => {
  if (response.status !== status) throw new Error(`${what}: expected ${status}, got ${response.status} ${response.text}`);
  const doc = response.json as Doc;
  return { materialId: doc.id, id: doc.id, projectId: doc.projectId, version: doc.version, title: doc.title, body: doc.body };
};

export async function savePage(client: Requester, projectId: string, page: { title: string; body?: string }): Promise<SavedPage> {
  return saved(await client.request('POST', `/api/v1/projects/${projectId}/docs`, { body: { title: page.title, body: page.body ?? '' } }), 201, 'savePage');
}

/** The next version of a page; `expectedVersion` is the version the edit was made on. */
export async function editPage(client: Requester, materialId: string, edit: { expectedVersion: number; title?: string; body?: string }): Promise<SavedPage> {
  return saved(await client.request('PATCH', `/api/v1/docs/${materialId}`, { body: edit }), 200, 'editPage');
}
