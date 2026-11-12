import type { KeyboardEvent } from 'react';

// Ctrl/⌘ B and Ctrl/⌘ I in a box where a message is written (#1247): they wrap the selected words in `**` or `*`, and take the marks off
// again when pressed on words that already have them. With nothing selected they put the pair of marks down with the caret between them.
// The text is changed as typing changes it (`insertText`), so the field's own undo still takes the marks back.

const MARKS: Record<string, string> = { b: '**', i: '*' };

/** Whether a mark of this width stands exactly on both sides of the range: `*` is not the end of a `**` pair. */
const wraps = (value: string, from: number, to: number, mark: string) => {
  const before = value.slice(Math.max(0, from - mark.length - 1), from);
  const after = value.slice(to, to + mark.length + 1);
  return before.endsWith(mark) && after.startsWith(mark) && (mark === '**' || (!before.endsWith('**') && !after.startsWith('**')));
};

/** Whether the words themselves start and end with the mark ("**bold**" selected as a whole). */
const marked = (picked: string, mark: string) => picked.length > 2 * mark.length && picked.startsWith(mark) && picked.endsWith(mark) && (mark === '**' || (!picked.startsWith('**') && !picked.endsWith('**')));

function replace(field: HTMLTextAreaElement, from: number, to: number, text: string, selectFrom: number, selectTo: number) {
  field.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) {
    field.setRangeText(text, from, to, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.setSelectionRange(selectFrom, selectTo);
}

/** Puts the marks on (or takes them off) the selection of `field`. */
export function toggleMark(field: HTMLTextAreaElement, mark: string) {
  const { value, selectionStart: from, selectionEnd: to } = field;
  const width = mark.length;
  const picked = value.slice(from, to);
  if (from !== to && wraps(value, from, to, mark)) replace(field, from - width, to + width, picked, from - width, to - width);
  else if (marked(picked, mark)) replace(field, from, to, picked.slice(width, -width), from, to - 2 * width);
  else replace(field, from, to, `${mark}${picked}${mark}`, from + width, to + width);
}

/** The key handler of a composer: true when the key was Ctrl/⌘ B or I and has been taken. */
export function formatKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return false;
  const mark = MARKS[event.key.toLowerCase()];
  if (!mark) return false;
  event.preventDefault();
  toggleMark(event.currentTarget, mark);
  return true;
}
