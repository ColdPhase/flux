/**
 * The words every place uses for an external agent on a task it holds (#763 AG-4): the Agents row, its panel, the sidebar
 * card and Home say the same thing. Working only for a claimed unit on a live session (C-1).
 */

/** A task the agent holds without working on it now: what Flux can prove about why. */
export function holdsLine(taskNumber: number, why: string): string {
  return `Has #${taskNumber} · ${why}`;
}

export function workingLine(taskNumber: number, title: string): string {
  return `Working on #${taskNumber} · ${title}`;
}
