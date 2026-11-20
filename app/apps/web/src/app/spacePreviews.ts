import { useEffect, useMemo, useState } from 'react';
import { SPACE_PREVIEWS_LIMIT, SPACE_PREVIEWS_PATH, type SpacePreview, type SpacePreviewsResponse } from '@flux/contracts';
import { request } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { firstName } from '../people/api';
import { useShellData } from './data';

/**
 * The newest message of each space, for the Spaces list's second line and time as a conversation's row has them (round 15 look-2 P3-11).
 * One read for all the spaces shown; read again when a message arrives anywhere (the stream names the event, never the words), a moment
 * after the last one so a busy space is read once. A read that fails leaves the rows as they were: a row without a preview is a row without one.
 */
const getSpacePreviews = (projectIds: readonly string[], signal?: AbortSignal) =>
  request<SpacePreviewsResponse>(`${SPACE_PREVIEWS_PATH}?projectIds=${projectIds.map(encodeURIComponent).join(',')}`, { signal });

const MESSAGE_EVENTS = new Set(['project.conversation_created.v1', 'project.message_sent.v1', 'project.message_edited.v1', 'project.message_removed.v1']);

export function useSpacePreviews(projectIds: readonly string[]): ReadonlyMap<string, SpacePreview> {
  const userId = useShellData().me.user.id;
  const key = projectIds.slice(0, SPACE_PREVIEWS_LIMIT).join(',');
  const [found, setFound] = useState<{ key: string; items: ReadonlyMap<string, SpacePreview> } | null>(null);
  const [again, setAgain] = useState(0);
  useStreamEvents(userId, (event) => { if (MESSAGE_EVENTS.has(event.kind)) setAgain((count) => count + 1); }, () => setAgain((count) => count + 1));
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getSpacePreviews(key.split(','), controller.signal)
        .then((read) => setFound({ key, items: new Map(read.items.map((item) => [item.projectId, item])) }))
        .catch(() => undefined);
    }, again ? 400 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, again]);
  return useMemo(() => (found?.key === key ? found.items : new Map<string, SpacePreview>()), [found, key]);
}

/** "Maja: I moved the calibration notes…": a space's first name before the words, "You" for the reader's own, "Sent a file" for files alone (README, Home's notice previews). */
export function previewLine(preview: SpacePreview, meId: string): string {
  const who = preview.author ? (preview.author.kind === 'human' && preview.author.id === meId ? 'You' : preview.author.kind === 'human' ? firstName(preview.author.name) : preview.author.name) : null;
  const words = preview.body || (preview.files ? 'Sent a file' : '');
  return who && words ? `${who}: ${words}` : words;
}
