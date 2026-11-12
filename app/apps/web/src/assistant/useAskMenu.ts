import { useState, type KeyboardEvent } from 'react';
import { composerOptions, composerTrigger, type ComposerOption } from '../app/ComposerMenu';

/**
 * The `/` menu of a composer that has no other slash command (a task's, #1224): `/ai` and, under it, the place's suggestions. The caret decides
 * whether it shows; Enter or Tab picks, the arrows move, Escape closes it, and the field keeps focus throughout.
 */
export function useAskMenu({ fieldId, draft, enabled, suggestions, onAsk, onDraft }: {
  fieldId: string; draft: string; enabled: boolean; suggestions: readonly string[];
  /** A suggestion was chosen: the "/" is gone from the field and these words are asked. */
  onAsk: (text: string) => void;
  /** `/ai ` replaces the "/" that was typed. */
  onDraft: (value: string) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const trigger = enabled ? composerTrigger(draft, caret) : null;
  const options = trigger?.char === '/' ? composerOptions(trigger, { people: null, meId: '', suggestions, only: ['ai'] }) : [];
  const open = options.length > 0 && closedAt !== draft;
  const active = Math.min(index, Math.max(0, options.length - 1));
  /** The field changed: the caret is where the person typed. */
  function change(position: number) { setCaret(position); setIndex(0); setClosedAt(null); }
  function pick(option: ComposerOption) {
    if (option.ask) { onDraft(''); onAsk(option.ask); return; }
    onDraft('/ai ');
    setCaret(4);
    requestAnimationFrame(() => {
      const field = document.getElementById(fieldId);
      if (field instanceof HTMLTextAreaElement) { field.focus(); field.setSelectionRange(4, 4); }
    });
  }
  /** Arrow keys, Enter, Tab and Escape while the menu is open; true when the key was the menu's. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); pick(options[active]!); return true; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosedAt(draft); return true; }
    return false;
  }
  return { options, open, active, setCaret, setIndex, change, pick, onKeyDown };
}
