import { useCallback } from 'react';
import type { ObjectLink } from '@flux/contracts';
import { useFollow } from '../place/origin';
import { MEDIA } from '../ui';
import { getWorkRelations } from './read-api';

/** What a link-less read leaves when relations cannot be read: the project's conversation is still the place to talk. */
const noLinks: ObjectLink[] = [];

/** The thread a decision was proposed from: its first message source with a conversation, if any. */
export function decisionThread(links: readonly ObjectLink[], decisionId: string) {
  const source = links.find((link) => link.from.id === decisionId && link.role === 'source' && link.to.type === 'message' && !!link.conversationId);
  return source ? { conversationId: source.conversationId!, messageId: source.to.id } : null;
}

/**
 * "Discuss" on a decision (F-026 P4, #763 D3): it opens where the decision is talked about, ready to write. A decision
 * made from a message opens that message's thread, where the decision stands among the replies, with its reply field
 * focused. One without a message source opens the project's conversation with the decision beside it (on a computer)
 * and the composer focused. Where the panel is an overlay (a tablet, a phone) it would cover that composer and the way
 * back, so there the conversation opens alone. `links` are the decision's relations when the caller already holds them.
 */
export function useDiscussDecision() {
  const follow = useFollow();
  return useCallback(async (projectId: string, decisionId: string, links?: readonly ObjectLink[]) => {
    const known = links ?? await getWorkRelations(projectId, { objects: `decision:${decisionId}`, limit: 50 }).then((page) => page.items, () => noLinks);
    const thread = decisionThread(known, decisionId);
    if (thread) {
      await follow(`/projects/${projectId}/conversations/${thread.conversationId}`, { state: { focusComposer: true, keepPanel: true } });
      return;
    }
    const overlay = window.matchMedia(MEDIA.panelOverlay).matches;
    await follow(`/projects/${projectId}${overlay ? '' : `?open=decision:${decisionId}`}`, { state: { focusComposer: true } });
  }, [follow]);
}
