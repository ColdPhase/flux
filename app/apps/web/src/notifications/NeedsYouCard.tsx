import { Fragment, useState, type ReactNode } from 'react';
import type { NeedsYouItem } from '@flux/contracts';
import { AgentTag, Avatar, Button, Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery, type IconName } from '../ui';
import { ago, when } from './format';
import { ClampedWords } from '../assistant/ClampedWords';
import { peopleNamed } from '../assistant/peopleNamed';
import { useJoinCall } from '../live/useJoinCall';
import { useAgentHue } from '../agents/hues';

/** How an item is put off: Not now (until tomorrow morning, S11) or an agent's suggestion declined. */
export type SnoozeChoice = 'tomorrow' | 'decline';

export interface CardHandlers {
  accept(item: NeedsYouItem): void;
  done(item: NeedsYouItem): void;
  snooze(item: NeedsYouItem, choice: SnoozeChoice): void;
  /** Opens the item in the detail panel or sheet, or at its source. `reply`: Reply opens its source with the reply field focused (C-1). */
  open(item: NeedsYouItem, reply?: boolean): void;
  discuss(item: NeedsYouItem): void;
  unblock(item: NeedsYouItem): void;
  /** Approve all: everything one agent run waits for (F-036 AG-7), in the owner's own session. */
  applyChanges(item: NeedsYouItem): void;
  /** Answers an agent's question with one of its ready-made answers (S14); Undo holds it back for a moment. */
  answer?(item: NeedsYouItem, optionIndex: number): void;
}

/** Join a call this item announces (F-041): its place opens and you are in, with every device off. */
function JoinCall({ call, variant }: { call: { projectId: string; sessionId: string }; variant: 'primary' | 'secondary' }) {
  const join = useJoinCall();
  const [busy, setBusy] = useState(false);
  return <Button variant={variant} busy={busy} onClick={() => { setBusy(true); void join(call).finally(() => setBusy(false)); }}>Join</Button>;
}

export const KIND_WORD = { decision: 'Decision', question: 'Question', blocked: 'Blocked', mention: 'Mention', task: 'Task' } as const;
/** The word that names an item wherever it is listed: a call's notice or an invitation to a call is a Call (F-041), never a Question (#1368). */
/** A call is "Call" and an answer to your question is "Reply" (#1424 decision 1): each is its kind otherwise (a question, a mention). */
export const kindWord = (item: NeedsYouItem) => (item.call ? 'Call' : item.answer ? 'Reply' : KIND_WORD[item.kind]);
const NOTE_ICON: Record<'question' | 'mention', IconName> = { question: 'chat', mention: 'people' };
/** Why a run's changes wait, once each, in their own words (#1089); the general sentence only if none has words. */
const waitReasons = (changes: readonly { line: string | null }[]) =>
  [...new Set(changes.map((change) => change.line).filter((line): line is string => !!line))].join(' ') || 'Deleting and other people\'s things always wait for your OK.';

/**
 * The keys an open item answers to are the buttons it shows (F-026 §4, #1424): R where it shows Reply, E where it shows Done, S where it
 * shows Not now. A decision shows Accept and Not now, never Done; an agent's suggestion shows Got it and Decline. The Inbox asks this
 * before a key acts, so a key never does what no button on screen offers.
 */
export function itemKeys(item: NeedsYouItem, canAnswer: boolean): { reply: boolean; done: boolean; notNow: boolean } {
  const decision = item.kind === 'decision';
  const quiet = !decision && !item.proposal;
  // A task given to you (#1424 C) shows Open, Not now and Done: it has no Reply.
  const reply = !decision && item.kind !== 'blocked' && item.kind !== 'task' && !(item.agentQuestion && canAnswer) && !item.proposal && !item.assistantChanges && !item.call
    && item.reason !== 'invitation';
  return { reply, done: quiet, notNow: quiet || decision };
}

/** Reply: opens the item's source with the reply field focused (C-1); `R` on the open item does the same. */
function ReplyButton({ onClick, keyHint = false }: { onClick: () => void; keyHint?: boolean }) {
  return <Button variant="secondary" aria-keyshortcuts="R" onClick={onClick}>Reply{keyHint ? <kbd aria-hidden="true">R</kbd> : null}</Button>;
}

