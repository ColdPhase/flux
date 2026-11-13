/** What the editing controllers do with a failure they cannot hand to a caller: the API's logger, or stderr when none is given. */
export type EditingReport = (error: unknown, what: string) => void;

const toStderr: EditingReport = (error, what) => { console.error(`Live editing ${what} failed`, error); };

/**
 * Work nobody awaits: a room's read, a text commit, a cursor renewal. Each ends in its own failure path (the editor is told, the
 * connection closes), so a rejection that still gets here is a defect. It is reported and nothing more: an unhandled rejection stops the
 * whole API process, every other person's session with it (v0.2.1 P1: signing out with a wiki editor open).
 */
export function background(work: Promise<unknown>, what: string, report?: EditingReport) {
  work.catch((error: unknown) => {
    try { (report ?? toStderr)(error, what); }
    catch { /* The report itself failing must not end the process either. */ }
  });
}
