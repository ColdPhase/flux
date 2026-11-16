import { useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { WorkspaceInvite, WorkspaceMember } from '@flux/contracts';
import { Button, Icon, Input } from '../ui';
import { attemptKeys, createInvite, problemText, revokeInvite } from './api';
import { youLabel } from '../docs/format';
import './people.css';
import './space.css';

const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Enter in a link's read-only field does nothing: in New space it would submit the window (personas-36: it created the space early). */
const keepWindow = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.preventDefault(); };
const until = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/**
 * "Someone new?" under the company's people in Add people (founder decisions 2026-11-13, #1438, and 2026-11-14, #1424): one component for
 * Space settings and New space. The email of someone not in the company makes the company's invite link (Member, 7 days, locked to that
 * address) that also adds them to the space when they join. It is copied at once and shown in place with Copy link, under one sentence; Flux
 * sends no email. In Space settings the link names the space at once (`spaceId`); in New space the space does not exist yet, so the window
 * collects the links (`onMade`, `links`) and Create space ties them to it. An address of someone already in the company ticks them in the list
 * instead. Each link made stays listed with its Copy link (personas-33): a second one never hides the first, which still works.
 * Space settings lists its links itself, read from the server (`listed`, `SpaceLinks`), so they stay when Add people folds and on a reload.
 * Focus stays in the Email field for the next address (personas-36): after Invite, and on what is wrong with the one typed. The link is one
 * Tab further, and Enter in it never submits the window around it.
 */
