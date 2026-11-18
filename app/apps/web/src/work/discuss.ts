import { useCallback } from 'react';
import { decisionAppPath } from '@flux/contracts';
import { useFollow } from '../place/origin';
import { awaitField, focusField } from '../ui/keys';

/** The decision panel's one field (#1424): Discuss and `R` in the Inbox put the cursor here. One decision panel is open at a time. */
export const DECISION_COMPOSER = 'decision-composer';

/**
 * "Discuss" on a decision (F-026 P4; founder decision, Hubert, 2026-11-15, #1424): it writes in the decision's one discussion, the thread
 * on its card, which its panel shows too. It opens the decision in the one panel (the sheet on the phone) with the cursor in the panel's
 * "Write about this decision…", on every device: the words are never the space's own composer's, where they joined an unrelated draft or
 * went out with no link to the decision. On the decision already open it only puts the cursor there, and adds no entry (persona round 29).
 */
export function useDiscussDecision() {
  const follow = useFollow();
  return useCallback(async (projectId: string, decisionId: string) => {
    awaitField();
    // Already open in the panel, wherever its address is (the space, or a thread it was opened over, persona round 31 P2 4): only the
    // cursor moves; leaving that address would close the thread, whose focus return took the cursor.
    const open = new URLSearchParams(window.location.search).get('open') === `decision:${decisionId}`;
    const here = open && window.location.pathname.startsWith(`/projects/${projectId}`);
    if (document.querySelector(`#details [data-detail-kind="decision"][data-detail-id="${decisionId}"]`)) { focusField(DECISION_COMPOSER); return; }
    // Its own entry, as Open is (persona round 31 P2 2): Esc or × goes Back to where Discuss was pressed (the Inbox with its open item).
    await follow(decisionAppPath(projectId, decisionId), { state: { writeDecision: true, ...(here ? {} : { openPushed: true }) }, ...(here ? { replace: true } : {}) });
    focusField(DECISION_COMPOSER);
  }, [follow]);
}
