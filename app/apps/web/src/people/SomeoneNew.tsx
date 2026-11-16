import { useRef, useState, type SyntheticEvent } from 'react';
import type { WorkspaceInvite, WorkspaceMember } from '@flux/contracts';
import { Button, Icon, Input } from '../ui';
import { attemptKeys, createInvite, problemText } from './api';
import './people.css';
import './space.css';

const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * "Someone new?" under the company's people in Add people (founder decisions 2026-11-13, #1438, and 2026-11-14, #1424): one component for
 * Space settings and New space. The email of someone not in the company makes the company's invite link (Member, 7 days, locked to that
 * address) that also adds them to the space when they join. It is copied at once and shown in place with Copy link, under one sentence; Flux
 * sends no email. In Space settings the link names the space at once (`spaceId`); in New space the space does not exist yet, so the window
 * collects the links (`onMade`, `links`) and Create space ties them to it. An address of someone already in the company ticks them in the list
 * instead. Each link made stays listed with its Copy link (personas-33): a second one never hides the first, which still works.
 */
export function SomeoneNew({ workspaceId, spaceId, spaceName, companyName, members, inSpace, meId, onTick, onMade, links }: {
  workspaceId: string; spaceId: string | null; spaceName: string; companyName: string; members: WorkspaceMember[];
  inSpace: (userId: string) => boolean; meId: string; onTick: (userId: string) => void; onMade?: (invite: WorkspaceInvite) => void;
  /** The links already made where the parent keeps them (New space), so closing Add people and opening it again lists them still. */
  links?: WorkspaceInvite[];
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');
  const [own, setOwn] = useState<WorkspaceInvite[]>([]);
  const made = links ?? own;
  const fresh = made.at(-1) ?? null;
  const keys = useRef(attemptKeys());
  const linkRef = useRef<HTMLInputElement>(null);
  async function invite(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    setStatus(''); setProblem('');
    if (!EMAIL.test(address)) { setProblem('Enter their email address.'); return; }
    const known = members.find((member) => member.email.toLowerCase() === address);
    if (known) {
      if (known.userId === meId || inSpace(known.userId)) setProblem(`${known.userId === meId ? 'You are' : `${known.name} is`} already in ${spaceName}.`);
      else { onTick(known.userId); setEmail(''); setStatus(`${known.name} is in ${companyName}: ticked above.`); }
      return;
    }
    setBusy(true);
    try {
      const made = await createInvite(workspaceId, { role: 'member', email: address, expiresInDays: 7, spaceId }, keys.current.for(`space:${spaceId ?? 'new'}:${address}`));
      keys.current.done();
      setOwn((list) => [...list, made]); setEmail('');
      onMade?.(made);
      // One sentence says what happened and what to do (#1424, persona B-4): the link's field has no second hint.
      setStatus(await copyText(made.link) ? 'Invite link created and copied. It works once, for 7 days: paste it into your message to them.'
        : 'Invite link created. Copy it and paste it into your message to them. It works once, for 7 days.');
      requestAnimationFrame(() => linkRef.current?.select());
    } catch (error) {
      setProblem(problemText(error, { workspace: companyName, email: address }));
    } finally { setBusy(false); }
  }
  return (
    <div className="spset__new" data-someone-new="">
      {/* Not a <form>: New space is one already, and a form inside a form would also submit the window (Enter included). */}
      <div className="spset__newform" role="form" aria-label="Invite someone new">
        <Input id="spset-new-email" label="Someone new?" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          aria-invalid={problem ? true : undefined} aria-describedby={problem || fresh ? undefined : 'spset-new-hint'} onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void invite(event); }} />
        <Button variant="secondary" busy={busy} onClick={(event) => void invite(event)}>Invite</Button>
      </div>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p>
        : fresh ? null : <p className="people__hint" id="spset-new-hint">They join {companyName} and {spaceName} with the link.</p>}
      {made.map((invite, at) => (
        <div key={invite.id} className="people__link" role="group" aria-label="New invite link">
          <Input ref={invite === fresh ? linkRef : undefined} id={`spset-new-link-${at}`} label={`Link for ${invite.email ?? 'anyone'}`} readOnly value={invite.link}
            onFocus={(event) => event.currentTarget.select()} />
          <div className="details__actions"><Button variant="secondary" aria-label={`Copy link for ${invite.email ?? 'anyone'}`}
            onClick={() => void copyText(invite.link).then((ok) => setStatus(ok ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.'))}><Icon name="copy" size={14} />Copy link</Button></div>
        </div>
      ))}
      <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>
    </div>
  );
}
