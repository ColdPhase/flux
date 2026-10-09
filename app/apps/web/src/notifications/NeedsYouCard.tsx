import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { NeedsYouItem } from '@flux/contracts';
import { AgentTag, Avatar, Button, Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery, type IconName } from '../ui';
import { ago, when } from './format';

/** How an item can be put off: tomorrow morning, next week, until its task is done, or for good. */
export type SnoozeChoice = 'tomorrow' | 'week' | 'task' | 'decline';

export interface CardHandlers {
  accept(item: NeedsYouItem): void;
  done(item: NeedsYouItem): void;
  snooze(item: NeedsYouItem, choice: SnoozeChoice): void;
  /** Opens the item in the detail panel or sheet, or at its source. */
  open(item: NeedsYouItem): void;
  discuss(item: NeedsYouItem): void;
  unblock(item: NeedsYouItem): void;
}

export const KIND_WORD = { decision: 'Decision', question: 'Question', blocked: 'Blocked', mention: 'Mention' } as const;
const NOTE_ICON: Record<'question' | 'mention', IconName> = { question: 'chat', mention: 'people' };

/** "Not now" asks when it should return (F-026 S11): the menu, `1` `2` `3` and Esc. */
export function NotNowMenu({ item, onChoose, onClose, anchors }: {
  item: NeedsYouItem; onChoose: (choice: SnoozeChoice) => void; onClose: () => void; anchors: RefObject<HTMLElement | null>[];
}) {
  const menu = useRef<HTMLDivElement>(null);
  const task = item.snoozeTask;
  const choices: { id: SnoozeChoice; label: string }[] = [
    { id: 'tomorrow', label: 'Tomorrow morning' },
    { id: 'week', label: 'Next week' },
    ...(task ? [{ id: 'task' as const, label: `When #${task.number} is done` }] : []),
  ];
  const anchorOf = () => anchors.map((ref) => ref.current).find((element): element is HTMLElement => !!element) ?? null;
  // Sits under the button that opened it.
  useLayoutEffect(() => {
    const anchor = anchorOf();
    const parent = menu.current?.offsetParent;
    if (menu.current && anchor && parent instanceof HTMLElement) menu.current.style.left = `${Math.max(0, anchor.getBoundingClientRect().left - parent.getBoundingClientRect().left)}px`;
  });
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchors.some((ref) => ref.current?.contains(event.target as Node))) onClose();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [anchors, onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchorOf()?.focus(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Tab') onClose();
    else if (/^[1-3]$/.test(event.key) && choices[Number(event.key) - 1]) { event.preventDefault(); event.stopPropagation(); onChoose(choices[Number(event.key) - 1]!.id); }
  };
  return (
    <div ref={menu} className="nym" role="menu" aria-label="Ask me again" onKeyDown={onKeyDown}>
      <span className="nym__h">Ask me again</span>
      {choices.map((choice, index) => (
        <button key={choice.id} type="button" role="menuitem" className="nym__item" onClick={() => onChoose(choice.id)}>
          {choice.label}<kbd aria-hidden="true">{index + 1}</kbd>
        </button>
      ))}
      <span className="nym__sep" role="separator" />
      <button type="button" role="menuitem" className="nym__item nym__item--quiet" title="Takes it out of your Inbox only. The decision stays proposed for others." onClick={() => onChoose('decline')}>
        Decline for good
      </button>
    </div>
  );
}

function NotNowButton({ buttonRef, open, onToggle, className = '' }: { buttonRef: RefObject<HTMLButtonElement | null>; open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button ref={buttonRef} type="button" className={`ui-btn ui-btn--secondary nyc__nn${className}`} aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts="S" onClick={onToggle}>
      Not now<Icon name="chevron-down" size={14} />
    </button>
  );
}

