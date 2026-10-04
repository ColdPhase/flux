import type { Page, WorkItem } from '@flux/contracts';

/** The assigned-work API's page size. */
export const ASSIGNED_PAGE = 100;

/** Reads one page of a workspace's assigned work. */
export type ReadAssignedPage = (limit: number, offset: number) => Promise<Page<WorkItem>>;

/**
 * Work the caller owns in one workspace (open, in progress, blocked; not parked), across the
 * projects they can read now, page by page until `total` or `cap` items (#190 HOME-2). The total
 * is always read: with no room left (`cap` 0) one row is asked for only its `total` (#211 A2.1).
 */
export async function readAssigned(readPage: ReadAssignedPage, cap: number): Promise<{ items: WorkItem[]; total: number }> {
  const byId = new Map<string, WorkItem>();
  let total = 0;
  for (let offset = 0; offset <= 10_000; offset += ASSIGNED_PAGE) {
    const page = await readPage(byId.size < cap ? ASSIGNED_PAGE : 1, offset);
    total = page.total;
    for (const item of page.items) if (!byId.has(item.id) && byId.size < cap) byId.set(item.id, item);
    if (byId.size >= cap || !page.items.length || offset + page.items.length >= page.total) break;
  }
  return { items: [...byId.values()], total };
}

/** Reads one page of one workspace's assigned work. */
export type ReadWorkspacePage = (workspaceId: string, limit: number, offset: number) => Promise<Page<WorkItem>>;

/**
 * Home's Tasks across workspaces (#190 HOME-2): at most `cap` items in all, de-duplicated, with the
 * sum of every workspace's total. A workspace that fails is skipped and reported as `failed`; an
 * aborted read throws.
 */
export async function readAssignedAcross(workspaceIds: string[], readPage: ReadWorkspacePage, cap: number, signal?: AbortSignal):
  Promise<{ items: WorkItem[]; total: number; failed: boolean }> {
  const byId = new Map<string, WorkItem>();
  let total = 0;
  let failed = false;
  for (const workspaceId of workspaceIds) {
    try {
      const page = await readAssigned((limit, offset) => readPage(workspaceId, limit, offset), cap - byId.size);
      total += page.total;
      for (const item of page.items) if (!byId.has(item.id) && byId.size < cap) byId.set(item.id, item);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      failed = true;
    }
  }
  return { items: [...byId.values()], total, failed };
}
