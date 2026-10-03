import { useCallback, useMemo, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { WorkAssociationQuery } from '@flux/contracts';
import { getWorkAssociations, getWorkRelations, workAssociationReadUrl, workRelationReadUrl } from './read-api';
import { useWorkRead } from './useWorkRead';

/** One object window and one global relation window; neither is a complete ProjectWork. */
export function useOverviewWork(accountId: string, projectId: string | null, conversationId: string | null, messageId?: string) {
  const revalidator = useRevalidator();
  const key = JSON.stringify([accountId, projectId, conversationId, messageId ?? null]);
  const [position, setPosition] = useState<{ key: string; objects?: string; relations?: string; relationsFor?: string }>({ key });
  const [objectRevision, setObjectRevision] = useState(0);
  const [relationRevision, setRelationRevision] = useState(0);
  const objectCursor = position.key === key ? position.objects : undefined;
  const query = useMemo<WorkAssociationQuery | null>(() => !projectId ? null : messageId
    ? { messageIds: messageId, relation: 'any', limit: 50, cursor: objectCursor }
    : conversationId ? { conversationId, relation: 'any', limit: 50, cursor: objectCursor } : null,
  [projectId, conversationId, messageId, objectCursor]);
  const objectUrl = projectId && query ? workAssociationReadUrl(projectId, query) : null;
  const objectScope = projectId && objectUrl ? { accountId, projectId, selector: objectUrl } : null;
  const loadObjects = useCallback((signal: AbortSignal) => getWorkAssociations(projectId!, query!, signal), [projectId, query]);
  const objects = useWorkRead(objectScope, loadObjects, objectRevision, revalidator.state === 'idle');
  const page = objects.phase === 'ready' || objects.phase === 'refreshing' ? objects.value : null;
  const refs = page?.items.map((item) => `${item.kind}:${item.id}`).sort().join(',') ?? '';
  // Passive router revalidation can change the actual object window without changing
  // its requested cursor. A relation cursor belongs to that captured ref set only.
  const relationCursor = position.key === key && position.relationsFor === refs ? position.relations : undefined;
  const relationQuery = useMemo(() => ({ objects: refs, limit: 50, cursor: relationCursor }), [refs, relationCursor]);
  const relationUrl = projectId && refs ? workRelationReadUrl(projectId, relationQuery) : null;
  // A newer association observation invalidates its previous relation observation even
  // when it happens to return the same IDs. The two GETs are explicitly separate reads.
  const relationScope = projectId && relationUrl && page
    ? { accountId, projectId, selector: `${objectUrl}|${page.observedAt}|${relationUrl}` } : null;
  const loadRelations = useCallback((signal: AbortSignal) => getWorkRelations(projectId!, relationQuery, signal), [projectId, relationQuery]);
  const relations = useWorkRead(relationScope, loadRelations, relationRevision, revalidator.state === 'idle');
  const links = relations.phase === 'ready' || relations.phase === 'refreshing' ? relations.value : null;
  const moveObjects = (cursor: string) => setPosition({ key, objects: cursor });
  const refreshObjects = () => { setPosition({ key }); setObjectRevision((revision) => revision + 1); };
  const moveRelations = (cursor: string) => setPosition({ key, objects: objectCursor, relations: cursor, relationsFor: refs });
  const refreshRelations = () => { setPosition({ key, objects: objectCursor }); setRelationRevision((revision) => revision + 1); };
  return { objects, page, relations, links, moveObjects, refreshObjects, moveRelations, refreshRelations,
    objectBusy: objects.phase === 'loading' || objects.phase === 'refreshing',
    relationBusy: relations.phase === 'loading' || relations.phase === 'refreshing' };
}
