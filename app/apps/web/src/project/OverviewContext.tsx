import { useMatches } from 'react-router';
import { plainMessageText, type Conversation, type ConversationRootWindow } from '@flux/contracts';
import { Icon } from '../ui';
import { useShellData } from '../app/data';
import { audienceLine, useProjectShell } from './data';

/** The Conversation tab's loader data: the open thread, if any, and the stream's newest roots (UI116-1). */
export function useOpenConversation(): { conversation: Conversation | null; roots?: ConversationRootWindow } | null {
  const match = useMatches().find((entry) => entry.loaderData && typeof entry.loaderData === 'object' && 'conversation' in entry.loaderData);
  return (match?.loaderData as { conversation: Conversation | null; roots?: ConversationRootWindow } | undefined) ?? null;
}

/**
 * The owning context stays visible when a phone reader scrolls down to sources, in a message's linked objects (#117): the space, the
 * thread when one is open, and who can read them.
 */
export function OverviewContext() {
  const shell = useProjectShell();
  const open = useOpenConversation();
  const { me } = useShellData();
  if (!shell) return null;
  const title = open?.conversation && plainMessageText(open.conversation.firstMessageBody).split('\n')[0];
  return <div className="ov-panel-context" aria-label="Overview context">
    <strong>{shell.project.name}</strong>
    {title ? <span title={title}>{title}</span> : null}
    <small><Icon name={shell.project.visibility === 'workspace' ? 'people' : 'lock'} size={11} />{audienceLine(shell.people, me.user.id)}</small>
  </div>;
}
