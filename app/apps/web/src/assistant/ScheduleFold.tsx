import { useState, type ReactNode } from 'react';
import { Icon, Kreska } from '../ui';

/**
 * Several runs of one schedule in a row, with no person's message between them, as one line (F-027 AST-7 "Output", S8):
 * "Ada's assistant · Hourly tidy · 6 changes today". Opening it shows each run's own message. The folded ones stay in the
 * page, hidden, so a link to one can still find and open it.
 */
export function ScheduleFold({ id, assistant, title, changes, today, runs, children }: {
  id: string; assistant: string; title: string; changes: number; today: boolean; runs: number; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const listId = `${id}-list`;
  const count = changes ? `${changes} change${changes === 1 ? '' : 's'}${today ? ' today' : ''}` : `${runs} updates${today ? ' today' : ''}`;
  return (
    <li className="convo-fold" id={id} data-schedule-fold>
      <button type="button" className="convo-fold__b" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        <span className="convo-fold__faces" aria-hidden="true"><Kreska size={20} /></span>
        <span className="convo-fold__t"><b>{assistant}</b><span className="convo-fold__s"> · {title} · {count}</span></span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      <ol id={listId} className="convo-fold__list" hidden={!open}>{children}</ol>
    </li>
  );
}
