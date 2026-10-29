import { useEffect, useState } from 'react';
import { messageLinkPreviewsPath, messageLinkUrls, type LinkPreviewCard, type MessageLinkPreviews } from '@flux/contracts';
import { request } from '../api/client';

/**
 * What the server fetched about the web addresses of stored messages (#469). The server reads the addresses from the stored
 * message and fetches the pages itself, so nothing here contacts a site: the reader's browser only talks to Flux. A card is drawn
 * from the address alone until this arrives, and for good when previews are off, the workspace is sealed or a page said nothing.
 */
const known = new Map<string, Map<string, LinkPreviewCard>>();
const NONE: Map<string, LinkPreviewCard> = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A long conversation asks for a few messages at a time, so a page full of links does not open a burst of requests.
const AT_ONCE = 3;
let active = 0;
const waiting: (() => void)[] = [];
async function turn<T>(run: () => Promise<T>): Promise<T> {
  if (active >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try { return await run(); } finally { active--; waiting.shift()?.(); }
}

/** The fetched cards of this message by address; empty until they arrive, and for a message without addresses or not yet stored. */
export function useLinkPreviews(projectId: string, messageId: string | null, body: string): Map<string, LinkPreviewCard> {
  const key = messageId && UUID.test(messageId) ? `${projectId}/${messageId}` : null;
  const [loaded, setLoaded] = useState<{ key: string; cards: Map<string, LinkPreviewCard> } | null>(null);
  useEffect(() => {
    if (!key || known.has(key) || !messageLinkUrls(body).length) return undefined;
    const controller = new AbortController();
    turn(() => (controller.signal.aborted ? Promise.reject(new DOMException('', 'AbortError')) : request<MessageLinkPreviews>(messageLinkPreviewsPath(projectId, messageId!), { signal: controller.signal })))
      .then((result) => {
        const byAddress = new Map(result.cards.map((card) => [card.url, card]));
        // A busy answer is shown but not kept, so the next mount asks again.
        if (result.status !== 'busy') known.set(key, byAddress);
        if (!controller.signal.aborted) setLoaded({ key, cards: byAddress });
      }, () => { /* the address card stays */ });
    return () => controller.abort();
  }, [key, projectId, messageId, body]);
  return key ? known.get(key) ?? (loaded?.key === key ? loaded.cards : NONE) : NONE;
}
