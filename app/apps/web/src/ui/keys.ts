/**
 * Where a key is the composer's, never an app shortcut (#1424): anywhere inside a composer, not only its text field. After a file is attached
 * the focus can be on the paperclip, Send or a file's remove button, and typing there ("check") opened New with "heck" in its title and went to
 * the Inbox. Every single-key shortcut ("C", "G" then "I", "[", the Inbox's and a task's keys, End) asks this before it acts.
 */
export function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.composer, .composer__box, .composer-files') !== null;
}
