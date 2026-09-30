import type { SearchFilterType, SearchKind, SearchPlace, SearchTarget } from '@flux/contracts';
import type { SearchAudienceType, SearchRow } from './ports.js';

/**
 * The search source registry (issue #114). One entry per kind of result: which filter it belongs
 * to, which audience carries its permission, and how a row is told in human language and opened.
 * A new source (docs, for example) adds one entry here, one audience in the `@flux/db` search rows
 * and the server's policy adapter (unless it reuses one), and the trigger that indexes it.
 */
export interface SearchSource {
  filter: SearchFilterType;
  audience: SearchAudienceType;
  /** Messages and thoughts show their matching text as the main line. */
  textIsTitle: boolean;
  label(row: SearchRow): string;
  target(row: SearchRow): SearchTarget;
}

const WORK_STATUS: Record<string, string> = {
  open: 'Task', in_progress: 'Task · in progress', blocked: 'Task · blocked', done: 'Task · done',
  not_pursued: 'Task · not pursued', parked: 'Task · parked',
};
const DECISION_STATUS: Record<string, string> = { accepted: 'Decision · current rule', proposed: 'Decision · proposed', superseded: 'Decision · replaced' };
const DRAFT_STATUS: Record<string, string> = { private: 'Private draft', project: 'Draft shared with the project', workspace: 'Draft shared with everyone' };

function materialLabel(row: SearchRow) {
  const version = row.version ?? 1;
  const current = row.currentVersion ?? version;
  if (current <= 1) return 'Material';
  return version >= current ? `Material · version ${version}, current` : `Material · version ${version} of ${current}`;
}

function docLabel(row: SearchRow) {
  const version = row.version ?? 1;
  const current = row.currentVersion ?? version;
  const state = row.status === 'draft' ? 'draft' : 'published';
  return version >= current ? `Doc · ${state}` : `Doc · version ${version} of ${current}, ${state}`;
}

const quote = (text: string) => `“${text}”`;

function inProject(row: SearchRow) {
  return row.projectId ?? '';
}

export const SEARCH_SOURCES: Record<SearchKind, SearchSource> = {
  message: {
    filter: 'message', audience: 'project', textIsTitle: true, label: () => 'Message',
    target: (row) => ({ type: 'message', projectId: inProject(row), conversationId: row.parentId ?? '', messageId: row.objectId }),
  },
  dm_message: {
    filter: 'message', audience: 'dm', textIsTitle: true, label: () => 'Direct message',
    target: (row) => ({ type: 'dm_message', dmId: row.parentId ?? '', messageId: row.objectId }),
  },
  material: {
    filter: 'material', audience: 'project', textIsTitle: false, label: materialLabel,
    target: (row) => ({ type: 'material', projectId: inProject(row), materialId: row.objectId, version: row.version ?? 1 }),
  },
  doc: {
    filter: 'doc', audience: 'project', textIsTitle: false, label: docLabel,
    target: (row) => ({ type: 'doc', projectId: inProject(row), docId: row.objectId, version: row.version ?? 1 }),
  },
  work: {
    filter: 'work', audience: 'project', textIsTitle: false, label: (row) => WORK_STATUS[row.status ?? ''] ?? 'Task',
    target: (row) => ({ type: 'work', projectId: inProject(row), id: row.objectId }),
  },
  decision: {
    filter: 'decision', audience: 'project', textIsTitle: false, label: (row) => DECISION_STATUS[row.status ?? ''] ?? 'Decision',
    target: (row) => ({ type: 'decision', projectId: inProject(row), id: row.objectId }),
  },
  result: {
    filter: 'result', audience: 'project', textIsTitle: false,
    label: (row) => (row.status === 'negative' ? 'Result · it did not work out' : 'Result · it worked'),
    target: (row) => ({ type: 'result', projectId: inProject(row), id: row.objectId }),
  },
  sketch: {
    filter: 'sketch', audience: 'sketch', textIsTitle: false, label: (row) => (row.status === 'private' ? 'Private sketch' : row.status === 'dm' ? 'Sketch in a direct message' : 'Sketch'),
    target: (row) => ({ type: 'sketch', sketchId: row.objectId, dmId: row.dmId }),
  },
  thought: {
    filter: 'sketch', audience: 'sketch', textIsTitle: true,
    label: (row) => (row.sketchTitle ? `Thought in ${quote(row.sketchTitle)}` : 'Thought'),
    target: (row) => ({ type: 'thought', sketchId: row.parentId ?? '', thoughtId: row.objectId, dmId: row.dmId }),
  },
  draft: {
    filter: 'draft', audience: 'draft', textIsTitle: false, label: (row) => DRAFT_STATUS[row.status ?? ''] ?? 'Draft',
    target: (row) => ({ type: 'draft', draftId: row.objectId }),
  },
  person: {
    filter: 'person', audience: 'members', textIsTitle: false,
    label: (row) => (row.status === 'guest' ? 'Person · guest' : 'Person'),
    target: (row) => ({ type: 'person', userId: row.objectId, workspaceId: row.workspaceId }),
  },
};

/** The kinds a filter value covers. */
export function searchKindsOf(filter: SearchFilterType): SearchKind[] {
  return (Object.keys(SEARCH_SOURCES) as SearchKind[]).filter((kind) => SEARCH_SOURCES[kind].filter === filter);
}

/** Where a row lives, told only from what the reader may see. */
export function searchPlaceOf(row: SearchRow): SearchPlace {
  if (row.kind === 'dm_message' && row.parentId) return { type: 'dm', id: row.parentId, name: row.dmName ?? 'Direct message' };
  // A DM sketch or thought lives in its DM (#96); only its participants can see it at all.
  if ((row.kind === 'sketch' || row.kind === 'thought') && row.dmId) return { type: 'dm', id: row.dmId, name: row.dmName ?? 'Direct message' };
  if (row.kind === 'person') return { type: 'workspace', id: row.workspaceId, name: row.workspaceName ?? '' };
  // The project is named only when it is itself visible to the reader (the rows check it).
  if (row.projectId && row.projectName !== null) return { type: 'project', id: row.projectId, name: row.projectName };
  return { type: 'private' };
}
