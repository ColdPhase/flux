import { useState } from 'react';
import { Avatar, Button, Icon, IconButton } from '../ui';
import { inviteToSession } from './api';
import type { LiveValue } from './LiveProvider';

// The strip's one invite control (F-041 point 4, #1424): "Invite someone" opens this and nothing else: the people of the space who are not in the
// call, each with Invite, and "Invited" once it went. It never repeats the devices, quiet or Leave; those are the strip's own and ⋯'s.

export type Invited = Record<string, 'sending' | 'sent' | 'failed'>;

/** The space's people who could be invited now: humans, not you, not already in the call. */
export function peopleToInvite(live: LiveValue) {
  const inRoom = new Set((live.media?.people ?? []).map((person) => person.userId));
  return live.people.filter((person) => person.kind === 'human' && !inRoom.has(person.id) && person.id !== live.meId);
}

/** Who was invited in this call, kept while the call lasts so closing and opening the list again does not offer to invite them twice. */
export function useInvited(sessionId: string | undefined): [Invited, (userId: string, state: Invited[string]) => void] {
  const [kept, setKept] = useState<{ sessionId: string | undefined; invited: Invited }>({ sessionId, invited: {} });
  const invited = kept.sessionId === sessionId ? kept.invited : {};
  return [invited, (userId, state) => setKept((current) => ({ sessionId, invited: { ...(current.sessionId === sessionId ? current.invited : {}), [userId]: state } }))];
}

export function InvitePanel({ live, invited, onInvited, onClose }: {
  live: LiveValue; invited: Invited; onInvited(userId: string, state: Invited[string]): void; onClose(): void;
}) {
  const people = peopleToInvite(live);
  const invite = async (userId: string) => {
    if (!live.session) return;
    onInvited(userId, 'sending');
    try { await inviteToSession(live.session.id, userId); onInvited(userId, 'sent'); } catch { onInvited(userId, 'failed'); }
  };
  const first = people.find((person) => invited[person.id] !== 'sent');
  return (
    <div className="lv-panel lv-panel--invite">
      <header className="lv-panel__head">
        {/* Always in the first screen: a phone has no Escape for the sheet. */}
        <IconButton icon="x" label="Close" onClick={onClose} className="lv-panel__close" />
        <h2 className="lv-panel__t">Invite someone</h2>
        <p className="lv-panel__aud"><Icon name="lock" size={12} />Only the people who can open this space can join</p>
      </header>
      <section className="lv-panel__sec" aria-label="People to invite">
        {people.length ? (
          <ul className="lv-people">
            {people.map((person) => (
              <li key={person.id} className="lv-person lv-person--absent">
                <Avatar name={person.name} id={person.id} size="md" />
                <span className="lv-person__b"><b>{person.name}</b><span>{invited[person.id] === 'sent' ? 'Invited · one quiet item in their inbox' : invited[person.id] === 'failed' ? 'Could not invite. They may no longer have access.' : 'Not in the call'}</span></span>
                {invited[person.id] === 'sent' ? <Icon name="check" size={14} /> : (
                  <Button variant="quiet" busy={invited[person.id] === 'sending'} {...(person.id === first?.id ? { 'data-autofocus': '' } : {})} onClick={() => void invite(person.id)}>Invite</Button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="lv-panel__text">Everyone who can join is in the call.</p>}
      </section>
    </div>
  );
}
