import { useState } from 'react';
import type { NeedsYouItem } from '@flux/contracts';
import './assistant-join-review.css';
import { ApiError } from '../api/client';
import { allowAssistantJoin } from '../agents/api';
import { AgentIdentity, Button, Overlay, agentHue } from '../ui';

/** Reviews only the immutable identity on this recipient's Inbox question, never a roster. */
export function AssistantJoinReview({ item, onClose }: { item: Pick<NeedsYouItem, 'project' | 'assistantRequestIdentity'>; onClose(): void }) {
  const identity = item.assistantRequestIdentity!;
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allow = async () => {
    if (!item.project) return;
    setBusy(true); setError(null);
    try {
      const result = await allowAssistantJoin(item.project.id, identity.joinRequestId, identity.openingVersion);
      if (result.state !== 'accepted') throw new Error('Request no longer pending');
      setAccepted(true);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? 'Only a current project manager can allow this request.'
        : cause instanceof ApiError && cause.status === 409 ? 'This request has changed. Close and review the current Inbox question.'
          : 'The request could not be changed. Try again.');
    } finally { setBusy(false); }
  };
  return <Overlay open placement="center" label="Assistant join request" onClose={onClose}>
    <section className="assistant-join-review" aria-label="Assistant join requests">
      <h2>Assistant join request</h2>
      <AgentIdentity name={identity.assistantName} owner={identity.ownerName} hue={agentHue(identity.assistantId)} expression="asking" />
      <p>Asks to join {item.project?.name} as a contributor. Allow gives it access within its owner’s project permissions.</p>
      {accepted ? <p role="status">Request allowed.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="assistant-join-review__actions"><Button variant="quiet" onClick={onClose}>Close</Button>
        {!accepted ? <Button variant="primary" busy={busy} onClick={() => void allow()}>Allow</Button> : null}
      </footer>
    </section>
  </Overlay>;
}
