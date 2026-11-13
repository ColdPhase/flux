import { useState } from 'react';
import { assistantSuggestions } from '../assistant/MeetAssistant';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { composerOptions, composerTrigger, type ComposerOption } from '../app/ComposerMenu';
import type { useTyping } from '../typing/useTyping';
import type { AssistantAsk } from './useAssistantAsk';
import type { ComposerDrafts } from './useComposerDrafts';
import type { PaneCore } from './paneCore';

interface Options {
  drafts: ComposerDrafts; assistant: ReturnType<typeof useConversationAssistant>; ask: AssistantAsk; typing: ReturnType<typeof useTyping>;
}

/** "@" and "/" in the composer (F-026 S5): the caret decides which menu shows, if any, and a pick edits the draft. */
export function useComposerMenu({ me, people, writable, aiOff, composerId, conversation }: PaneCore, { drafts, assistant, ask, typing }: Options) {
  const { asking, setAsking, publicComposer, helperComposer, composer, draft } = drafts;
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const [commandHint, setCommandHint] = useState('');
  const trigger = writable && !asking ? composerTrigger(draft, caret) : null;
  // Under `/ai`, the suggestions of this place (#1224): a thread's or the space conversation's, while the assistant is ready. `@` is for people only.
  const suggestions = assistantSuggestions(conversation ? 'thread' : 'space', me.user.id, !aiOff && assistant.status?.state === 'ready');
  const options = trigger ? composerOptions(trigger, { people, meId: me.user.id, aiOff, suggestions }) : [];
  const menuOpen = !!trigger && options.length > 0 && menuClosedAt !== draft;
  const activeIndex = Math.min(menuIndex, Math.max(0, options.length - 1));
  function changeDraft(input: string, position = input.length) {
    setCaret(position); setMenuIndex(0); setMenuClosedAt(null); setCommandHint('');
    typing.input(Boolean(input.trim()) && !asking && !/^\/(ai|task|decide)(\s|$)/.test(input));
    // Private prompts keep their own draft; invoking /ai never overwrites a public task draft.
    if (!aiOff && !asking && writable && /^\/ai(\s|$)/.test(input)) {
      // Typed key by key, "/" and "/a" were the reply's draft a moment ago; they were the command, not words to keep.
      if (/^\/[a-z]{0,1}$/i.test(publicComposer.draft.body)) publicComposer.setBody('');
      helperComposer.setBody(input.replace(/^\/ai\s?/, '')); setAsking(true); ask.setAskFailure(''); return;
    }
    ask.setAskFailure(''); composer.setBody(input);
  }
  // The caret goes after what was inserted, unless the person has already typed on (fast typing).
  const placeCaret = (position: number, value: string) => requestAnimationFrame(() => {
    const field = document.getElementById(composerId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    if (field.value !== value) return;
    field.setSelectionRange(position, position); setCaret(position);
  });
  function pick(option: ComposerOption) {
    if (!trigger) return;
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(caret);
    // A suggestion asks at once, as `/ai` does: the "/" that opened the menu is not words to keep.
    if (option.ask) { changeDraft(before + after, before.length); ask.askSuggestion(option.ask); return; }
    // /file opens what the old button opened, and leaves the draft as it was.
    if (option.slash === 'file') {
      changeDraft(before + after, before.length);
      document.getElementById(composerId)?.closest('.composer')?.querySelector<HTMLButtonElement>('.composer__attach')?.click();
      return;
    }
    changeDraft(before + option.insert + after, before.length + option.insert.length);
    placeCaret(before.length + option.insert.length, before + option.insert + after);
  }
  /** Arrow keys, Enter, Tab and Escape while the menu is open; true when the key was the menu's. */
  function menuKey(event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault: () => void; stopPropagation: () => void }) {
    if (!menuOpen || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMenuIndex((current) => (Math.min(current, options.length - 1) + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); pick(options[activeIndex]!); return true; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuClosedAt(draft); return true; }
    return false;
  }
  return { caret, setCaret, trigger, options, menuOpen, activeIndex, setMenuIndex, commandHint, setCommandHint, changeDraft, pick, menuKey };
}
export type ComposerMenuState = ReturnType<typeof useComposerMenu>;
