import type { MouseEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ReturnItem, ReturnNextStep, ReturnSource } from '@flux/contracts';
import { Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { sourceHref } from './api';
import './since.css';

// The rows of "Since you left" (#106) and "What matters" (#133, WhatMatters.tsx): a short list in human
// language, every item opening its source, with no guilt (nothing to clear, no streaks). Home's
// "Continue where you left off" card (#342) uses the same next step and source link.

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const shortWhen = (iso: string) => (sameDay(iso) ? time.format(new Date(iso)) : day.format(new Date(iso)));

/** Opens a source: a link for messages, materials and sketches; Details on the project for work objects. */
export function SourceLink({ source, className, children, label, onFollow }: { source: ReturnSource; className: string; children: ReactNode; label?: string; onFollow?: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { openDetails } = useShellActions();
  const href = sourceHref(source);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) onFollow?.();
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