function Face({ item }: { item: NeedsYouItem }) {
  if (item.kind === 'blocked') return <span className="nyc__face nyc__face--glyph"><StatusGlyph status="blocked" size={16} /></span>;
  if (item.from?.kind === 'agent') return <span className="nyc__face"><Kreska size={32} /></span>;
  if (item.from) return <span className="nyc__face"><Avatar name={item.from.name} size="lg" /></span>;
  return <span className="nyc__face nyc__face--icon"><Icon name={NOTE_ICON[item.kind === 'question' ? 'question' : 'mention']} size={16} /></span>;
}

function WaitingLine({ item }: { item: NeedsYouItem }) {
  const decision = item.decision;
  if (!decision) return null;
  const you = decision.accepters.find((person) => person.you);
  const others = decision.accepters.filter((person) => !person.you);
  const names = others.length > 2 ? `${others.slice(0, 2).map((person) => person.name).join(', ')} and ${others.length - 2} more` : others.map((person) => person.name).join(' and ');
  return (
    <span className="nyc__waiting">
      {others.slice(0, 2).map((person) => <Avatar key={person.id} name={person.name} size="sm" />)}
      {others.length ? <span>{names} can accept too</span> : null}
      {others.length && you ? <span aria-hidden="true">·</span> : null}
      {you ? <><Avatar name={you.name} size="sm" tone="me" /><b>waiting for you</b></> : null}
    </span>
  );
}

/**
 * One thing that needs the person (#342, F-026 S1, P4). `card` is the Inbox's, `row` is Home's compact line
 * (the same actions, the same keys). A decision is one card on every device: "Proposed decision",
 * "Needs you", the reason, what it rests on, then Accept / Not now / Discuss. The tray after the card
 * holds Not now and Done for a swipe left on a phone; on a computer they are quiet buttons.
 */
