// Undo of an assistant run's changes (F-027 AST-6, A4 #404). Pure: the server reads the current object, asks
// these functions what may be restored, and writes the restore as an ordinary new version.

/** What an applied change kept so that it can be taken back. Never a credential; bounded by the receipt's 64 KB. */
export type UndoPlan =
  /** Task or thought fields: restored only where the object still holds exactly what the assistant wrote. */
  | { kind: 'fields'; fields: Record<string, { before: unknown; after: unknown }> }
  /** Thought positions the assistant moved. */
  | { kind: 'positions'; moves: { id: string; before: { x: number; y: number }; after: { x: number; y: number } }[] }
  /** Page fields (title, text, state): the earlier version is read from the page's own history. */
  | { kind: 'doc'; fields: ('title' | 'body' | 'state')[] }
  /** The assistant made this object; Undo removes it (a page moves to the owner's drafts). */
  | { kind: 'created' };

export interface UndoRecord { plan: UndoPlan; before: string | null; after: string | null }

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Field-level rule: restore the fields the assistant changed if each still holds what the assistant wrote. One edited
 * since means the whole item says "Changed since" and does nothing; other fields (a state change) do not matter.
 */
export function restorableFields(fields: Record<string, { before: unknown; after: unknown }>, current: Record<string, unknown>):
  { restore: Record<string, unknown>; changedSince: string[] } {
  const restore: Record<string, unknown> = {}; const changedSince: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (same(current[name], value.after)) restore[name] = value.before; else changedSince.push(name);
  }
  return { restore, changedSince };
}

const clip = (value: string, length = 60) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
/** "Probes" -> "Calibrate the probes" for one changed field; several fields read as their names. */
export function fieldWords(fields: Record<string, { before: unknown; after: unknown }>): { before: string | null; after: string | null } {
  const names = Object.keys(fields);
  if (names.length === 1) {
    const only = fields[names[0]!]!;
    const show = (value: unknown) => typeof value === 'string' ? (value ? clip(value) : 'empty') : value === null || value === undefined ? 'empty' : clip(String(value));
    return { before: show(only.before), after: show(only.after) };
  }
  return { before: null, after: names.join(', ') || null };
}

/** How many blank-line separated paragraphs differ between two page texts ("2 paragraphs changed"). */
export function changedParagraphs(before: string, after: string): number {
  const a = before.split(/\n{2,}/); const b = after.split(/\n{2,}/);
  let count = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) if (a[index] !== b[index]) count++;
  return count;
}

/** "Undid 5 changes. 2 changed since: #4, #7" (F-027 "Undone"); a clean Undo says only what it did. */
export function undoSentence(undone: number, changedSince: readonly string[]): string {
  const did = `Undid ${undone} change${undone === 1 ? '' : 's'}`;
  return changedSince.length ? `${did}. ${changedSince.length} changed since: ${changedSince.join(', ')}` : did;
}
