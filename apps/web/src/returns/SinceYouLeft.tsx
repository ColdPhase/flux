import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ReturnItem, ReturnNextStep, ReturnPlace, ReturnSource, ReturnSummary } from '@flux/contracts';
import { Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { getReturnSummary, restoreReturnPoint, saveReturnPoint, sourceHref } from './api';
import './since.css';

// "Since you left" (#106) on Home: a short list in human language; every item opens its source.
// No guilt: nothing to clear, no streaks, one next step with its reason, and "Keep these for next
// time" moves the saved point back. A project's recap is "What matters" (#133, WhatMatters.tsx),
// which reuses the rows below.

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const shortWhen = (iso: string) => (sameDay(iso) ? time.format(new Date(iso)) : day.format(new Date(iso)));
const since = (iso: string) => (sameDay(iso) ? `today, ${time.format(new Date(iso))}` : day.format(new Date(iso)));

type Keep = 'idle' | 'busy' | 'kept' | 'failed';


/**
 * Loads the summary of a place and then saves the return point at what was shown, so the next
 * visit starts after it.
 */
function useReturn(place: ReturnPlace) {
  const placeKey = place.type === 'home' ? 'home' : `${place.type}:${place.id}`;
  // Only the current request's authorized response is ever shown: nothing is kept on the client
  // between mounts, accounts or visits, so a revoked item or another account's item never appears.
  const [loadedFor, setLoaded] = useState<{ key: string; summary: ReturnSummary } | null>(null);
  const [keep, setKeep] = useState<Keep>('idle');
  // "Keep these" must run after the save of this visit, or the save would overwrite it.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  // A summary is shown only for the place it was loaded for.
  const summary = loadedFor?.key === placeKey ? loadedFor.summary : null;
  useEffect(() => {
    const controller = new AbortController();
    const target: ReturnPlace = placeKey === 'home' ? { type: 'home' } : { type: placeKey.split(':')[0] as 'project', id: placeKey.split(':')[1]! };
    getReturnSummary(target, controller.signal).then(async (loaded) => {
      if (controller.signal.aborted) return;
      setLoaded({ key: placeKey, summary: loaded });
      saving.current = saveReturnPoint(target, loaded.mark).catch(() => undefined);
      await saving.current;
    }).catch(() => { /* the line is optional; the place works without it */ });
    return () => controller.abort();
  }, [placeKey]);
  const keepForLater = async () => {
    setKeep('busy');
    try {
      await saving.current;
      await restoreReturnPoint(place); setKeep('kept'); } catch { setKeep('failed'); }
  };
  return { summary, keep, keepForLater };
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

function Foot({ summary, keep, onKeep }: { summary: ReturnSummary; keep: Keep; onKeep: () => void }) {
  return (
    <div className="since__foot">
      <span>{summary.point.savedAt ? `You were last here ${dayTime.format(new Date(summary.point.savedAt))}` : ''}</span>
      {keep === 'kept'
        ? <span role="status">These will show again next time.</span>
        : <button type="button" className="since__keep" disabled={keep === 'busy'} onClick={onKeep}>
          {keep === 'failed' ? 'Could not keep them. Try again' : 'Keep these for next time'}</button>}
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
  const { summary, keep, keepForLater } = useReturn({ type: 'home' });
  const visible = !!summary?.point.savedAt && !!summary.items.length;
  useEffect(() => { onShown?.(visible); }, [onShown, visible]);
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
      <Foot summary={summary} keep={keep} onKeep={() => void keepForLater()} />
    </section>
  );
}
