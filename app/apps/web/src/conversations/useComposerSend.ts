import type { KeyboardEvent } from 'react';
import { plainMessageText, type Conversation } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellActions } from '../app/shellContext';
import { getProject } from '../project/api';
import type { useTyping } from '../typing/useTyping';
import { sendsOnEnter } from '../ui';
import { firstLine } from '../work/format';
import type { AssistantAsk } from './useAssistantAsk';
import type { ComposerDrafts } from './useComposerDrafts';
import type { ComposerMenuState } from './useComposerMenu';
import type { ThreadReplies } from './useThreadReplies';
import type { PaneCore } from './paneCore';

interface Options {
  drafts: ComposerDrafts; menu: ComposerMenuState; ask: AssistantAsk; thread: ThreadReplies; typing: ReturnType<typeof useTyping>;
  touch: boolean; rootMessageId: string | null; newestRootAt?: string; scrollToEnd: () => void;
  hideIfDenied: (cause: unknown) => void;
  onPosted?: (conversation: Conversation) => void; onSending?: () => void;
}

// `/task …` and `/decide …` act when sent; the words after the command are the title. Both open the one Create window.
const COMMAND_EXAMPLE = { task: 'Order the probes', decide: 'Use the second supplier' } as const;

/** What Send does in a pane (#264): a message joins the end at once and the field empties; a command opens its window. */
export function useComposerSend({ project, conversation, writable, aiOff, guest, composerId }: PaneCore, options: Options) {
  const { drafts, menu, ask, thread, typing, touch, rootMessageId, newestRootAt, scrollToEnd, hideIfDenied, onPosted, onSending } = options;
  const { asking, publicComposer, draft, captureScope } = drafts;
  const { openCreate } = useShellActions();
  async function runCommand(name: keyof typeof COMMAND_EXAMPLE, text: string) {
    if (!text) { menu.setCommandHint(`Say what it is after the command, for example /${name} ${COMMAND_EXAMPLE[name]}.`); document.getElementById(composerId)?.focus(); return; }
    // Consume that exact stored revision under its original key. Changing panes does not leave a
    // successful command ready to send again; words typed later or in another conversation stay.
    const submitted = publicComposer.draft;
    const consume = () => publicComposer.consumeBody(submitted);
    // Typed in a thread, the words are about that thread (#694): its opening message is the source, so the thread shows what came of it.
    const fromThread = conversation && rootMessageId ? { messageId: rootMessageId, text: conversation.firstMessageBody } : null;
    // `/task` and `/decide` open the one Create window with the words as its title, the thread's opening message as its source.
    // The composer keeps its words until the task or decision exists: closing the window loses nothing (and a newer draft is never consumed).
    openCreate({ kind: name === 'decide' ? 'decision' : 'task', projectId: project.id, title: firstLine(text), onCreated: consume,
      ...(fromThread ? { sources: [{ ref: { type: 'message' as const, id: fromThread.messageId }, label: firstLine(plainMessageText(fromThread.text)) }] } : {}) });
  }
  async function send() {
    typing.stop();
    if (asking) { await ask.sendToAssistant(); return; }
    // AG-10: `/ai` in a space whose AI is off is not a message for the people here: the words stay in the field.
    if (aiOff && writable && /^\/ai(\s|$)/.test(draft.trim())) { menu.setCommandHint(`${guest ? 'Guests don’t have AI.' : 'AI is off in this space.'} Remove the command to send these words as a message.`); return; }
    const command = writable ? /^\/(task|decide)(?:\s+([\s\S]*))?$/.exec(draft.trim()) : null;
    if (command) { await runCommand(command[1] as keyof typeof COMMAND_EXAMPLE, (command[2] ?? '').trim()); return; }
    // A private helper prompt is never published as a root (UI116-3); it stays in the private draft.
    if (!writable) return;
    // The message joins the end of the stream or thread at once and the field empties (#264); the
    // queue sends it with its command, and a second tap finds nothing to send.
    const outcome = publicComposer.submit(conversation ? thread.messages.at(-1)?.sequence ?? 0 : newestRootAt);
    if (!outcome) return;
    const active = captureScope();
    if (!conversation) onSending?.();
    else requestAnimationFrame(() => { if (active()) scrollToEnd(); });
    const result = await outcome;
    if (!active()) return;
    if (result.status === 'delivered') {
      if (!conversation && result.conversation) onPosted?.(result.conversation);
      void thread.refresh();
    } else if (result.status === 'failed' && result.cause instanceof ApiError && [401, 403, 404].includes(result.cause.status)) {
      // A send's 404 also protects an unavailable file/source. Confirm scope loss through
      // the ordinary project read before hiding the composer needed to recover that draft.
      void getProject(project.id).catch((accessCause: unknown) => { if (active()) hideIfDenied(accessCause); });
    }
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu.menuKey(event)) return;
    if (asking && (event.key === 'Escape' || (event.key === 'Backspace' && !draft))) { event.preventDefault(); event.stopPropagation(); ask.exitAsk(); return; }
    if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); }
  }
  return { send, onKey };
}
export type ComposerSend = ReturnType<typeof useComposerSend>;
