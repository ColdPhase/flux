import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface ErrorStateProps {
  title: string;
  children?: ReactNode;
  /** Recovery actions, e.g. Retry and a way back. */
  actions?: ReactNode;
  /** Technical detail for people who report the problem; shown muted in monospace. */
  detail?: string;
  level?: 1 | 2;
}

/** A calm failure: what happened, what is kept, and what the person can do next. */
export function ErrorState({ title, children, actions, detail, level = 2 }: ErrorStateProps) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="ui-error" role="alert">
      <span className="ui-error__icon" aria-hidden="true"><Icon name="alert" size={18} /></span>
      <Heading className="ui-error__title">{title}</Heading>
      {children ? <div className="ui-error__body">{children}</div> : null}
      {actions ? <div className="ui-error__actions">{actions}</div> : null}
      {detail ? <p className="ui-error__detail">{detail}</p> : null}
    </div>
  );
}