export function NeedsYouCard({ item, variant = 'card', selected = false, handlers, menuOpen, onMenuOpen, children }: {
  item: NeedsYouItem; variant?: 'card' | 'row'; selected?: boolean; handlers: CardHandlers;
  menuOpen: boolean; onMenuOpen: (open: boolean) => void; children?: ReactNode;
}) {
  // On a phone Not now and Done wait behind the card (a swipe left); elsewhere they are quiet buttons.
  const touch = useMediaQuery(MEDIA.touch);
  const notNow = useRef<HTMLButtonElement>(null);
  const trayNotNow = useRef<HTMLButtonElement>(null);
  const anchors = useMemo(() => [notNow, trayNotNow], []);
  const label = `${KIND_WORD[item.kind]}: ${item.title}`;
  const decision = item.kind === 'decision';
  const project = item.project?.name ?? null;
  const meta = (decision ? ['Proposed decision', project] : item.kind === 'blocked' ? ['Your task', project, ago(item.at)] : [KIND_WORD[item.kind], project]).filter(Boolean).join(' · ');
  const who = item.from?.name ?? null;

  const actions = (
    <div className="nyc__actions">
      {decision ? (
        <>
          <Button variant="primary" className="nyc__accept" aria-keyshortcuts="A" onClick={() => handlers.accept(item)}>Accept<kbd aria-hidden="true">A</kbd></Button>
          <NotNowButton buttonRef={notNow} open={menuOpen} onToggle={() => onMenuOpen(!menuOpen)} />
          {variant === 'card' ? <Button variant="quiet" onClick={() => handlers.discuss(item)}>Discuss</Button> : null}
        </>
      ) : item.kind === 'blocked' ? (
        <>
          <Button variant="secondary" onClick={() => handlers.open(item)}>Open task</Button>
          <Button variant="quiet" onClick={() => handlers.unblock(item)}>Unblock</Button>
        </>
      ) : (
        <Button variant="secondary" onClick={() => handlers.open(item)}>{item.reason === 'invitation' ? 'Open' : 'Reply'}</Button>
      )}
      {!decision && !touch && variant === 'card' ? <span className="nyc__quiet"><NotNowButton buttonRef={notNow} open={menuOpen} onToggle={() => onMenuOpen(!menuOpen)} className=" nyc__nn--quiet" /><Button variant="quiet" aria-keyshortcuts="E" onClick={() => handlers.done(item)}>Done</Button></span> : null}
    </div>
  );

  return (
    <li className={`nyc nyc--${variant} nyc--${item.kind}${selected ? ' is-selected' : ''}`} data-key={item.key} aria-current={selected ? 'true' : undefined} aria-label={label}>
      <div className="nyc__scroll">
        <div className="nyc__card">
          <Face item={item} />
          <div className="nyc__body">
            {variant === 'card' && decision ? (
              <div className="nyc__head">
                <span className="nyc__who">
                  <b>{who}</b>{item.from?.kind === 'agent' ? <AgentTag /> : null}
                  <span className="nyc__meta">{meta} · {when(item.at)}</span>
                </span>
                <span className="nyc__chip">Needs you</span>
              </div>
            ) : (
              <p className="nyc__eyebrow">
                {variant === 'row'
                  ? [KIND_WORD[item.kind], who, project].filter(Boolean).join(' · ')
                  : <>{who ? <b>{who}</b> : null}{item.from?.kind === 'agent' ? <AgentTag /> : null}<span className="nyc__meta">{[meta, variant === 'card' && item.kind !== 'blocked' ? when(item.at) : null].filter(Boolean).join(' · ')}</span></>}
              </p>
            )}
            <h3 className="nyc__title">
              <button type="button" className="nyc__open" onClick={() => handlers.open(item)} aria-haspopup={item.kind === 'decision' || item.kind === 'blocked' ? 'dialog' : undefined}>{item.title}</button>
            </h3>
            {variant === 'card' && item.detail && item.kind !== 'blocked' ? <p className="nyc__reason">{item.detail}</p> : null}
            {variant === 'card' && item.blocked?.waitingFor ? <p className="nyc__reason">Waiting for #{item.blocked.waitingFor.number} {item.blocked.waitingFor.title}</p> : null}
            {variant === 'card' && decision && item.decision?.basedOn.length ? <p className="nyc__based"><span>Based on</span> {item.decision.basedOn.join(' · ')}</p> : null}
            {variant === 'card' && decision && item.decision?.supersedes ? <p className="nyc__based"><span>Would replace</span> {item.decision.supersedes}</p> : null}
            {variant === 'card' && decision ? (
              <div className="nyc__foot">{actions}<WaitingLine item={item} /></div>
            ) : variant === 'card' ? actions : null}
          </div>
          {variant === 'row' ? <div className="nyc__rowactions">{decision ? <>
            <Button variant="primary" onClick={() => handlers.accept(item)}>Accept</Button>
            <NotNowButton buttonRef={notNow} open={menuOpen} onToggle={() => onMenuOpen(!menuOpen)} /></> : <Button variant="secondary" onClick={() => handlers.open(item)}>{item.kind === 'blocked' ? 'Open task' : item.reason === 'invitation' ? 'Open' : 'Reply'}</Button>}</div> : null}
          {children}
        </div>
        {/* A swipe left on a phone: the card slides over this tray. Reachable by keyboard and touch alike. */}
        {touch && variant === 'card' ? (
          <div className="nyc__tray">
            {!decision ? <NotNowButton buttonRef={trayNotNow} open={menuOpen} onToggle={() => onMenuOpen(!menuOpen)} className=" nyc__tray-b" /> : null}
            <Button variant="primary" className="nyc__tray-b nyc__tray-done" aria-keyshortcuts="E" onClick={() => handlers.done(item)}><Icon name="check" size={16} />Done</Button>
          </div>
        ) : null}
      </div>
      {menuOpen ? <NotNowMenu item={item} anchors={anchors} onChoose={(choice) => { onMenuOpen(false); handlers.snooze(item, choice); }} onClose={() => onMenuOpen(false)} /> : null}
    </li>
  );
}
