import type { PersonalRunPorts, RunRecord } from './ports.js';

// "Web: read-only search and page reading, always citing the sources" (F-036 AG-8, #918). The pages a run read are recorded by the tool
// that returned them; the answer ends with them in Flux's own words, so the sources of an answer are kept by Flux and not by the model's
// good habits. A page's text is never kept, only where it came from.

const MOST_LISTED = 5;
const LINE_MAX = 200;

/** "Read on the web:" and the pages, one per line; empty when the run read none. */
export function webSourcesLine(reads: readonly { finalUrl: string; title: string | null }[]): string {
  if (!reads.length) return '';
  const shown = reads.slice(0, MOST_LISTED).map((read) => {
    const title = read.title?.replace(/\s+/g, ' ').trim();
    const line = title ? `${title}: ${read.finalUrl}` : read.finalUrl;
    return `- ${line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line}`;
  });
  const more = reads.length > MOST_LISTED ? `\n- and ${reads.length - MOST_LISTED} more` : '';
  return `Read on the web:\n${shown.join('\n')}${more}`;
}

/** The answer with the pages the run read at its end. */
export async function answerWithWebSources(ports: PersonalRunPorts, run: Pick<RunRecord, 'id'>, answer: string): Promise<string> {
  const line = webSourcesLine(await ports.runs.webReads(run.id));
  return line ? `${answer.trimEnd()}\n\n${line}` : answer;
}