export function SomeoneNew({ workspaceId, spaceId, spaceName, companyName, members, inSpace, meId, onTick, onMade, links, listed = false }: {
  workspaceId: string; spaceId: string | null; spaceName: string; companyName: string; members: WorkspaceMember[];
  inSpace: (userId: string) => boolean; meId: string; onTick: (userId: string) => void; onMade?: (invite: WorkspaceInvite) => void;
  /** The links already made where the parent keeps them (New space), so closing Add people and opening it again lists them still. */
  links?: WorkspaceInvite[];
  /** The parent lists the links (Space settings' `SpaceLinks`): this row then shows none of its own. */
  listed?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');
  const [own, setOwn] = useState<WorkspaceInvite[]>([]);
  const made = listed ? [] : links ?? own;
  const fresh = made.at(-1) ?? null;
  const keys = useRef(attemptKeys());
  const fieldRef = useRef<HTMLInputElement>(null);
  // Back to the field for the next address, or to fix this one: also after a press of Invite, which a busy button would otherwise leave.
  const toField = () => fieldRef.current?.focus();
  async function invite(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    setStatus(''); setProblem('');
    if (!EMAIL.test(address)) { setProblem('Enter their email address.'); toField(); return; }
    const known = members.find((member) => member.email.toLowerCase() === address);
    if (known) {
      if (known.userId === meId || inSpace(known.userId)) setProblem(`${known.userId === meId ? 'You are' : `${known.name} is`} already in ${spaceName}.`);
      else { onTick(known.userId); setEmail(''); setStatus(`${known.name} is in ${companyName}: ticked above.`); }
      toField();
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
    } catch (error) {
      setProblem(problemText(error, { workspace: companyName, email: address }));
    } finally { setBusy(false); requestAnimationFrame(toField); }
  }
  return (
    <div className="spset__new" data-someone-new="">
      {/* Not a <form>: New space is one already, and a form inside a form would also submit the window (Enter included). */}
      <div className="spset__newform" role="form" aria-label="Invite someone new">
        <Input ref={fieldRef} id="spset-new-email" label="Someone new?" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          aria-invalid={problem ? true : undefined} aria-describedby={problem || fresh ? undefined : 'spset-new-hint'} onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void invite(event); }} />
        <Button variant="secondary" busy={busy} onClick={(event) => void invite(event)}>Invite</Button>
      </div>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p>
        : fresh ? null : <p className="people__hint" id="spset-new-hint">They join {companyName} and {spaceName} with the link.</p>}
      {made.map((invite, at) => (
        <div key={invite.id} className="people__link" role="group" aria-label="New invite link">
          <Input id={`spset-new-link-${at}`} label={`Link for ${invite.email ?? 'anyone'}`} readOnly value={invite.link}
            onFocus={(event) => event.currentTarget.select()} onKeyDown={keepWindow} />
          <div className="details__actions"><Button variant="secondary" aria-label={`Copy link for ${invite.email ?? 'anyone'}`}
            onClick={() => void copyText(invite.link).then((ok) => setStatus(ok ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.'))}><Icon name="copy" size={14} />Copy link</Button></div>
        </div>
      ))}
      <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>
    </div>
  );
}

/**
 * The links Someone new? made for a space, as Space settings lists them (personas-36): read from the server, so they are there when Add people
 * is folded and after a reload, also those made in New space, each with Copy link and Revoke as Settings › Company has them. The link just
 * made shows once in its row, in a read-only field to read or select. A link used, revoked or expired leaves the list.
 */
export function SpaceLinks({ workspaceId, companyName, links, fresh, meId, onRevoked }: {
  workspaceId: string; companyName: string; links: WorkspaceInvite[]; fresh: string | null; meId: string; onRevoked: (id: string) => void;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const who = (invite: WorkspaceInvite) => invite.email ?? 'Anyone with the link';
  async function copy(invite: WorkspaceInvite) {
    const copied = await copyText(invite.link);
    setStatus(copied ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.');
    // Where the browser refuses, the link is shown in its row to be selected by hand.
    if (!copied) setShown(invite.id);
  }
  async function revoke(invite: WorkspaceInvite) {
    setProblem(''); setStatus('');
    try {
      await revokeInvite(workspaceId, invite.id);
      setStatus('Invite link revoked. It no longer works.');
      onRevoked(invite.id);
    } catch (error) {
      setProblem(problemText(error, { workspace: companyName }));
    }
  }
  const statusLine = <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>;
  if (!links.length) return <div className="people__waiting-none">{statusLine}{problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}</div>;
  return (
    <section className="details__sec spset__links" aria-labelledby="spset-links-h" data-space-links="">
      <h4 id="spset-links-h">Invited with a link <span className="people__count">{links.length}</span></h4>
      <ul className="people__list sset-card people__waiting" aria-label={`Invited with a link · ${links.length}`}>
        {links.map((invite) => (
          <li className="people__item" key={invite.id} data-invite={invite.id}>
            <div className="people__row">
              <span className="people__who"><b>{who(invite)}</b><span>Member · until {until.format(new Date(invite.expiresAt))} · by {youLabel(invite.createdBy.name, invite.createdBy.id === meId)}</span></span>
              <Button variant="quiet" size="sm" className="people__change" onClick={() => void copy(invite)}>Copy link<span className="ui-vh"> for {who(invite)}</span></Button>
              <Button variant="quiet" size="sm" className="people__change" aria-expanded={revoking === invite.id} onClick={() => setRevoking(revoking === invite.id ? null : invite.id)}>Revoke<span className="ui-vh"> link for {who(invite)}</span></Button>
            </div>
            {fresh === invite.id || shown === invite.id ? (
              <div className="people__link" role="group" aria-label="New invite link">
                <Input id={`spset-link-${invite.id}`} label={`Link for ${invite.email ?? 'anyone'}`} readOnly value={invite.link} onFocus={(event) => event.currentTarget.select()} onKeyDown={keepWindow} />
              </div>
            ) : null}
            {/* A revoked link can't come back, so Revoke asks once, in place, as in Settings › Company (#763 FT-13). */}
            {revoking === invite.id ? (
              <div className="people__edit" role="group" aria-label={`Revoke link for ${who(invite)}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRevoking(null); } }}>
                <p className="access__preview">The link stops working at once and can’t be restored. You can make a new one.</p>
                <div className="details__actions">
                  <Button variant="danger" onClick={() => { setRevoking(null); void revoke(invite); }}>Revoke link</Button>
                  <Button variant="secondary" onClick={() => setRevoking(null)}>Keep it</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {statusLine}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </section>
  );
}
