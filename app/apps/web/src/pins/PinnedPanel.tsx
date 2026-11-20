import { useNavigate } from 'react-router';
import type { PinnedMessage, PinPlace } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { clock, day } from '../app/timeFormat';
import { youLabel } from '../docs/format';
import { Button, Icon, useMediaQuery, MEDIA } from '../ui';
import { AuthorFace } from '../ui/AuthorFace';
import { plainWords } from '../work/messageWords';
import { usePins } from './pins';
import './pins.css';

// "Pinned · N" (C-74, #1615): the conversation's pinned messages in the one detail panel on a computer (S4) and as its sheet on a phone, the
// newest pin first. A row is the author's face, the words in two lines (a file as its chip) and "Author · when · pinned by X" ("in a thread"
// for a reply). Choosing a row brings the message into view and marks it, as a link to it does; Unpin shows on hover or focus.

const when = (iso: string) => (day(iso) === 'Today' ? clock(iso) : day(iso));

/** Where a pinned message is: its link, which opens it in the conversation (or in its thread) marked, as Copy link's address does. */
function addressOf(place: PinPlace, item: PinnedMessage): string | null {
  if (place.type === 'project') return `/projects/${place.id}/conversations/${item.conversationId}#message-${item.messageId}`;
  if (place.type === 'dm') return item.threadRootId ? `/dm/${place.id}?thread=${item.threadRootId}#thread-message-${item.messageId}` : `/dm/${place.id}#message-${item.messageId}`;
  return null;
}

/** An agent's chat is one page: its line is brought into view and marked there for a moment. */
function showInChat(item: PinnedMessage) {
  const id = CSS.escape(item.messageId);
  const node = document.querySelector<HTMLElement>(item.part ? `[data-run-id="${id}"][${item.part === 'prompt' ? 'data-chat-me' : 'data-chat-agent'}]` : `[data-line-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.focus({ preventScroll: true });
  node.classList.remove('is-arrived');
  void node.offsetWidth;
  node.classList.add('is-arrived');
  window.setTimeout(() => node.classList.remove('is-arrived'), 2400);
}

export function PinnedPanel() {
  const pins = usePins();
  const { me } = useShellData();
  const shell = useShellActions();
  const navigate = useNavigate();
  const phone = useMediaQuery(MEDIA.phone);
  const { place, items } = pins;
  if (!place) return null;
  const open = (item: PinnedMessage) => {
    const address = addressOf(place, item);
    // A space's or a direct message's message opens at its address (its thread takes the panel's place); in an agent's chat the computer's panel
    // stays beside the chat and the phone's sheet closes, so the message is in view.
    if (phone || address) shell.closePanel();
    if (address) void navigate(address); else showInChat(item);
  };
  const footer = place.type === 'project' ? 'Everyone in this space sees these.' : place.type === 'dm' ? 'Everyone in this conversation sees these.' : 'Only you see these.';
  return (
    <div className="pins" data-pins-panel="">
      {items === null ? <p className="pins__empty">Loading…</p> : !items.length ? (
        <p className="pins__empty">Nothing is pinned here yet. Pin a message from its ⋯ menu.</p>
      ) : (
        <ul className="pins__list" aria-label="Pinned messages">
          {items.map((item) => {
            const words = plainWords(item.body);
            const mine = item.author.kind === 'human' && item.author.id === me.user.id;
            const by = youLabel(item.pinnedBy.name, item.pinnedBy.id === me.user.id);
            return (
              <li key={`${item.messageId}:${item.part ?? ''}`} className="pins__row" data-pinned-id={item.messageId}>
                <button type="button" className="pins__open" onClick={() => open(item)} aria-label={`${youLabel(item.author.name, mine)}: ${words || 'a file'}. Show this message`}>
                  <AuthorFace kind={item.author.kind} id={item.author.id} name={item.author.name} mine={mine} hue={item.author.colour} />
                  <span className="pins__text">
                    <span className="pins__words">{words}{item.files?.map((file) => <span key={file.id} className="ref-chip pins__file"><Icon name="clip" size={12} />{file.name}</span>)}</span>
                    <span className="pins__meta">{youLabel(item.author.name, mine)} · {when(item.createdAt)}{item.threadRootId ? ' · in a thread' : ''} · pinned by {by}</span>
                  </span>
                </button>
                {pins.canPin ? <Button variant="quiet" className="pins__unpin" onClick={() => pins.toggle(item.messageId, item.part)}
                  aria-label={`Unpin ${youLabel(item.author.name, mine)}’s message`}>Unpin</Button> : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="pins__foot">{footer} The newest pin is first.</p>
    </div>
  );
}
