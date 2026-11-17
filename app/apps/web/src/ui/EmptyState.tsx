import type { ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { type KreskaExpression } from './Kreska';
import { Mascot } from './Moments';
import { useSmallMoments } from './smallMoments';

export interface EmptyStateProps {
  icon?: IconName;
  /** A small moment (empty Inbox, no results): the big Kreska with this expression instead of the icon, unless Appearance turned moments off. */
  mascot?: KreskaExpression;
  title: string;
  children?: ReactNode;
  /** Optional next step, usually one quiet or primary Button. */
  action?: ReactNode;
  /** Heading level inside the surrounding page outline. */
  level?: 2 | 3;
  /** The heading, for a page that moves the focus to it when its list empties (the Inbox). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** A quiet line under the action (the Inbox's "1 for later"). */
  after?: ReactNode;
}

/**
 * An honest "nothing here yet": says what will appear here and why it is empty. The one empty state of the app (visual review 2026-11-17,
 * core 9): centred, Kreska or an icon tile, a title, one line and an action, on every screen and device.
 */
export function EmptyState({ icon = 'inbox', title, children, action, level = 2, mascot, headingRef, after }: EmptyStateProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const face = useSmallMoments() && mascot;
  return (
    <div className={`ui-empty${face ? ' ui-empty--mascot' : ''}`}>
      {face ? <span className="ui-empty__mascot"><Mascot expression={mascot} size={80} /></span>
        : <span className="ui-empty__icon" aria-hidden="true"><Icon name={icon} size={18} /></span>}
      <Heading ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="ui-empty__title">{title}</Heading>
      {children ? <div className="ui-empty__body">{children}</div> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
      {after}
    </div>
  );
}
