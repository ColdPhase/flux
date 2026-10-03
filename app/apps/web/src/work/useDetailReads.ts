import { useCallback, useMemo, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { ProjectWorkViewQuery, WorkDetailProjection, WorkObjectType } from '@flux/contracts';
import { getProjectWorkView, getWorkDetail, getWorkRelations, workRelationReadUrl, workViewReadUrl } from './read-api';
import { useWorkRead } from './useWorkRead';

/** One complete own object, without implicit links or a project collection. */
export function useNativeOwn(accountId: string, projectId: string, kind: WorkObjectType, id?: string, enabled = true, revision = 0) {
  const revalidator = useRevalidator();
  const scope = id && enabled ? { accountId, projectId, selector: `own:${kind}:${id}` } : null;
  const load = useCallback((signal: AbortSignal) => getWorkDetail(projectId, kind, id!, signal), [projectId, kind, id]);
  const read = useWorkRead(scope, load, revision, enabled && revalidator.state === 'idle');
  const value = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  return { read, value };
}

/** Private selections are kept by the form; this hook retains only one native page. */
export function useWorkChoices(accountId: string, projectId: string, selection: ProjectWorkViewQuery | null, enabled = true, revision = 0) {
  const revalidator = useRevalidator();
  const serialized = JSON.stringify(selection);
  const owned = useMemo<ProjectWorkViewQuery | null>(() => JSON.parse(serialized) as ProjectWorkViewQuery | null, [serialized]);
  const key = JSON.stringify([accountId, projectId, serialized]);
  const [position, setPosition] = useState<{ key: string; cursor?: string }>({ key });
  const [refresh, setRefresh] = useState(0);
  const cursor = position.key === key ? position.cursor : undefined;
  const query = useMemo(() => owned ? { ...owned, limit: 50, cursor } : null, [owned, cursor]);
  const url = query ? workViewReadUrl(projectId, query) : null;
  const load = useCallback((signal: AbortSignal) => getProjectWorkView(projectId, query!, signal), [projectId, query]);
  const read = useWorkRead(url && enabled ? { accountId, projectId, selector: url } : null, load, revision + refresh, enabled && revalidator.state === 'idle');
  const page = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  return { read, page, busy: read.phase === 'loading' || read.phase === 'refreshing',
    onCursor: (next: string) => setPosition({ key, cursor: next }),
    onRefresh: () => { setPosition({ key }); setRefresh((value) => value + 1); } };
}

/** A separate bounded observation of all relation roles, tied to this own-object read. */
export function useDetailRelations(accountId: string, projectId: string, detail: WorkDetailProjection | null) {
  const revalidator = useRevalidator();
  const key = JSON.stringify([accountId, projectId, detail?.object.kind, detail?.object.id]);
  const [position, setPosition] = useState<{ key: string; cursor?: string }>({ key });
  const [refresh, setRefresh] = useState(0);
  const refs = detail ? `${detail.object.kind}:${detail.object.id}` : '';
  const cursor = position.key === key ? position.cursor : undefined;
  const query = useMemo(() => ({ objects: refs, limit: 50, cursor }), [refs, cursor]);
  const url = refs ? workRelationReadUrl(projectId, query) : null;
  const load = useCallback((signal: AbortSignal) => getWorkRelations(projectId, query, signal), [projectId, query]);
  const read = useWorkRead(url ? { accountId, projectId, selector: `${key}|${url}` } : null, load, JSON.stringify([detail?.observedAt, refresh]), revalidator.state === 'idle');
  const page = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  return { read, page, links: page?.items ?? [],
    complete: !!page && page.before === 0 && !page.nextCursor && !page.previousCursor,
    busy: read.phase === 'loading' || read.phase === 'refreshing',
    onCursor: (next: string) => setPosition({ key, cursor: next }),
    onRefresh: () => { setPosition({ key }); setRefresh((value) => value + 1); } };
}

export type DetailRelations = ReturnType<typeof useDetailRelations>;
export type DetailChoices = ReturnType<typeof useWorkChoices>;
