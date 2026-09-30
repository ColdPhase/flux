import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { ReturnDigest, ReturnPeriod, ReturnScope, ReturnSummary } from '@flux/contracts';
import { Button, Icon, Spinner, useSidePanelMode } from '../ui';
import { useShellData } from '../app/data';
import { getRecap, saveReturnPoint, sourceHref } from './api';
import { Item, NextStep } from './SinceYouLeft';
import './what-matters.css';

// "What matters" (#133): the private recap of one project in the Details panel. It extends the
// #106 return view: whole project or only what concerns you, a chosen period, and a stable
// snapshot while you read. "Summarize" adds whole-message quotes per conversation and the
// recorded results, built on the server without a model. "I have the context" moves your return
// point to what you saw; closing the panel without it keeps the point. Nothing here is posted,
// notified or shared, and the chat's read state is separate.

const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const PERIODS: { id: ReturnPeriod; label: string }[] = [
  { id: 'last-visit', label: 'Since my last visit' }, { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' },
];
/** How often an open panel looks for newer changes; it only says so and never reshuffles the list. */
const NEWER_EVERY_MS = 30_000;

/**
 * What a person was looking at in a project during this visit, so a source opened on a phone
 * (which closes the sheet) returns to the same snapshot, choices and scroll. Memory only: never
 * stored in the browser, dropped with "I have the context", and every reopen asks the server
 * again for that snapshot, so access that changed in between applies.
 */
interface Kept { scope: ReturnScope; period: ReturnPeriod; mark: string | null; digest: boolean; scroll: number }
const kept = new Map<string, Kept>();
const keptKey = (userId: string, projectId: string) => `${userId}:${projectId}`;

type Load = { key: string; summary: ReturnSummary } | { key: string; error: true } | null;

function since(summary: ReturnSummary) {
  if (!summary.since) return 'From the beginning of the project';
  const label = PERIODS.find((period) => period.id === summary.period)?.label;
  return summary.period === 'last-visit' ? `Since ${dayTime.format(new Date(summary.since))}` : label!;
}

function Digest({ digest }: { digest: ReturnDigest }) {
  if (!digest.conversations.length && !digest.results.length)
    return <p className="wm-note">No messages or results in this period to quote.</p>;
  return (
    <div className="wm-digest">
      {digest.results.length ? (
        <section aria-labelledby="wm-results">
          <h4 id="wm-results" className="wm-h4">Results</h4>
          <ul className="wm-quotes">{digest.results.map((result) => (
            <li key={result.id}><Link className="wm-quote" to={sourceHref({ type: 'result', id: result.id, projectId: result.projectId })}>
              <span className="wm-quote__who">{result.author} · {result.finding === 'negative' ? 'did not work out' : 'worked'}</span>
              <span className="wm-quote__text">{result.title}</span>
              <Icon name="chevron-right" size={14} className="wm-quote__go" />
            </Link></li>
          ))}</ul>
        </section>
      ) : null}
      {digest.conversations.map((talk) => (
        <section key={talk.conversationId} aria-label={`In “${talk.opening}”`}>
          <h4 className="wm-h4">In “{talk.opening}”</h4>
          <ul className="wm-quotes">{talk.quotes.map((quote) => (
            <li key={quote.messageId}><Link className="wm-quote" to={sourceHref({ type: 'message', projectId: talk.projectId, conversationId: talk.conversationId, messageId: quote.messageId })}>
              <span className="wm-quote__who">{quote.author} <time dateTime={quote.at}>{time.format(new Date(quote.at))}</time></span>
              <span className="wm-quote__text">{quote.excerpt}</span>
              <Icon name="chevron-right" size={14} className="wm-quote__go" />
            </Link></li>
          ))}</ul>
          {talk.more ? <p className="wm-note">{talk.more} earlier {talk.more === 1 ? 'message' : 'messages'} in this period. Open the conversation for all of them.</p> : null}
        </section>
      ))}
    </div>
  );
}

/** The panel body. `onDone` closes the panel (after "I have the context", or for a source on a phone). */
export function WhatMatters({ projectId, projectName, onDone }: { projectId: string; projectName: string; onDone: () => void }) {
  const { me } = useShellData();
  const mode = useSidePanelMode();
  const store = keptKey(me.user.id, projectId);
  const initial = kept.get(store);
  const [scope, setScope] = useState<ReturnScope>(initial?.scope ?? 'all');
  const [period, setPeriod] = useState<ReturnPeriod>(initial?.period ?? 'last-visit');
  const [digestOn, setDigestOn] = useState(initial?.digest ?? false);
  const [load, setLoad] = useState<Load>(null);
  const [choosing, setChoosing] = useState(false);
  const [done, setDone] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef(initial?.scroll ?? 0);
  // The snapshot being read: fixed by the first answer; scope, period and digest keep it.
  const snapshot = useRef<string | null>(initial?.mark ?? null);
  const periodId = useId();
  // One request per account, project, scope, period and digest; a late answer for any other
  // combination is dropped, so a quick scope change never shows the previous scope's items.
  const requestKey = `${store}|${scope}|${period}|${digestOn ? 'digest' : ''}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    getRecap({ projectId, scope, period, until: snapshot.current, digest: digestOn }, controller.signal)
      .then((summary) => {
        if (controller.signal.aborted) return;
        snapshot.current ??= summary.mark;
        setLoad({ key: requestKey, summary });
      })
      .catch(() => { if (!controller.signal.aborted) setLoad({ key: requestKey, error: true }); });
    return () => controller.abort();
  }, [requestKey, projectId, scope, period, digestOn]);

  // While a new scope or period loads, the previous answer of this project stays visible but inert.
  const shown = load && 'summary' in load && load.key.startsWith(`${store}|`) ? load.summary : null;
  const loading = !load || load.key !== requestKey;
  const failed = !!load && load.key === requestKey && 'error' in load;
  const mark = shown?.mark ?? null;

  useEffect(() => {
    kept.set(store, { scope, period, mark, digest: digestOn, scroll: scroller.current?.scrollTop ?? restoreScroll.current });
  }, [store, scope, period, mark, digestOn]);
  const onScroll = () => { const entry = kept.get(store); if (entry && scroller.current) entry.scroll = scroller.current.scrollTop; };
  useLayoutEffect(() => {
    if (!shown || !scroller.current || !restoreScroll.current) return;
    scroller.current.scrollTop = restoreScroll.current;
    restoreScroll.current = 0;
  }, [shown]);

  // Newer changes of this project, in this scope and period, are announced, never merged into
  // the list being read. A poll belongs to one context: a change of account, project, scope,
  // period or snapshot aborts it, drops its late answer and clears an announcement it made.
  const signature = shown ? shown.items.map((item) => `${item.id}@${item.at}`).join('|') : null;
  const pollKey = `${requestKey}|${signature ?? ''}`;
  const [newerFor, setNewerFor] = useState<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    let controller: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      getRecap({ projectId, scope, period, until: null, digest: false }, signal)
        .then((latest) => {
          if (signal.aborted) return;
          if (latest.items.map((item) => `${item.id}@${item.at}`).join('|') !== signature) setNewerFor(pollKey);
        }).catch(() => undefined);
    }, NEWER_EVERY_MS);
    return () => { window.clearInterval(timer); controller?.abort(); };
  }, [projectId, scope, period, signature, pollKey]);
  const newer = newerFor === pollKey;

  const refresh = useCallback(() => { setNewerFor(null); snapshot.current = null; setAttempt((value) => value + 1); }, []);
  const haveContext = async () => {
    if (!shown) return;
    setDone('busy');
    try {
      await saveReturnPoint({ type: 'project', id: projectId }, shown.mark);
      kept.delete(store);
      setDone('idle');
      onDone();
    } catch { setDone('failed'); }
  };

  const needs = shown?.items.filter((item) => item.needsYou && item.id !== shown.nextStep?.item) ?? [];
  const changes = shown?.items.filter((item) => !item.needsYou && item.id !== shown.nextStep?.item) ?? [];
  const empty = !!shown && !shown.items.length && !shown.nextStep;

  // An overlaid panel or sheet gives way to the source a link opens, even in the same conversation
  // (only the #message changes). Work, decisions and results link to their project and open in
  // Details instead, so those links keep the panel.
  const onLink = (event: MouseEvent) => {
    const href = (event.target as Element).closest('a[href]')?.getAttribute('href');
    if (mode === 'docked' || !href || /^\/projects\/[^/?#]+$/.test(href)) return;
    onDone();
  };

  return (
    <div className="wm" onClick={onLink}>
      <div className="wm__scroll" ref={scroller} onScroll={onScroll}>
        <div className="wm__head">
          <div className="wm-seg" role="radiogroup" aria-label="Whose changes">
            {(['all', 'mine'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={scope === value} className="wm-seg__b" onClick={() => setScope(value)}>
                {value === 'all' ? 'Whole project' : 'Relevant to me'}
              </button>
            ))}
          </div>
          <div className="wm-period">
            <span>{shown ? since(shown) : 'Loading…'}</span>
            <button type="button" className="wm-link" aria-expanded={choosing} aria-controls={periodId} onClick={() => setChoosing(!choosing)}>Change</button>
          </div>
          {choosing ? (
            <div className="wm-periods" id={periodId} role="radiogroup" aria-label="Period">
              {PERIODS.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={period === option.id} className="wm-periods__b"
                  onClick={() => { setPeriod(option.id); setChoosing(false); }}>{option.label}</button>
              ))}
            </div>
          ) : null}
          <details className="wm-private">
            <summary><Icon name="lock" size={12} />Only you see this</summary>
            <p>Built from what you can open in {projectName} now. Nothing is posted or sent, and the chat stays as read or unread as it was. “I have the context” starts your next visit after what you saw.</p>
          </details>
        </div>

        {newer ? (
          <p className="wm-newer" role="status">Newer changes arrived. This list stays as it was while you read. <button type="button" className="wm-link" onClick={refresh}>Show them</button></p>
        ) : null}

        {failed ? (
          <p className="wm-error" role="alert"><Icon name="alert" size={14} />Could not load what matters. <button type="button" className="wm-link" onClick={() => setAttempt((value) => value + 1)}>Try again</button></p>
        ) : null}

        {!shown && loading ? <p className="wm-loading" role="status"><Spinner /> Loading…</p> : null}

        {shown ? (
          <div className={`wm__body${loading ? ' is-loading' : ''}`} aria-busy={loading || undefined} inert={loading || undefined}>
            {empty ? (
              <div className="wm-empty">
                <p>{scope === 'mine' ? 'Nothing that concerns you' : 'Nothing new'} {shown.since ? (shown.period === 'last-visit' ? 'since your last visit' : 'in this period') : 'yet'}.</p>
                {period !== '7d' ? <Button variant="quiet" onClick={() => setPeriod('7d')}>Look at the last 7 days</Button> : null}
              </div>
            ) : null}
            {shown.nextStep ? <NextStep step={shown.nextStep} /> : null}
            {needs.length ? (
              <section className="wm-sec" aria-labelledby="wm-needs">
                <h3 id="wm-needs" className="wm-h3">Needs you</h3>
                <ul className="since__list">{needs.map((item) => <Item key={item.id} item={item} />)}</ul>
              </section>
            ) : null}
            {changes.length ? (
              <section className="wm-sec" aria-labelledby="wm-changes">
                <div className="wm-sec__head">
                  <h3 id="wm-changes" className="wm-h3">Changes</h3>
                  {!digestOn ? (
                    <Button variant="secondary" icon="leaf" className="wm-summarize" onClick={() => setDigestOn(true)}>Summarize</Button>
                  ) : null}
                </div>
                <ul className="since__list">{changes.slice(0, 20).map((item) => <Item key={item.id} item={item} />)}</ul>
                {shown.more || changes.length > 20 ? <p className="wm-note">More happened than fits here. Open a conversation or the Tasks tab for everything.</p> : null}
              </section>
            ) : null}
            {digestOn ? (
              <section className="wm-sec" aria-labelledby="wm-digest">
                <div className="wm-sec__head">
                  <h3 id="wm-digest" className="wm-h3">In the conversations</h3>
                  <button type="button" className="wm-link" onClick={() => setDigestOn(false)}>Hide</button>
                </div>
                <p className="wm-note">Quotes of whole messages{shown.digest ? `, from ${shown.digest.messages} ${shown.digest.messages === 1 ? 'message' : 'messages'}` : ''}. No AI.</p>
                {shown.digest ? <Digest digest={shown.digest} /> : <p className="wm-loading" role="status"><Spinner /> Gathering quotes…</p>}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="wm__foot">
        <Button variant="primary" size="lg" icon="check" block busy={done === 'busy'} disabled={!shown} onClick={() => void haveContext()}>I have the context</Button>
        <p className="wm-foot__note" role={done === 'failed' ? 'alert' : undefined}>
          {done === 'failed' ? 'Could not save. Try again; nothing was changed.' : 'Only this project. Nothing is posted and the chat is not marked read.'}
        </p>
      </div>
    </div>
  );
}
