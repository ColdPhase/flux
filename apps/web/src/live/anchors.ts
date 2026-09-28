import type { LiveContextRef, LivePresentationRef } from '@flux/contracts';
import { ApiError } from '../api/client';
import { getConversation, getMaterial } from '../app/conversation-api';
import { getSketch } from '../api/sketches';
import { getDoc } from '../docs/api';
import { getResult, getWork } from '../work/api';

/**
 * Where a live session lives and what can be shown in it (#59 §3). Anchors and fragments are
 * existing Flux objects; their titles are always read through the ordinary authorized API,
 * never from the session or its presentation trace.
 */
export type AnchorKind = LiveContextRef['type'];

export interface LiveAnchor {
  projectId: string;
  context: LiveContextRef;
  /** Human title of the object, e.g. the task title or the conversation's opening line. */
  label: string;
}

/** A fragment the current view can show: its object reference and how people would call it. */
export interface Presentable {
  ref: LivePresentationRef;
  label: string;
  /** "task", "doc v4", "3 thoughts on the map". */
  what: string;
}

export const KIND_WORD: Record<AnchorKind, string> = {
  conversation: 'conversation',
  work: 'task',
  sketch: 'map',
  doc: 'doc',
};

export function excerpt(text: string, max = 72) {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function anchorPath(anchor: Pick<LiveAnchor, 'projectId' | 'context'>): string {
  const { projectId, context } = anchor;
  switch (context.type) {
    case 'conversation': return `/projects/${projectId}/conversations/${context.id}`;
    case 'work': return `/projects/${projectId}/tasks?open=work:${context.id}`;
    case 'sketch': return `/projects/${projectId}/map/${context.id}`;
    case 'doc': return `/projects/${projectId}/docs/${context.id}`;
  }
}

export function sameContext(a: LiveContextRef | null | undefined, b: LiveContextRef | null | undefined) {
  return !!a && !!b && a.type === b.type && a.id === b.id;
}

/** The anchor's title through its own API; null when it is no longer readable. */
export async function anchorLabel(projectId: string, context: LiveContextRef, signal?: AbortSignal): Promise<string | null> {
  try {
    switch (context.type) {
      case 'conversation': return excerpt((await getConversation(context.id, signal)).firstMessageBody);
      case 'work': return (await getWork(context.id, signal)).title;
      case 'sketch': return (await getSketch(context.id, signal)).title;
      case 'doc': {
        const doc = await getDoc(context.id, signal);
        return doc.projectId === projectId ? doc.title : null;
      }
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

export interface ResolvedFragment {
  label: string;
  what: string;
  /** Where the recipient reads it; null when it cannot be opened in Flux any more. */
  path: string | null;
  /** Sketch thoughts the presenter pointed at. */
  selected?: string[];
}

/**
 * Loads a shown fragment for this recipient through the object's own API. A removed or
 * hidden target resolves to a quiet "no longer available" instead of leaking anything.
 */
export async function resolveFragment(projectId: string, ref: LivePresentationRef, signal?: AbortSignal): Promise<ResolvedFragment> {
  try {
    switch (ref.type) {
      case 'work': {
        const item = await getWork(ref.id, signal);
        const changed = item.version !== ref.version;
        return { label: item.title, what: changed ? 'task, changed since it was shown' : 'task', path: `/projects/${projectId}/tasks?open=work:${item.id}` };
      }
      case 'result': {
        const result = await getResult(ref.id, signal);
        return { label: result.title, what: 'result', path: `/projects/${projectId}/tasks?open=result:${result.id}` };
      }
      case 'material': {
        try {
          const doc = await getDoc(ref.id, signal);
          const latest = doc.version === ref.version;
          return {
            label: doc.title,
            what: latest ? `doc · version ${ref.version}` : `doc · version ${ref.version} of ${doc.version}`,
            path: latest ? `/projects/${projectId}/docs/${doc.id}` : `/projects/${projectId}/docs/${doc.id}/versions/${ref.version}`,
          };
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
          const material = await getMaterial(ref.id, signal);
          return { label: material.title, what: `source · version ${ref.version}`, path: `/materials/${ref.id}/versions/${ref.version}` };
        }
      }
      case 'sketch': {
        const sketch = await getSketch(ref.id, signal);
        const present = new Set(sketch.thoughts.map((thought) => thought.id));
        const selected = (ref.selectedThoughtIds ?? []).filter((id) => present.has(id));
        const count = selected.length;
        const what = count === 0 ? 'map' : count === 1 ? `1 thought on the map` : `${count} thoughts on the map`;
        const first = count === 1 ? sketch.thoughts.find((thought) => thought.id === selected[0])?.text : null;
        return { label: first ? excerpt(first, 60) : sketch.title, what: first ? `thought on “${excerpt(sketch.title, 40)}”` : what, path: `/projects/${projectId}/map/${sketch.id}`, selected };
      }
      case 'message':
        // Messages have no location endpoint yet; Flux does not offer showing one (#62 notes).
        return { label: 'A message', what: 'message', path: null };
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return { label: 'No longer available', what: 'removed or not shared with you', path: null };
    throw error;
  }
}
