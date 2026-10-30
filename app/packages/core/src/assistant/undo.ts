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
  | { kind: 'created' }
  /**
   * The assistant made a map, a result, a decision or a message that no person can remove (#68 closeout): Undo takes it back
   * only while nobody has used it. `title` is what a map was called when made; `version` what a decision's version was;
   * `finishes` the task a result finished, as it was before.
   */
  | { kind: 'removal'; title?: string; version?: number; finishes?: { workId: string; status: string; blocker: string | null } }
  /** A hand-off to the owner's agent: Undo cancels exactly this unit while it is untouched and was never claimed. */
  | { kind: 'handoff'; unitId: string; taskId: string; creationVersion: number };

export interface UndoRecord { plan: UndoPlan; before: string | null; after: string | null }

/** Equal as stored: a missing value is null, and lists (done-when, prerequisites) are equal item by item. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
/** What a field is called in the message when several changed ("done-when, prerequisites"). */
const FIELD_NAMES: Record<string, string> = { criteria: 'done-when', dependencyIds: 'prerequisites', waitingFor: 'waiting-for', blocker: 'blocker' };
const COUNTED: Record<string, string> = { criteria: 'done-when', dependencyIds: 'prerequisites' };
/**
 * "Probes" -> "Calibrate the probes" for one changed field; several fields read as their names. A list reads as how many
 * items it holds, and a person to wait for as `names` resolves them (an id is never shown).
 */
export function fieldWords(fields: Record<string, { before: unknown; after: unknown }>, names: ReadonlyMap<string, string> = new Map()): { before: string | null; after: string | null } {
  const keys = Object.keys(fields);
  if (keys.length === 1) {
    const key = keys[0]!; const only = fields[key]!;
    const show = (value: unknown) => {
      if (Array.isArray(value)) return `${value.length ? value.length : 'no'} ${key === 'dependencyIds' && value.length === 1 ? 'prerequisite' : COUNTED[key] ?? 'items'}`;
      if (key === 'waitingFor') return typeof value === 'string' && value ? names.get(value) ?? 'someone' : 'no one';
      return typeof value === 'string' ? (value ? clip(value) : 'empty') : value === null || value === undefined ? 'empty' : clip(String(value));
    };
    return { before: show(only.before), after: show(only.after) };
  }
  return { before: null, after: keys.map((key) => FIELD_NAMES[key] ?? key).join(', ') || null };
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
