import type { PersonalRunPorts, RunRecord } from './ports.js';

// "Web: read-only page reading, always citing the sources" (F-036 AG-8, #918). Every address the Flux server sent a request to for a run is
// recorded by the tool BEFORE the request goes out, whether the site then gave a page or an error, and the run ends with all of them in
// Flux's own words, under its answer or, when it has none, in its end line (the owner's run view and the task's discussion): the sources
// of an answer, and what went out of the server on the agent's word, are kept by Flux and not by the model's good habits. A page's text is
// never kept, only where it came from. Nothing of the site's own words is in the line: not its title either, only the addresses.

/** What became of one address the server asked: `read` is a page that came back, `redirected` a hop that sent the server on, `asked` a request whose end was never recorded. */
export type WebReadOutcome = 'asked' | 'read' | 'redirected' | 'blocked' | 'unreachable' | 'timeout' | 'status' | 'type' | 'redirects' | 'invalid' | 'empty';

/** The headings of the block Flux appends to an answer; the block starts at the first of them, after a blank line. */
export const WEB_SOURCES_HEADINGS = ['Read on the web:', 'Requested, not read:'] as const;

const NOT_READ: Record<Exclude<WebReadOutcome, 'read'>, string> = {
  asked: 'the request was sent; no answer was recorded',
  redirected: 'it sent the request on to another address',
  blocked: 'refused: not a public address',
  unreachable: 'not reached',
  timeout: 'took too long',
  status: 'the site answered with an error',
  type: 'not a web page or a text page',
  redirects: 'too many redirects',
  invalid: 'not a web address',
  empty: 'no text on the page',
};

/** "Read on the web:" with every page that came back, and "Requested, not read:" with every other address the server sent a request to. */
export function webSourcesLine(reads: readonly { finalUrl: string; outcome: string }[]): string {
  const read = reads.filter((item) => item.outcome === 'read');
  const other = reads.filter((item) => item.outcome !== 'read');
  const parts: string[] = [];
  if (read.length) parts.push(`${WEB_SOURCES_HEADINGS[0]}\n${read.map((item) => `- ${item.finalUrl}`).join('\n')}`);
  if (other.length) parts.push(`${WEB_SOURCES_HEADINGS[1]}\n${other.map((item) => `- ${item.finalUrl} (${NOT_READ[item.outcome as keyof typeof NOT_READ] ?? 'not read'})`).join('\n')}`);
  return parts.join('\n');
}

/** The answer with the addresses the run asked for at its end. */
export async function answerWithWebSources(ports: PersonalRunPorts, run: Pick<RunRecord, 'id'>, answer: string): Promise<string> {
  const line = webSourcesLine(await ports.runs.webReads(run.id));
  return line ? `${answer.trimEnd()}\n\n${line}` : answer;
}

/** The addresses of a run that ended without an answer: the end line's second paragraph; empty when the run asked for none. */
export async function endedWithWebSources(ports: PersonalRunPorts, run: Pick<RunRecord, 'id'>): Promise<string> {
  return webSourcesLine(await ports.runs.webReads(run.id));
}
