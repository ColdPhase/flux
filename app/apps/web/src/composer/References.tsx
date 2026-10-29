import type { MessageReferenceCard, MessageReferenceKind } from '@flux/contracts';
import { RefLink } from '../place/origin';
import { targetHref } from '../search/api';
import { Icon } from '../ui';
import type { DraftCite } from './draft';

// References to Flux objects inside a message (#469, F-026 §6): a map thought or a cited message is a card with the object's glyph,
// its kind, its title, one line of context and a target that opens it. The server makes each card for the reader who asks, so a
// target the reader may not open arrives as an "unavailable" card with nothing of it; this file only draws what it is given.

const KIND: Record<MessageReferenceKind, string> = { thought: 'Map thought', message: 'Cited message' };
/** On the card the kind is one short word, so the place and the title keep their room on a phone (#469 visual review). */
const SHORT: Record<MessageReferenceKind, string> = { thought: 'Thought', message: 'Message' };
const placeLabel = (place: string) => place === 'Direct message' ? 'DM' : place;
const GLYPH: Record<MessageReferenceKind, 'map' | 'cite'> = { thought: 'map', message: 'cite' };

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** The time of today's message, the date of an older one. */
function shortWhen(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === new Date().toDateString();
  return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** The one line at the card's right: who wrote a thought, or who wrote a message and when. */
export function referenceContext(card: Extract<MessageReferenceCard, { state: 'available' }>): string {
  const who = card.author ? firstName(card.author) : '';
  return card.kind === 'thought' ? who : [who, shortWhen(card.at)].filter(Boolean).join(' · ');
}

/** One reference of a stored message. It shares the Wiki card's shape, so it sits in the same bubble and obeys the same 44 px rule. */
export function ReferenceCard({ card }: { card: MessageReferenceCard }) {
  if (card.state === 'unavailable') {
    return <div className="wiki-card ref-card is-unavailable" role="note" data-ref={card.kind} data-ref-state="unavailable">
      <span className="wiki-card__glyph" aria-hidden="true"><Icon name="lock" size={14} /></span>
      <span className="wiki-card__text"><small>{SHORT[card.kind]}</small><strong>Not available to you</strong></span>
    </div>;
  }
  const context = referenceContext(card);
  return <RefLink to={targetHref(card.target)} className="wiki-card ref-card" data-ref={card.kind} data-ref-state="available"
    aria-label={`${KIND[card.kind]}: ${card.title}${context ? `, ${context}` : ''}, in ${card.place}`}>
    <span className="wiki-card__glyph" aria-hidden="true"><Icon name={GLYPH[card.kind]} size={14} /></span>
    <span className="wiki-card__text"><small>{SHORT[card.kind]} · {placeLabel(card.place)}</small><strong>{card.title}</strong></span>
    {context ? <span className="ref-card__ctx" aria-hidden="true">{context}</span> : null}
  </RefLink>;
}

/** The cards a message cites, in the order they were attached. Nothing when it cites nothing. */
export function MessageReferences({ references }: { references?: readonly MessageReferenceCard[] }) {
  if (!references?.length) return null;
  return <>{references.map((card, index) => <ReferenceCard key={index} card={card} />)}</>;
}

/** What a draft or a queued message cites, before the server has made the cards: the kind and the title the person chose. */
export function CiteTile({ cite, onRemove, disabled = false }: { cite: DraftCite; onRemove?: () => void; disabled?: boolean }) {
  return <div className="composer-cite" data-ref={cite.kind}>
    <span className="composer-cite__glyph" aria-hidden="true"><Icon name={GLYPH[cite.kind]} size={14} /></span>
    <span className="composer-cite__text"><small>{KIND[cite.kind]}{cite.context ? ` · ${cite.context}` : ''}</small><strong>{cite.title}</strong></span>
    {onRemove ? <button type="button" className="composer-cite__x" disabled={disabled} onClick={onRemove} aria-label={`Remove citation: ${cite.title}`}><Icon name="x" size={14} /></button> : null}
  </div>;
}
