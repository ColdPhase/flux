/**
 * The words every place uses for an external agent on a task it holds (#763 AG-4): the Agents row, its panel, the sidebar
 * card and Home say the same thing. Working only for a claimed unit on a live session (C-1); a pause in force reads
 * "Pausing" until the agent reaches its safe point, then "Paused by …" (#160 AC-5).
 */
export function pausedLine(by: string, taskNumber: number, settling: boolean): string {
  return settling ? `Pausing on #${taskNumber} · waits for a safe point` : `Paused by ${by} · #${taskNumber}`;
}

/** A task the agent holds without working on it now: what Flux can prove about why. */
export function holdsLine(taskNumber: number, why: string): string {
  return `Has #${taskNumber} · ${why}`;
}

export function workingLine(taskNumber: number, title: string): string {
  return `Working on #${taskNumber} · ${title}`;
}
