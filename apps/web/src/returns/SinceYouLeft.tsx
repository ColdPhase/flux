import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ReturnItem, ReturnNextStep, ReturnPlace, ReturnSource, ReturnSummary } from '@flux/contracts';
import { Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { getReturnSummary, restoreReturnPoint, saveReturnPoint, sourceHref } from './api';
import './since.css';

// "Since you left" (#106, direction C `#since`). One slim line that expands into a short list in
// human language; every item opens its source. No guilt: nothing to clear, no streaks, one next
// step with its reason, and "Keep these for next time" moves the saved point back.

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const shortWhen = (iso: string) => (sameDay(iso) ? time.format(new Date(iso)) : day.format(new Date(iso)));
const since = (iso: string) => (sameDay(iso) ? `today, ${time.format(new Date(iso))}` : day.format(new Date(iso)));

type Keep = 'idle' | 'busy' | 'kept' | 'failed';

/**
 * What this tab showed per place during the visit. Opening a source navigates, and the place's
 * point is already saved, so coming back to the place within the visit shows the same list
 * again instead of an empty line. A reload starts a new visit.
 */
const shown = new Map<string, { summary: ReturnSummary; at: number }>();
const VISIT_MS = 30 * 60 * 1000;

/**
 * Loads the summary of a place and then saves the return point at what was shown, so the next
 * visit starts after it. `alsoSave` saves the same mark for a narrower place (the open conversation).
 */
function useReturn(place: ReturnPlace, alsoSave?: ReturnPlace) {
  const placeKey = place.type === 'home' ? 'home' : `${place.type}:${place.id}`;
  // Start from what this visit already showed, so switching views never shifts the page later.
  const [summary, setSummary] = useState<ReturnSummary | null>(() => {
    const earlier = shown.get(placeKey);
    return earlier && Date.now() - earlier.at < VISIT_MS ? earlier.summary : null;
  });
  const [keep, setKeep] = useState<Keep>('idle');
  // "Keep these" must run after the save of this visit, or the save would overwrite it.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const alsoKey = alsoSave && alsoSave.type !== 'home' ? `${alsoSave.type}:${alsoSave.id}` : '';
  useEffect(() => {
    const controller = new AbortController();
    const target: ReturnPlace = placeKey === 'home' ? { type: 'home' } : { type: placeKey.split(':')[0] as 'project', id: placeKey.split(':')[1]! };
    getReturnSummary(target, controller.signal).then(async (loaded) => {
      if (controller.signal.aborted) return;
      const earlier = shown.get(placeKey);
      if (!loaded.items.length && earlier && Date.now() - earlier.at < VISIT_MS) setSummary(earlier.summary);
      else { setSummary(loaded); if (loaded.items.length) shown.set(placeKey, { summary: loaded, at: Date.now() }); }
      saving.current = saveReturnPoint(target, loaded.mark).catch(() => undefined);
      await saving.current;
    }).catch(() => { /* the line is optional; the place works without it */ });
    return () => controller.abort();
  }, [placeKey]);
  useEffect(() => {
    if (!alsoKey || !summary) return;
    const conversation = alsoKey.split(':')[1]!;
    saving.current = saving.current.then(() => saveReturnPoint({ type: 'conversation', id: conversation }, summary.mark).catch(() => undefined));
  }, [alsoKey, summary]);
  const keepForLater = async () => {
    setKeep('busy');
    try {
      await saving.current;
      // Both points this visit saved move back, or the conversation's would still hide its messages.
      await Promise.all([restoreReturnPoint(place), ...(alsoKey ? [restoreReturnPoint({ type: 'conversation', id: alsoKey.split(':')[1]! })] : [])]); shown.delete(placeKey); setKeep('kept'); } catch { setKeep('failed'); }
  };
  return { summary, keep, keepForLater };
}

/** Opens a source: a link for messages, materials and sketches; Details on the project for work objects. */
function SourceLink({ source, className, children, label }: { source: ReturnSource; className: string; children: ReactNode; label?: string }) {
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

function Item({ item, showProject }: { item: ReturnItem; showProject?: boolean }) {
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

const FIRST = 6;

/** Whole rows only: the first few, then "Show N more". The next step is not repeated here. */
function Items({ summary, showProject }: { summary: ReturnSummary; showProject?: boolean }) {
  const [all, setAll] = useState(false);
  const rest = summary.items.filter((item) => item.id !== summary.nextStep?.item);
  const visible = all ? rest : rest.slice(0, FIRST);
  return <>
    <ul className="since__list">{visible.map((item) => <Item key={item.id} item={item} showProject={showProject} />)}</ul>
    {rest.length > visible.length ? <button type="button" className="since__more" onClick={() => setAll(true)}>Show {rest.length - visible.length} more</button> : null}
  </>;
}

function NextStep({ step }: { step: ReturnNextStep }) {
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

/** The slim line at the top of a project conversation. Nothing is shown when nothing changed. */
export function SinceYouLeftLine({ projectId, conversationId }: { projectId: string; conversationId?: string }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const { summary, keep, keepForLater } = useReturn({ type: 'project', id: projectId }, conversationId ? { type: 'conversation', id: conversationId } : undefined);
  if (!summary || !summary.point.savedAt || !summary.items.length) return null;
  return (
    <section className="since" aria-label="Since you left">
      <div className="since__in">
        <button type="button" className="since__btn" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          <span className={`since__dot${summary.needsYou ? ' since__dot--need' : ''}`} aria-hidden="true" />
          <span className="since__line">{headline(summary)}</span>
          <Icon name="chevron-down" size={16} className="since__chev" />
        </button>
        <div id={panelId} className={`since__coll${open ? ' is-open' : ''}`} inert={!open}>
          <div className="since__clip">
            {summary.nextStep ? <NextStep step={summary.nextStep} /> : null}
            <Items summary={summary} />
            <Foot summary={summary} keep={keep} onKeep={() => void keepForLater()} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Home: the personal return view across the places the person can see now, grouped by place. */
export function SinceYouLeftHome() {
  const { summary, keep, keepForLater } = useReturn({ type: 'home' });
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
