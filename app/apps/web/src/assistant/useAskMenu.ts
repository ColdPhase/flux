import { useState, type KeyboardEvent } from 'react';
import { composerOptions, composerTrigger, type ComposerOption, type SlashId } from '../app/ComposerMenu';

/**
 * The `/` menu of a composer that has only some of the slash commands: a task's has `/ai` and, under it, the place's suggestions (#1224), a direct
 * message's `/file` and `/ai` (#1424), the two that apply there. The caret decides whether it shows; Enter or Tab picks, the arrows move, Escape closes
 * it, and the field keeps focus throughout.
 */
export function useAskMenu({ fieldId, draft, enabled, suggestions, commands = ['ai'], onAsk, onDraft }: {
  fieldId: string; draft: string; enabled: boolean; suggestions: readonly string[];
  /** The commands this place has, in the menu's order. */
  commands?: readonly SlashId[];
  /** A suggestion was chosen: the "/" is gone from the field and these words are asked. */
  onAsk: (text: string) => void;
  /** The draft as it is now: the "/" that was typed is replaced by `/ai ` or taken out, the words around it stay. */
  onDraft: (value: string) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const trigger = enabled ? composerTrigger(draft, caret) : null;
  const options = trigger?.char === '/' ? composerOptions(trigger, { people: null, meId: '', suggestions, only: commands }) : [];
  const open = options.length > 0 && closedAt !== draft;
  const active = Math.min(index, Math.max(0, options.length - 1));
  /** The field changed: the caret is where the person typed. */
  function change(position: number) { setCaret(position); setIndex(0); setClosedAt(null); }
  function pick(option: ComposerOption) {
    if (!trigger) return;
    // What is around the "/" stays, as in the other composers' menu: words written before the caret or after it are not lost.
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(caret);
    if (option.ask) { onDraft(before + after); setCaret(before.length); onAsk(option.ask); return; }
    // /file opens the paperclip's picker and leaves the draft as it was, as in a space.
    if (option.slash === 'file') {
      onDraft(before + after); setCaret(before.length);
      document.getElementById(fieldId)?.closest('.composer')?.querySelector<HTMLButtonElement>('.composer__attach')?.click();
      return;
    }
    const next = before + option.insert + after;
    const position = before.length + option.insert.length;
    onDraft(next);
    setCaret(position);
    requestAnimationFrame(() => {
      const field = document.getElementById(fieldId);
      if (field instanceof HTMLTextAreaElement) { field.focus(); if (field.value === next) field.setSelectionRange(position, position); }
    });
  }
  /** Arrow keys, Enter, Tab and Escape while the menu is open; true when the key was the menu's. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => (Math.min(current, options.length - 1) + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); pick(options[active]!); return true; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosedAt(draft); return true; }
    return false;
  }
  return { options, open, active, setCaret, setIndex, change, pick, onKeyDown };
}
