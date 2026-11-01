import type { KeyboardEvent } from 'react';
import type { Conversation, Material } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellActions } from '../app/shellContext';
import { getMaterialVersion } from '../materials/api';
import { getProject } from '../project/api';
import { useAddToMap } from '../project/addToMap';
import type { useTyping } from '../typing/useTyping';
import { sendsOnEnter } from '../ui';
import { firstLine } from '../work/format';
import { readableError } from './errors';
import type { AssistantAsk } from './useAssistantAsk';
import type { ComposerDrafts } from './useComposerDrafts';
import type { ComposerMenuState } from './useComposerMenu';
import type { ThreadReplies } from './useThreadReplies';
import type { PaneCore } from './paneCore';

interface Options {
  drafts: ComposerDrafts; menu: ComposerMenuState; ask: AssistantAsk; thread: ThreadReplies; typing: ReturnType<typeof useTyping>;
  touch: boolean; rootMessageId: string | null; newestRootAt?: string; scrollToEnd: () => void;
  hideIfDenied: (cause: unknown) => void; closeSources: () => void;
  onPosted?: (conversation: Conversation) => void; onSending?: () => void;
}

// `/task …`, `/decide …`, `/map …` and `/handoff …` act when sent; the words after the command are the title.
const COMMAND_EXAMPLE = { task: 'Order the probes', decide: 'Use the second supplier', map: 'Lockers in the hallway', handoff: 'Calibrate the probes' } as const;

/** What Send does in a pane (#264): a message joins the end at once and the field empties; a command opens its window. */
export function useComposerSend({ project, conversation, writable, aiOff, composerId }: PaneCore, options: Options) {
  const { drafts, menu, ask, thread, typing, touch, rootMessageId, newestRootAt, scrollToEnd, hideIfDenied, closeSources, onPosted, onSending } = options;
  const { asking, publicComposer, draft, captureScope } = drafts;
  const { openDetails, openCreate } = useShellActions();
  const addToMap = useAddToMap(project);
  // The stream has no assistant: `/ai …` there would post the prompt for the whole project.
  const assistantInStream = !aiOff && !conversation && /^\/ai(\s|$)/.test(draft.trimStart());
  async function runCommand(name: keyof typeof COMMAND_EXAMPLE, text: string) {
    // `/map` alone in a thread puts its opening message on the map (CW-1), with that message as the thought's source.
    if (name === 'map' && (text || (conversation && rootMessageId))) {
      const opening = conversation && rootMessageId ? { messageId: rootMessageId, text: conversation.firstMessageBody } : null;
      addToMap({ body: text || opening!.text, ...(opening ? { messageId: opening.messageId } : {}) });
      publicComposer.consumeBody(publicComposer.draft);
      return;
    }
    if (!text) { menu.setCommandHint(`Say what it is after the command, for example /${name} ${COMMAND_EXAMPLE[name]}.`); document.getElementById(composerId)?.focus(); return; }
    // Consume that exact stored revision under its original key. Changing panes does not leave a
    // successful command ready to send again; words typed later or in another conversation stay.
    const submitted = publicComposer.draft;
    const consume = () => publicComposer.consumeBody(submitted);
    // Typed in a thread, the words are about that thread (#694): its opening message is the source, so the thread shows what came of it.
    const fromThread = conversation && rootMessageId ? { messageId: rootMessageId, text: conversation.firstMessageBody } : null;
    if (name === 'decide') { openDetails({ kind: 'propose-decision', projectId: project.id, title: text, ...(fromThread ? { source: fromThread } : {}) }); consume(); return; }
    // A task, or a hand-off (a task for an agent whose owner the window asks for), opens the one Create window with the words as its title.
    // The composer keeps its words until the task exists: closing the window loses nothing (and a newer draft is never consumed).
    openCreate({ kind: 'task', projectId: project.id, title: firstLine(text), onCreated: consume,
      ...(fromThread ? { sources: [{ ref: { type: 'message' as const, id: fromThread.messageId }, label: firstLine(fromThread.text) }] } : {}) });
  }
  async function send() {
    typing.stop();
    if (asking) { await ask.sendToAssistant(); return; }
    // F-029 (#614): `/ai` and `/handoff` in a workspace whose AI is off are not messages for the people here: the words stay in the field.
    if (aiOff && writable && /^\/(ai|handoff)(\s|$)/.test(draft.trim())) { menu.setCommandHint('AI is off in this workspace. Remove the command to send these words as a message.'); return; }
    const command = writable ? /^\/(task|decide|map|handoff)(?:\s+([\s\S]*))?$/.exec(draft.trim()) : null;
    if (command) { await runCommand(command[1] as keyof typeof COMMAND_EXAMPLE, (command[2] ?? '').trim()); return; }
    // A private helper prompt is never published as a root (UI116-3); it stays in the private draft.
    if (!writable || assistantInStream) return;
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
  /** "Discuss this version": the saved source joins the draft as its reference (#36). */
  async function cite(material: Material) {
    thread.setReadFailure(null);
    try {
      const snapshot = await getMaterialVersion(material.materialId, material.version);
      const selected = { title: snapshot.title, materialId: material.materialId, version: snapshot.version };
      publicComposer.setReference(selected); closeSources();
      document.getElementById(composerId)?.focus();
    } catch (cause) { hideIfDenied(cause); thread.setReadFailure({ message: readableError(cause), retry: () => void cite(material) }); }
  }
  return { send, onKey, cite, assistantInStream };
}
export type ComposerSend = ReturnType<typeof useComposerSend>;