/** Not now (S11): one button, no menu. It puts the item off until tomorrow morning and offers Undo. */
export function NotNowButton({ onClick, variant = 'secondary', className, keyHint = false }: { onClick: () => void; variant?: 'secondary' | 'quiet'; className?: string; keyHint?: boolean }) {
  return <Button variant={variant} className={className} aria-keyshortcuts="S" onClick={onClick}>Not now{keyHint ? <kbd aria-hidden="true">S</kbd> : null}</Button>;
}

export function Face({ item }: { item: NeedsYouItem }) {
  const hue = useAgentHue();
  if (item.kind === 'blocked') return <span className="nyc__face nyc__face--glyph"><StatusGlyph status="blocked" size={16} /></span>;
  if (item.kind === 'task' && !item.from) return <span className="nyc__face nyc__face--glyph"><StatusGlyph status="open" size={16} /></span>;
  if (item.from?.kind === 'agent' || item.assistantChanges) return <span className="nyc__face"><Kreska size={32} hue={hue(item.from?.kind === 'agent' ? item.from : null)} /></span>;
  if (item.from) return <span className="nyc__face"><Avatar name={item.from.name} id={item.from.id} size="lg" /></span>;
  if (item.call) return <span className="nyc__face nyc__face--icon"><Icon name="call" size={16} /></span>;
  return <span className="nyc__face nyc__face--icon"><Icon name={NOTE_ICON[item.kind === 'question' ? 'question' : 'mention']} size={16} /></span>;
}

export function WaitingLine({ item }: { item: NeedsYouItem }) {
  const decision = item.decision;
  if (!decision) return null;
  const you = decision.accepters.find((person) => person.you);
  const others = [...new Map(decision.accepters.filter((person) => !person.you).map((person) => [person.id, person])).values()];
  // Two people may share a name: the line names different names and counts everyone else, never "Basia, Basia" (#763). Up to three
  // are all named; "and 1 more" would hide a name the line has room for, so a count is only ever two or more (personas-27).
  const distinct = [...new Map(others.map((person) => [person.name, person])).values()];
  const named = distinct.length <= 3 ? distinct : distinct.slice(0, 2);
  const rest = others.length - named.length;
  const list = named.map((person) => person.name);
  const names = rest > 0 ? `${list.join(', ')} and ${rest} more` : list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  // Whose turn it is in words, you first (personas-28): "Waiting for you · Jonas can accept too", never your own face beside "waiting for you",
  // which read as that person waiting for you.
  return (
    <span className="nyc__waiting">
      {/* The separator ends the first part, so a wrap never starts the next line with a lone "·". */}
      {you ? <span className="nyc__waiting-you"><b>Waiting for you</b>{others.length ? <span aria-hidden="true"> ·</span> : null}</span> : null}
      {named.map((person) => <Avatar key={person.id} name={person.name} id={person.id} size="sm" />)}
      {others.length ? <span>{names} can accept too</span> : null}
    </span>
  );
}

/**
 * One thing that needs the person (#342, F-026 S1, P4), an item of the Inbox. Home lists the top of the Inbox as plain rows
 * that lead here (#865), so no action is offered twice. It is shown three ways (README §7 Inbox):
 * - `list`: a row of the two-column list, with no button: kind · who · space, the title and one line of what it says;
 * - `pane`: the open item in the right column, the card with no box around it;
 * - otherwise, in one column (a tablet in portrait, the phone), the card itself: the selected one expanded, the others one row
 *   with their one quiet action (`compact`). Not now and Done wait behind a swipe left on a phone (the tray) and are quiet buttons elsewhere.
 */
