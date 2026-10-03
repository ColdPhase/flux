import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ReturnItem, ReturnNextStep, ReturnPlace, ReturnSource, ReturnSummary } from '@flux/contracts';
import { Button, Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { getReturnSummary, saveReturnPoint, sourceHref } from './api';
import './since.css';

// "Since you left" (#106) on Home: a short list in human language; every item opens its source.
// No guilt: nothing to clear, no streaks, one next step with its reason. Visiting acknowledges
// nothing (HOME-1, #190): the list stays until "I have the context", as a project's "What matters"
// (#133, WhatMatters.tsx) does, which reuses the rows below.

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const shortWhen = (iso: string) => (sameDay(iso) ? time.format(new Date(iso)) : day.format(new Date(iso)));
const since = (iso: string) => (sameDay(iso) ? `today, ${time.format(new Date(iso))}` : day.format(new Date(iso)));

type Ack = 'idle' | 'busy' | 'done' | 'failed';


/**
 * Loads the summary of a place. A visit never moves the return point (HOME-1, #190): only
 * "I have the context" saves it, at the mark this visit showed. The one exception is a place with no
 * point yet, whose first visit saves a starting point: nothing was shown, so nothing is acknowledged.
 */
function useReturn(place: ReturnPlace) {
  const placeKey = place.type === 'home' ? 'home' : `${place.type}:${place.id}`;
  // Only the current request's authorized response is ever shown: nothing is kept on the client
  // between mounts, accounts or visits, so a revoked item or another account's item never appears.
  const [loadedFor, setLoaded] = useState<{ key: string; summary: ReturnSummary } | null>(null);
  const [ack, setAck] = useState<{ key: string; state: Ack }>({ key: placeKey, state: 'idle' });
  // A summary is shown only for the place it was loaded for.
  const summary = loadedFor?.key === placeKey ? loadedFor.summary : null;
  useEffect(() => {
    const controller = new AbortController();
    const target: ReturnPlace = placeKey === 'home' ? { type: 'home' } : { type: placeKey.split(':')[0] as 'project', id: placeKey.split(':')[1]! };
    getReturnSummary(target, controller.signal).then(async (loaded) => {
      if (controller.signal.aborted) return;
      setLoaded({ key: placeKey, summary: loaded });
      if (loaded.point.savedAt === null) await saveReturnPoint(target, loaded.mark).catch(() => undefined);
    }).catch(() => { /* the line is optional; the place works without it */ });
    return () => controller.abort();
  }, [placeKey]);
  const acknowledge = async () => {
    if (!summary) return;
    setAck({ key: placeKey, state: 'busy' });
    try {
      await saveReturnPoint(place, summary.mark);
      setAck({ key: placeKey, state: 'done' });
    } catch { setAck({ key: placeKey, state: 'failed' }); }
  };
  return { summary, ack: ack.key === placeKey ? ack.state : 'idle' as Ack, acknowledge };
}

/** Opens a source: a link for messages, materials and sketches; Details on the project for work objects. */
export function SourceLink({ source, className, children, label }: { source: ReturnSource; className: string; children: ReactNode; label?: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { openDetails } = useShellActions();
  const href = sourceHref(source);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (source.type !== 'work' && source.type !== 'decision' && source.type !== 'result') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    // Already on the project: open Details in place and keep the conversation where it is.
    if (!pathname.startsWith(href)) navigate(href);
    openDetails({ kind: source.type, id: source.id });
  };
  return <Link to={href} className={className} onClick={onClick} aria-label={label}>{children}</Link>;
}

export function Item({ item, showProject }: { item: ReturnItem; showProject?: boolean }) {
  return (
    <li>
      <SourceLink source={item.source} className={`since__item${item.needsYou ? ' is-need' : ''}`}>
        <span className={`since__dot${item.needsYou ? ' since__dot--need' : ''}`} aria-hidden="true" />
        <span className="since__body">
          <span className="since__text">{item.text}</span>
          {item.needsYou ? <span className="ui-vh">, needs you</span> : null}
          {item.detail || (showProject && item.project) ? (
            <span className="since__detail">{[showProject ? item.project?.name : null, item.detail].filter(Boolean).join(' · ')}</span>
          ) : null}
        </span>
        <time className="since__when" dateTime={item.at}>{shortWhen(item.at)}</time>
        {/* Every row opens its source; the cue is quiet so the list stays calm. */}
        <Icon name="chevron-right" size={14} className="since__go" />
      </SourceLink>
    </li>
  );
}

export function NextStep({ step }: { step: ReturnNextStep }) {
  return (
    <div className="since__next">
      <span className="since__next-k">Next step</span>
      <SourceLink source={step.source} className="since__next-link"><span>{step.text}</span><Icon name="chevron-right" size={14} /></SourceLink>
      <p className="since__why">{step.reason}</p>
    </div>
  );
}

function Foot({ summary, ack, onAcknowledge }: { summary: ReturnSummary; ack: Ack; onAcknowledge: () => void }) {
  return (
    <div className="since__foot">
      <span>{summary.point.savedAt ? `Caught up to ${dayTime.format(new Date(summary.point.savedAt))}` : ''}</span>
      {ack === 'failed' ? <span className="since__failed" role="alert">Could not save. Try again; nothing was changed.</span> : null}
      <Button variant="secondary" icon="check" className="since__ack" busy={ack === 'busy'} onClick={onAcknowledge}>I have the context</Button>
    </div>
  );
}

function headline(summary: ReturnSummary) {
  const count = summary.items.length;
  return <><b>{summary.more ? `${count}+ updates` : `${count} ${count === 1 ? 'update' : 'updates'}`}</b> since {since(summary.point.savedAt!)}
    {summary.needsYou ? <> · <span className="since__need">{summary.needsYou} {summary.needsYou === 1 ? 'needs' : 'need'} you</span></> : null}</>;
}

/** Home: the personal return view across the places the person can see now, grouped by place. */
export function SinceYouLeftHome({ onShown }: { onShown?: (shown: boolean) => void }) {
  const { summary, ack, acknowledge } = useReturn({ type: 'home' });
  const done = useRef<HTMLParagraphElement>(null);
  const visible = !!summary?.point.savedAt && !!summary.items.length;
  useEffect(() => { onShown?.(visible); }, [onShown, visible]);
  // After "I have the context" the list closes; focus stays here, on what happened.
  useEffect(() => { if (ack === 'done') done.current?.focus(); }, [ack]);
  if (ack === 'done') return <p className="since-home__done" role="status" tabIndex={-1} ref={done}>You’re caught up. New changes will show here.</p>;
  // Nothing new is not news: Home stays as it was.
  if (!summary || !summary.point.savedAt || !summary.items.length) return null;
  const groups = new Map<string, { name: string; items: ReturnItem[] }>();
  for (const item of summary.items.filter((entry) => entry.id !== summary.nextStep?.item)) {
    const key = item.project?.id ?? 'private';
    const group = groups.get(key) ?? { name: item.project?.name ?? 'Only you', items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return (
    <section className="since-home" aria-labelledby="since-home-h">
      <h3 id="since-home-h" className="since-home__h">Since you left <span className="since-home__sub">{headline(summary)}</span></h3>
      {summary.nextStep ? <NextStep step={summary.nextStep} /> : <p className="since__why">Nothing needs you right now.</p>}
      {[...groups.entries()].map(([key, group]) => (
        <div className="since-home__place" key={key}>
          <h4 className="since-home__name">{group.name}</h4>
          <ul className="since__list">{group.items.map((item) => <Item key={item.id} item={item} />)}</ul>
        </div>
      ))}
      <Foot summary={summary} ack={ack} onAcknowledge={() => void acknowledge()} />
    </section>
  );
}
