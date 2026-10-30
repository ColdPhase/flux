import type { Material } from '@flux/contracts';
import { AskBar } from '../assistant/ConversationParts';
import { assistantUses, AssistantSuggestions } from '../assistant/MeetAssistant';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { ComposerMenu } from '../app/ComposerMenu';
import { ComposerBox } from '../composer/ComposerBox';
import { ComposerFiles } from '../composer/Files';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { MaterialTray } from '../materials/MaterialTray';
import type { ProjectMaterials } from '../materials/useProjectMaterials';
import { TypingNotice } from '../typing/TypingNotice';
import type { useTyping } from '../typing/useTyping';
import { Button, Icon } from '../ui';
import type { PaneCore } from './paneCore';
import type { AssistantAsk } from './useAssistantAsk';
import type { useAskBar } from './useAskBar';
import type { ComposerDrafts } from './useComposerDrafts';
import type { ComposerMenuState } from './useComposerMenu';
import type { ComposerSend } from './useComposerSend';

interface Props {
  core: PaneCore; drafts: ComposerDrafts; menu: ComposerMenuState; actions: ComposerSend; ask: AssistantAsk; askBar: ReturnType<typeof useAskBar>;
  assistant: ReturnType<typeof useConversationAssistant>; materials: ProjectMaterials; typing: ReturnType<typeof useTyping>;
  readFailure: { message: string; retry: () => void } | null; author: (id: string) => string;
}

/** The pane's composer (F-026 S5): sources, the ask bar or who reads this, the field with its "@" and "/" menu, and its notices. */
export function PaneComposer({ core, drafts, menu, actions, ask, askBar, assistant, materials, typing, readFailure, author }: Props) {
  const { me, project, conversation, writable, aiOff, composerId, audience } = core;
  const { asking, publicComposer, draft, preparedReply, assistantDraftLabel, busy, askBusy } = drafts;
  const { menuOpen, options, activeIndex } = menu;
  const trayOpen = materials.trayOpen;
  const title = conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  const sourcesId = `${conversation ? 'thread' : 'project'}-sources`;
  return <div className="composer project-convo__composer"><div className="composer__in" data-shift={conversation ? undefined : true}>
    {trayOpen ? <MaterialTray materials={materials} projectName={project.name} writable={writable} inThread={!!conversation} composerId={composerId} author={author} onCite={(material: Material) => void actions.cite(material)} /> : null}
    {writable ? <ConnectionLine /> : null}
    {/* On the phone "Replying to" and the audience share one line, keeping the composer compact. */}
    {conversation && writable && !asking && menu.assistantEntry?.mode === 'ask' && assistant.member === true && assistantUses(me.user.id) < 3 ? <AssistantSuggestions onPick={ask.askSuggestion} /> : null}
    {asking && writable ? <AskBar id="project-ask" state={askBar.state} error={askBar.error} errorAction={askBar.grantAction} onExit={ask.exitAsk} onAction={askBar.onAction} /> : <div className="project-convo__to">
      {conversation ? <p className="project-convo__current-thread" title={title}>{writable ? 'Replying to' : 'Conversation'} · {title}</p> : null}
      <p className="composer__audience"><Icon name="lock" size={13} /><span>{audience}</span><span className="composer__where"> · saved to {project.name}</span></p>
    </div>}
    {writable && !asking ? <ComposerFiles state={publicComposer} attach="none" /> : null}
    {/* A tap on the card's empty space goes to the field, as in a messenger (#266 PF-3). */}
    {writable && assistantDraftLabel ? <p className="assistant-answer__asked">Drafted by your assistant</p> : null}
    {writable && !aiOff && preparedReply && preparedReply.ownerId === me.user.id && preparedReply.conversationId === conversation?.id && !assistantDraftLabel ? <details className="project-convo__hint"><summary>Review the reply drafted by your assistant</summary><p style={{ whiteSpace: 'pre-wrap' }}>{preparedReply.body}</p><Button variant="secondary" onClick={() => publicComposer.setBody(preparedReply.body)}>Use this draft</Button></details> : null}
    {writable ? <ComposerBox id={composerId} label={asking ? 'Ask your assistant' : conversation ? 'Reply' : 'Write a message'} value={draft}
      placeholder={asking ? 'Ask your assistant…' : conversation ? 'Reply in thread…' : 'Message · @ mention · / actions'}
      onChange={(value, position) => menu.changeDraft(value, position)} onSelect={menu.setCaret} onBlur={typing.stop} onKeyDown={actions.onKey} disabled={busy || askBusy}
      fieldProps={{ 'aria-describedby': asking ? 'project-ask' : actions.assistantInStream ? `${composerId}-ai-hint` : undefined, 'aria-controls': menuOpen ? `${composerId}-menu` : undefined,
        'aria-activedescendant': menuOpen ? `${composerId}-menu-${options[activeIndex]!.id}` : undefined }}
      attach={asking ? null : publicComposer}
      sendLabel={asking ? 'Send to your assistant' : conversation ? 'Send reply' : 'Send message'}
      sendDisabled={!drafts.composer.canSend || busy || askBusy || actions.assistantInStream || (asking && askBar.state.kind !== 'ready')} onSend={() => void actions.send()}
      menu={<ComposerMenu open={menuOpen} id={`${composerId}-menu`} options={options} active={activeIndex} trigger={menu.trigger?.char ?? '@'} aiOff={aiOff} onPick={menu.pick} onHover={menu.setMenuIndex} />} />
      : <div className="composer__box"><button type="button" className="composer__ask project-convo__sources-btn" aria-expanded={trayOpen} aria-controls={trayOpen ? sourcesId : undefined} aria-label={`Sources${materials.total ? `, ${materials.total} saved` : ''}`} data-tip="Saved sources to read" data-tip-align="start" onClick={() => { if (trayOpen) materials.setSourcesOpen(false); else materials.setSourcesOpen(true); }}><Icon name="doc" /><span className="project-convo__sources-t" aria-hidden="true">Sources</span>{materials.total ? <span className="project-convo__sources-n" aria-hidden="true">{materials.total > 99 ? '99+' : materials.total}</span> : null}</button><p className="project-convo__read-only">Read-only · <span>You have read access to this project.</span></p></div>}
    {conversation ? <TypingNotice {...typing} /> : null}
    {writable ? <SendAnnouncer pending={publicComposer.pending} /> : null}
    {writable && actions.assistantInStream ? <p id={`${composerId}-ai-hint`} className="project-convo__hint" role="status">Your assistant answers inside a conversation. Open one and type /ai there. This text is not posted.</p> : null}
    {menu.commandHint ? <p className="project-convo__hint" role="status">{menu.commandHint}</p> : null}
    {readFailure ? <p className="project-convo__error" role="alert">{readFailure.message} <button type="button" onClick={readFailure.retry}>Retry read</button></p> : null}
  </div></div>;
}
