import { useState } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import { leaveDm } from '../api/direct-messages';
import { Avatar, Button, Icon } from '../ui';
import { WorkDetails } from '../work/WorkDetails';
import { AddToDoc } from '../docs/AddToDoc';
import { ProjectOverview } from '../project/ProjectOverview';
import { PromoteSketch } from '../sketch/PromoteSketch';
import { WhatMatters } from '../returns/WhatMatters';
import { useProjectShell } from '../project/data';
import { WorkspacePeople } from '../people/WorkspacePeople';
import { useShellData, type WorkspaceSummary } from './data';
import { useShellActions, type DetailsView } from './shellContext';

/**
 * Details for the current place. With nothing selected it says so briefly; the context of a
 * selected message, task, decision or result joins it with conversations (#36). Account and
 * session details live in the account menu.
 */
export function Details({ view, workspace, placeTitle, dm = null, onBack, onClose }: {
  view: DetailsView;
  workspace: WorkspaceSummary | null;
  placeTitle: string;
  /** The open direct message (#107): its other people and audience line. */
  dm?: { id: string; kind: 'pair' | 'group'; title: string; me: string; people: string[]; audience: string } | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const inProject = !!useProjectShell();
  if (typeof view === 'object' && view.kind === 'recap') return <WhatMatters key={view.projectId} projectId={view.projectId} projectName={placeTitle} onDone={onClose} />;
  if (view === 'connect-ai') return <ConnectAi onBack={onBack} />;
  if (typeof view === 'object' && view.kind === 'add-to-doc') return <AddToDoc key={`${view.from.type}:${view.from.id}`} view={view} />;
  if (typeof view === 'object' && view.kind === 'promote-sketch') return <PromoteSketch key={view.sketchId} view={view} dmTitle={dm?.title ?? null} onBack={onBack} />;
  if (typeof view === 'object' && view.kind === 'overview') return <ProjectOverview key={view.messageId ?? 'all'} messageId={view.messageId} focusPeople={view.focus === 'people' ? view : null} onBack={onBack} />;
  if (typeof view === 'object' && view.kind === 'people') return <WorkspacePeople key={view.workspaceId} workspaceId={view.workspaceId} onBack={onBack} />;
  if (typeof view === 'object') return <WorkDetails view={view} />;
  // A project's Details start with its overview (#117).
  if (inProject) return <ProjectOverview onBack={onBack} />;
  if (dm) {
    return (
      <div className="details">
        <p className="details__eyebrow">Direct message</p>
        <h3 className="details__title">{dm.title}</h3>
        <p className="details__lead"><b>{dm.audience}</b></p>
        <p className="details__lead">A private conversation outside any project. Workspace owners and admins can’t read it unless they are in it.</p>
        <section className="details__sec" aria-labelledby="details-dm-people">
          <h4 id="details-dm-people">People in this conversation</h4>
          <ul className="details__rows">
            <li className="details__person"><Avatar name={dm.me} size="md" tone="me" /><b>{dm.me} (you)</b></li>
            {dm.people.map((name, index) => <li key={`${name}-${index}`} className="details__person"><Avatar name={name} size="md" /><b>{name}</b></li>)}
          </ul>
        </section>
        <section className="details__sec" aria-labelledby="details-dm-rules">
          <h4 id="details-dm-rules">What stays private</h4>
          <p>Replies go to exactly these people. Someone who leaves, or leaves the workspace, stops seeing the conversation at once, including earlier messages.</p>
        </section>
        <LeaveDm id={dm.id} kind={dm.kind} />
        <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
      </div>
    );
  }
  const home = placeTitle === 'Home';
  return (
    <div className="details">
      <p className="details__eyebrow">{placeTitle}</p>
      <h3 className="details__title">Nothing selected</h3>
      <p className="details__lead">Select a note, task or result to see where it came from, what it connects to and who can see it.</p>

      <section className="details__sec" aria-labelledby="details-audience">
        <h4 id="details-audience">Who can see {placeTitle}</h4>
        {home
          ? <p>Only you. Notes you capture here stay private until you choose to share them{workspace ? ` in ${workspace.name}` : ''}.</p>
          : <p>Only the people in each conversation.</p>}
      </section>

      <PeopleEntries />

      <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
    </div>
  );
}

const ROLE_LINE = {
  owner: 'You’re an owner · add and manage people',
  admin: 'You’re an admin · add and manage people',
  member: 'You’re a member · see who’s here',
  guest: 'You’re a guest · you see only projects given to you',
} as const;

/** Each workspace's people (#188, AC-1), one step away from Home's Details. */
function PeopleEntries() {
  const { workspaces } = useShellData();
  const { openDetails } = useShellActions();
  return (
    <section className="details__sec ov-sec" aria-labelledby="details-people">
      <h4 id="details-people">People</h4>
      {workspaces.length ? (
        <ul className="ov-rows">
          {workspaces.map((space) => (
            <li key={space.id}>
              <button type="button" className="ov-row" onClick={() => openDetails({ kind: 'people', workspaceId: space.id })}>
                <Icon name="people" size={16} className="ov-row__ic" />
                <span className="ov-row__b">
                  <span className="ov-row__t">{space.name}</span>
                  {space.role ? <span className="ov-row__s">{ROLE_LINE[space.role]}</span> : null}
                </span>
                <Icon name="chevron-right" size={16} className="ov-row__go" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="ov-empty">Start a project to create your own space; then you can add people to it.</p>}
    </section>
  );
}

/** Personal connection setup (#57, #68, F-020): your own MCP client and your own in-app assistant, on any provider. */
function ConnectAi({ onBack }: { onBack: () => void }) {
  return (
    <div className="details">
      <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>
      <p className="details__eyebrow">Optional</p>
      <h3 className="details__title">Connect your AI</h3>
      <p className="details__lead">Flux works fully without AI. Your own MCP client can connect to selected projects, read context and suggest proposals for human review.</p>
      <section className="details__sec" aria-labelledby="details-ai-ways">
        <h4 id="details-ai-ways">Ways to connect</h4>
        <ul className="details__rows">
          <li><b>Your MCP client on your computer</b><span>Claude Code, Codex or another MCP client, with your own account for compute and your personal Flux grant. Flux never receives your provider credentials.</span></li>
          <li><b>Your assistant in Flux</b><span>Answers here when you ask, with your own API key from the provider and model you choose, your consent and your daily cap. Only you can use it.</span></li>
        </ul>
        <p><Link className="ui-link" to="/connect-agent">Set up or revoke an MCP client connection</Link></p>
        <p><Link className="ui-link" to="/settings/assistant">Set up your assistant in Flux</Link></p>
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
            <Button variant="quiet" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : <Button variant="quiet" className="details__leave" onClick={() => setConfirm(true)}>Leave conversation</Button>}
    </section>
  );
}
