import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  /** Optional next step, usually one quiet or primary Button. */
  action?: ReactNode;
  /** Heading level inside the surrounding page outline. */
  level?: 2 | 3;
}

/** An honest "nothing here yet": says what will appear here and why it is empty. */
export function EmptyState({ icon = 'inbox', title, children, action, level = 2 }: EmptyStateProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="ui-empty">
      <span className="ui-empty__icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <Heading className="ui-empty__title">{title}</Heading>
      {children ? <div className="ui-empty__body">{children}</div> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