export function NeedsYouCard({ item, selected = false, compact = false, list = false, pane = false, onSelect, handlers, children }: {
  item: NeedsYouItem; selected?: boolean;
  /** An Inbox card that is not the selected one: one line with its one action, as drawn (desktop-inbox, #763 LD-1). */
  compact?: boolean;
  /** A row of the two-column list: compact, with no action and one line of what the item says. */
  list?: boolean;
  /** The open item of the two-column Inbox, in its own column. */
  pane?: boolean;
  onSelect?: () => void; handlers: CardHandlers; children?: ReactNode;
}) {
  // On a phone Not now and Done wait behind the card (a swipe left); elsewhere they are quiet buttons.
  const touch = useMediaQuery(MEDIA.touch);
  const decision = item.kind === 'decision';
  // Every row says the same on every device (personas-26: the phone dropped the space and the reason): "Kind · who · space", its title and
  // one line of what it says, each cut short with "…" where the width ends.
  const row = compact || list;
  const project = item.project?.name ?? null;
  // One agent run's waiting changes (F-036 AG-7): "Assistant · Your agent", then "3 things wait for you · Approve all · Open".
  const run = item.assistantChanges ?? null;
  // A call's notice or an invitation to a call is a Call (F-041), with Join.
  const word = kindWord(item);
  // Its name says who and where as its muted line does ("Question from Jonas in Rain barrel monitor: …"), also on a phone row, which has no room
  // to draw the space (#1424): a question's title is what was asked, not a sentence that names them.
  const label = run ? `${run.agentName}, your agent: ${item.title}`
    : `${[word, item.from?.name ? `from ${item.from.name}` : null, item.project ? `in ${item.project.name}` : null].filter(Boolean).join(' ')}: ${item.title}`;
  const meta = (run ? ['Your agent', project]
    : decision ? ['Decision', project] : item.kind === 'blocked' ? [word, item.blocked?.waitedBy ? 'waits for you' : 'your task', project, ago(item.at)] : [word, project]).filter(Boolean).join(' · ');
  const who = run?.agentName ?? item.from?.name ?? null;
  const asked = item.agentQuestion ?? null;
  // A row of any kind is one muted line, "Kind · who · space", then the title (README §7 Inbox, #1424): a decision "Decision · Maja · Community garden
  // sensors", a question or a mention "Question · Jonas · Rain barrel monitor", an agent's question "Question · Reviewer · Agent · …", a blocked task
  // "Blocked · waits for you · …". No row carries the time: the open item does.
  const rowParts: ReactNode[] = [
    word,
    ...(who ? [<Fragment key="who">{who}{item.from?.kind === 'agent' ? <> <AgentTag /></> : null}</Fragment>] : []),
    ...(asked?.task ? [`on #${asked.task.number}`] : []),
    ...(item.kind === 'blocked' ? [item.blocked?.waitedBy ? 'waits for you' : 'your task'] : []),
    ...(project ? [project] : []),
  ];
  // An agent's question names the task it is about, as drawn ("Claude Code · Agent · on #8").
  const askedMeta = asked ? [asked.task ? `on #${asked.task.number}` : null, project].filter(Boolean).join(' · ') : null;
  const answers = asked && handlers.answer ? asked.options.map((option, index) => (
    <Button key={option} variant="outline" className="nyc__answer" onClick={() => handlers.answer?.(item, index)}>{option}</Button>
  )) : null;
  const notNow = () => handlers.snooze(item, 'tomorrow');
  // What the item offers on every device: the buttons of the computer, which its keys follow too (#1424).
  const keys = itemKeys(item, !!handlers.answer);

  // A compact card keeps one quiet action on its right; the selected card alone carries the inverted primary.
  const single = compact && !list ? (
    <div className="nyc__rowactions">
      {decision ? <Button variant="secondary" onClick={() => handlers.accept(item)}>Accept</Button>
        : item.kind === 'blocked' || item.kind === 'task' ? <Button variant="secondary" onClick={() => handlers.open(item)}>Open</Button>
        : answers ? <Button variant="secondary" onClick={() => onSelect?.()}>Answer</Button>
        : item.proposal ? <Button variant="secondary" onClick={() => handlers.open(item)}>Review</Button>
        : run ? <Button variant="secondary" onClick={() => handlers.applyChanges(item)}>Approve all</Button>
        : item.call ? <JoinCall call={item.call} variant="secondary" />
        : <Button variant="secondary" onClick={() => handlers.open(item, item.reason !== 'invitation')}>{item.reason === 'invitation' ? 'Open' : 'Reply'}</Button>}
    </div>
  ) : null;
  const full = !row;
  // The tray holds what the card does not show itself: an open decision has Not now among its buttons already.
  const trayNotNow = keys.notNow && !(decision && full);

  const actions = (
    <div className="nyc__actions">
      {decision ? (
        <>
          <Button variant="primary" className="nyc__accept" aria-keyshortcuts="A" onClick={() => handlers.accept(item)}>Accept<kbd aria-hidden="true">A</kbd></Button>
          <NotNowButton onClick={notNow} keyHint />
          <Button variant="quiet" aria-keyshortcuts="R" onClick={() => handlers.discuss(item)}>Discuss<kbd aria-hidden="true">R</kbd></Button>
        </>
      ) : item.kind === 'blocked' ? (
        <>
          {/* One word for opening a task, the open item's one primary (personas-30): "Open", as a Task item has it. */}
          <Button variant="primary" onClick={() => handlers.open(item)}>Open</Button>
          {item.blocked?.waitedBy ? null : <Button variant="quiet" onClick={() => handlers.unblock(item)}>Unblock</Button>}
        </>
      ) : item.kind === 'task' ? (
        <Button variant="primary" onClick={() => handlers.open(item)}>Open</Button>
      ) : answers ? (
        <>{answers}</>
      ) : item.proposal ? (
        <>
          <Button variant="primary" onClick={() => handlers.done(item)}>Got it</Button>
          <Button variant="quiet" onClick={() => handlers.snooze(item, 'decline')}>Decline</Button>
        </>
      ) : run ? (
        <>
          <Button variant="primary" onClick={() => handlers.applyChanges(item)}>Approve all</Button>
          <Button variant="secondary" onClick={() => handlers.open(item)}>Open</Button>
        </>
      ) : item.call ? (
        <>
          <JoinCall call={item.call} variant="primary" />
          <Button variant="secondary" onClick={() => handlers.open(item)}>Open</Button>
        </>
      ) : item.reason === 'invitation' ? (
        <Button variant="secondary" onClick={() => handlers.open(item)}>Open</Button>
      ) : (
        <ReplyButton onClick={() => handlers.open(item, true)} keyHint />
      )}
      {!decision && !item.proposal && !touch ? <span className="nyc__quiet"><NotNowButton variant="quiet" onClick={notNow} keyHint /><Button variant="quiet" aria-keyshortcuts="E" onClick={() => handlers.done(item)}>Done<kbd aria-hidden="true">E</kbd></Button></span> : null}
    </div>
  );

  // The title of a row selects it (a row of the list), of a card in one column opens it, and in the open column it is only the heading.
  const Title = pane ? 'h2' : 'h3';
  const titleOf = pane ? item.title
    : <button type="button" className="nyc__open" onClick={() => (list ? onSelect?.() : handlers.open(item))} aria-haspopup={!list && (item.kind === 'blocked' || item.kind === 'task') ? 'dialog' : undefined}>{item.title}</button>;
  const body = (
    <div className={`nyc__card${pane ? ' nyc__card--pane' : ''}`} onClick={row && onSelect ? (event) => { if (!(event.target as HTMLElement).closest('button, a')) onSelect(); } : undefined}>
      <Face item={item} />
      <div className="nyc__body">
        {full && decision ? (
          <div className="nyc__head">
            <span className="nyc__who">
              <b>{who}</b>{item.from?.kind === 'agent' ? <AgentTag /> : null}
              <span className="nyc__meta">{meta} · {when(item.at)}</span>
            </span>
          </div>
        ) : row && !run ? (
          <p className="nyc__eyebrow nyc__eyebrow--row">
            <span className="nyc__meta">{rowParts.map((part, at) => <Fragment key={at}>{at ? ' · ' : null}{part}</Fragment>)}</span>
          </p>
        ) : (
          <p className="nyc__eyebrow">
            {asked ? <><b>{who}</b><AgentTag />{askedMeta ? <span className="nyc__meta">{[askedMeta, when(item.at)].filter(Boolean).join(' · ')}</span> : null}</>
              : <>{who ? <b>{who}</b> : null}{item.from?.kind === 'agent' || run ? <AgentTag /> : null}<span className="nyc__meta">{[meta, item.kind !== 'blocked' ? when(item.at) : null].filter(Boolean).join(' · ')}</span></>}
          </p>
        )}
        <Title className="nyc__title">{titleOf}</Title>
        {row && item.detail ? <p className="nyc__snippet">{item.detail}</p> : null}
        {full && run ? <ul className="nyc__waits" aria-label="What waits for you">{run.changes.map((change) => (
          <li key={change.id}>{change.waitReason === 'removal' ? <span>{`Delete ${change.objectTitle ? `“${change.objectTitle}”` : `the ${change.phrase.split(' ').pop()}`}`}</span>
            : (change.tells ?? []).length && change.after ? <span className="nyc__waits-words"><ClampedWords text={`${change.verb} ${change.after}`} /></span>
              : <span>{`${change.verb} ${change.objectTitle}`.trim()}</span>}
            {/* A task for someone else names them; what would tell people names who, also when both apply (#1089). The names wrap below
                the words when the row is narrow, so long names never squeeze the words away (#1102). */}
            {change.forPerson ? <span className="nyc__waits-for">{change.forPerson.name}</span> : null}
            {(change.tells ?? []).length ? <span className="nyc__waits-for">tells {peopleNamed(change.tells)}</span> : null}</li>))}</ul> : null}
        {/* Why they wait, in each change's own words (#1089: "It would notify Jonas…" is not "Deleting and other people's things…"). */}
        {full && run ? <p className="nyc__reason">{waitReasons(run.changes)}</p> : null}
        {full && item.detail && !item.proposal && !run ? <p className="nyc__reason">{item.detail}</p> : null}
        {full && item.proposal ? (
          <dl className="nyc__reason nyc__proposal" data-testid="agent-suggestion">
            <dt>Seen</dt><dd>{item.proposal.fact}</dd>
            <dt>Meaning</dt><dd>{item.proposal.interpretation}</dd>
            <dt>Suggested</dt><dd>{item.proposal.suggestedAction}</dd>
            <dt>Based on</dt><dd>{item.proposal.source.title} (version {item.proposal.source.version})</dd>
          </dl>
        ) : null}
        {/* What it waits for is its line above (personas-28); a task it needs first that it does not wait for by name is said here. */}
        {full && item.blocked?.waitingFor && !item.blocked.waitingOn ? <p className="nyc__reason">Waiting for #{item.blocked.waitingFor.number} {item.blocked.waitingFor.title}</p> : null}
        {full && !touch && decision && item.decision?.basedOn.length ? <p className="nyc__based"><span>Based on</span> {item.decision.basedOn.join(' · ')}</p> : null}
        {full && decision && item.decision?.supersedes ? <p className="nyc__based">This replaces the decision <b>{item.decision.supersedes}</b>.</p> : null}
        {full && decision ? (
          <div className="nyc__foot">{actions}<WaitingLine item={item} /></div>
        ) : full ? actions : null}
      </div>
      {single}
      {children}
    </div>
  );

  if (pane) {
    return (
      <article className={`nyc--open nyc--${item.kind}`} data-ai-surface={item.from?.kind === 'agent' || item.key.startsWith('assistant:') ? 'needs-you-ai' : undefined} aria-label={label}>
        {body}
      </article>
    );
  }
  return (
    <li className={`nyc nyc--card nyc--${item.kind}${selected ? ' is-selected' : ''}${row ? ' nyc--compact' : ''}${list ? ' nyc--list' : ''}`} data-key={item.key} data-ai-surface={item.from?.kind === 'agent' || item.key.startsWith('assistant:') ? 'needs-you-ai' : undefined} aria-current={selected ? 'true' : undefined} aria-label={label}>
      <div className="nyc__scroll">
        {/* A click on a compact card's free space selects it, and it opens up; its title and button keep their own actions. */}
        {body}
        {/* A swipe left on a phone: the card slides over this tray. Reachable by keyboard and touch alike. It offers what the computer offers
            (`itemKeys`, one rule on every device): a decision is put off with Not now, never marked Done while it waits (personas-26 P2 #4). */}
        {touch && (trayNotNow || keys.done) ? (
          <div className="nyc__tray">
            {trayNotNow ? <NotNowButton className="nyc__tray-b" onClick={notNow} /> : null}
            {keys.done ? <Button variant="primary" className="nyc__tray-b nyc__tray-done" aria-keyshortcuts="E" onClick={() => handlers.done(item)}><Icon name="check" size={16} />Done</Button> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
