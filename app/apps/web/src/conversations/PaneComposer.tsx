import { plainMessageText } from '@flux/contracts';
import { AskBar } from '../assistant/ConversationParts';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { ComposerMenu } from '../app/ComposerMenu';
import { Button } from '../ui';
import { ComposerBox } from '../composer/ComposerBox';
import { ComposerFiles } from '../composer/Files';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { TypingNotice } from '../typing/TypingNotice';
import type { useTyping } from '../typing/useTyping';
import type { PaneCore } from './paneCore';
import type { AssistantAsk } from './useAssistantAsk';
import type { useAskBar } from './useAskBar';
import type { ComposerDrafts } from './useComposerDrafts';
import type { ComposerMenuState } from './useComposerMenu';
import type { ComposerSend } from './useComposerSend';

interface Props {
  core: PaneCore; drafts: ComposerDrafts; menu: ComposerMenuState; actions: ComposerSend; ask: AssistantAsk; askBar: ReturnType<typeof useAskBar>;
  assistant: ReturnType<typeof useConversationAssistant>; typing: ReturnType<typeof useTyping>;
  readFailure: { message: string; retry: () => void } | null;
}

/** The hint of S5, and what it shortens to on a field too narrow for it (a small phone, large text), so it never wraps (#1374). */
const MESSAGE_HINTS = ['Message · @ mention · / actions', 'Message · @ · /', 'Message'] as const;

/** The pane's composer (F-026 S5): the ask bar or who reads this, the field with its "@" and "/" menu, and its notices. */
export function PaneComposer({ core, drafts, menu, actions, ask, askBar, typing, readFailure }: Props) {
  const { project, conversation, composerId } = core;
  const { asking, publicComposer, draft, busy, askBusy } = drafts;
  const { menuOpen, options, activeIndex } = menu;
  const title = conversation ? plainMessageText(conversation.firstMessageBody).split('\n')[0] || 'Conversation' : project.name;
  return <div className="composer project-convo__composer"><div className="composer__in">
    <ConnectionLine />
    {/* A space's conversation and its threads are read by the space's people, the default, so no audience is said (#871). */}
    {asking ? <AskBar id="project-ask" state={askBar.state} error={askBar.error} onExit={ask.exitAsk} onAction={askBar.onAction} />
      : conversation ? <div className="project-convo__to"><p className="project-convo__current-thread" title={title}>Replying to · {title}</p></div> : null}
    {!asking ? <ComposerFiles state={publicComposer} attach="none" /> : null}
    {/* A tap on the card's empty space goes to the field, as in a messenger (#266 PF-3). */}
    <ComposerBox id={composerId} label={asking ? 'Ask your assistant' : conversation ? 'Reply' : 'Write a message'} value={draft}
      placeholder={asking ? 'Ask your assistant…' : conversation ? 'Reply in thread…' : MESSAGE_HINTS}
      onChange={(value, position) => menu.changeDraft(value, position)} onSelect={menu.setCaret} onBlur={typing.stop} onKeyDown={actions.onKey} disabled={busy || askBusy}
      fieldProps={{ 'aria-describedby': asking ? 'project-ask' : undefined, 'aria-controls': menuOpen ? `${composerId}-menu` : undefined,
        'aria-activedescendant': menuOpen ? `${composerId}-menu-${options[activeIndex]!.id}` : undefined }}
      attach={asking ? null : publicComposer}
      sendLabel={asking ? 'Send to your assistant' : conversation ? 'Send reply' : 'Send message'}
      sendDisabled={!drafts.composer.canSend || busy || askBusy || (asking && askBar.state.kind !== 'ready')} onSend={() => void actions.send()}
      menu={<ComposerMenu open={menuOpen} id={`${composerId}-menu`} options={options} active={activeIndex} trigger={menu.trigger?.char ?? '@'} onPick={menu.pick} onHover={menu.setMenuIndex} />} />
    {conversation ? <TypingNotice {...typing} /> : null}
    <SendAnnouncer pending={publicComposer.pending} />
    {menu.commandHint ? <p className="project-convo__hint" role="status">{menu.commandHint}</p> : null}
    {readFailure ? <p className="project-convo__error" role="alert">{readFailure.message} <Button variant="link" size="sm" onClick={readFailure.retry}>Retry read</Button></p> : null}
  </div></div>;
}
