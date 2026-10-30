import {
  type Draft, type Page, workspaceDraftsPath, IDEMPOTENCY_KEY_HEADER,
} from '@flux/contracts';
import { request } from '../api/client';

/** Private drafts of a workspace (#40): only their author can read them. */
export const listDrafts = (workspaceId: string, signal?: AbortSignal, offset = 0) => request<Page<Draft>>(`${workspaceDraftsPath(workspaceId)}?limit=100&offset=${offset}`, { signal });
/** A private draft; an `idempotencyKey` makes a retry return the same draft instead of a second one. */
export const createPrivateDraft = (workspaceId: string, title: string, body: string, idempotencyKey?: string, signal?: AbortSignal) =>
  request<Draft>(workspaceDraftsPath(workspaceId), { method: 'POST', body: { title, body }, signal, ...(idempotencyKey ? { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } } : {}) });
