import { useState } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import { leaveDm } from '../api/direct-messages';
import { Avatar, Button, Icon } from '../ui';
import { WorkDetails } from '../work/WorkDetails';
import { AddToDoc } from '../docs/AddToDoc';
import { ProjectOverview } from '../project/ProjectOverview';
import { WorkspacePeople } from '../people/WorkspacePeople';
import type { DetailsView, OwnedView } from './shellContext';
import { ThoughtTasksPanel } from '../sketch/ThoughtTasks';

/**
 * Details: a direct message's people (its own panel, #107), a message's linked objects, or a task, a decision and the other objects the panel
 * shows. A space has no panel of its own (#1419): its people, AI and GitHub are in its settings.
 */
export function Details({ view, dm = null, onBack }: {
  view: Exclude<DetailsView, OwnedView>;
  /** The open direct message (#107): its other people and audience line. */
  dm?: { id: string; kind: 'pair' | 'group'; title: string; me: string; meId: string; people: string[]; peopleIds: string[]; audience: string } | null;
  onBack: () => void;
}) {
  if (view === 'connect-ai') return <ConnectAi onBack={onBack} />;
  if (typeof view === 'object' && view.kind === 'add-to-doc') return <AddToDoc key={`${view.from.type}:${view.from.id}`} view={view} />;
  if (typeof view === 'object' && view.kind === 'overview') return <ProjectOverview key={view.messageId} messageId={view.messageId} selection={view.selection} />;
  if (typeof view === 'object' && view.kind === 'people') return <WorkspacePeople key={view.workspaceId} workspaceId={view.workspaceId} onBack={onBack} />;
  if (typeof view === 'object' && view.kind === 'thought-tasks') return <ThoughtTasksPanel key={view.thought.id} view={view} />;
  if (typeof view === 'object') return <WorkDetails view={view} />;
  if (dm) {
    return (
      <div className="details">
        <p className="details__eyebrow">Direct message</p>
        <h3 className="details__title">{dm.title}</h3>
        {/* Two short sentences say who reads it (#1424); what leaving does is said by Leave itself, when it is pressed. */}
        <p className="details__lead"><b>{dm.audience}</b> can read this conversation. Company owners and admins can’t, unless they are in it.</p>
        <section className="details__sec" aria-labelledby="details-dm-people">
          <h4 id="details-dm-people">People in this conversation</h4>
          <ul className="details__rows">
            <li className="details__person"><Avatar name={dm.me} id={dm.meId} size="md" tone="me" /><b>{dm.me} (you)</b></li>
            {dm.people.map((name, index) => <li key={`${name}-${index}`} className="details__person"><Avatar name={name} id={dm.peopleIds[index]} size="md" /><b>{name}</b></li>)}
          </ul>
        </section>
        <LeaveDm id={dm.id} kind={dm.kind} />
      </div>
    );
  }
  // Only a direct message has a panel of its own; every other place has no Details (#871, #1419).
  return null;
}

/** Personal connection setup (#57, #68, F-020): your own MCP client and your own in-app assistant, on any provider. */
function ConnectAi({ onBack }: { onBack: () => void }) {
  return (
    <div className="details">
      <button type="button" className="details__back" aria-label="Back" onClick={onBack}><Icon name="chevron-left" size={14} />Back</button>
      <p className="details__eyebrow">Optional</p>
      <p className="details__lead">Flux works fully without AI. Your own MCP client can connect to selected spaces, read context and suggest proposals for human review.</p>
      <section className="details__sec" aria-labelledby="details-ai-ways">
        <h4 id="details-ai-ways">Ways to connect</h4>
        <ul className="details__rows">
          <li><b>Your MCP client on your computer</b><span>Claude Code, Codex or another MCP client, with your own account for compute and your personal Flux grant. Flux never receives your provider credentials.</span></li>
          <li><b>Your agents in Flux</b><span>Answer here when you ask, on your Claude plan, your ChatGPT plan or your own API key, with the model you choose for each. Only you can use them.</span></li>
        </ul>
        <p><Link className="ui-link" to="/settings/agents">Ways to connect, in Settings → AI</Link></p>
        <p><Link className="ui-link" to="/connect-agent">Set up or revoke an MCP client connection</Link></p>
      </section>
      <section className="details__sec" aria-labelledby="details-ai-now">
        <h4 id="details-ai-now">Nobody else’s assistant</h4>
        <p>The ✦ button always means your own assistant. It never starts your MCP client, and it never uses another person’s assistant or payer. Without yours, human work goes on exactly as before.</p>
      </section>
    </div>
  );
}

/** Leaving a DM (#107) ends access at once, so it asks first and says what happens. */
function LeaveDm({ id, kind }: { id: string; kind: 'pair' | 'group' }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function leave() {
    setBusy(true); setError('');
    try {
      await leaveDm(id);
      navigate('/dm', { replace: true });
      revalidator.revalidate();
    } catch { setError('Could not leave. Try again.'); setBusy(false); }
  }
  return (
    <section className="details__sec" aria-label="Leave">
      {confirm ? (
        <div role="group" aria-label="Leave this conversation" className="details__confirm">
          <p>{kind === 'pair' ? 'You won’t see these messages until you open this conversation again.' : 'You won’t see these messages again unless someone starts a new conversation with you.'}</p>
          <div className="details__actions">
            <Button variant="danger" busy={busy} onClick={() => void leave()}>Leave</Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : <Button variant="quiet" className="details__leave" onClick={() => setConfirm(true)}>Leave conversation</Button>}
    </section>
  );
}
