import { defangedAddresses } from './web-addresses.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

// "Web: read-only page reading, always citing the sources" (F-036 AG-8, #918). Every address the Flux server sent a request to for a run is
// recorded by the tool BEFORE the request goes out, whether the site then gave a page or an error, and the run ends with all of them in
// Flux's own words, under its answer or, when it has none, in its end line (the owner's run view and the task's discussion): the sources
// of an answer, and what went out of the server on the agent's word, are kept by Flux and not by the model's good habits. A page's text is
// never kept, only where it came from. Nothing of the site's own words is in the line: not its title either, only the addresses.
// The searches of the provider's built-in web search (#954) come first: what the agent searched for and the addresses the answers cite,
// as the provider's structured answer gave them, recorded when it came back.

/** What became of one address the server asked: `read` is a page that came back, `redirected` a hop that sent the server on, `asked` a request whose end was never recorded. */
export type WebReadOutcome = 'asked' | 'read' | 'redirected' | 'blocked' | 'unreachable' | 'timeout' | 'status' | 'type' | 'redirects' | 'invalid' | 'empty';

/** The headings of the block Flux appends to an answer; the block starts at the first of them, after a blank line. */
export const WEB_SOURCES_HEADINGS = ['Searched the web for:', 'Found on the web:', 'Read on the web:', 'Requested, not read:'] as const;

/** The most queries and cited addresses one block lists. The pages a run read are all listed: there is no limit on how many it reads (#1113), and each is a source (AG-8). */
const LISTED = 20;

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

/**
 * "Searched the web for:" with the run's queries and "Found on the web:" with the addresses its answers cite (#954), then "Read on the
 * web:" with every page that came back, and "Requested, not read:" with every other address the server sent a request to.
 */
export function webSourcesLine(reads: readonly { finalUrl: string; outcome: string }[], searches: { queries: readonly string[]; cited: readonly string[] } = { queries: [], cited: [] }): string {
  const read = reads.filter((item) => item.outcome === 'read');
  const other = reads.filter((item) => item.outcome !== 'read');
  const parts: string[] = [];
  const more = (count: number) => (count > LISTED ? `\n- and ${count - LISTED} more` : '');
  // A query is the model's own text and is never checked: an address in it is listed defanged, never as a link a later run could open (#1143).
  if (searches.queries.length) parts.push(`${WEB_SOURCES_HEADINGS[0]}\n${searches.queries.slice(0, LISTED).map((query) => `- ${defangedAddresses(query)}`).join('\n')}${more(searches.queries.length)}`);
  if (searches.cited.length) parts.push(`${WEB_SOURCES_HEADINGS[1]}\n${searches.cited.slice(0, LISTED).map((address) => `- ${address}`).join('\n')}${more(searches.cited.length)}`);
  if (read.length) parts.push(`${WEB_SOURCES_HEADINGS[2]}\n${read.map((item) => `- ${item.finalUrl}`).join('\n')}`);
  if (other.length) parts.push(`${WEB_SOURCES_HEADINGS[3]}\n${other.map((item) => `- ${item.finalUrl} (${NOT_READ[item.outcome as keyof typeof NOT_READ] ?? 'not read'})`).join('\n')}`);
  return parts.join('\n');
}

/** The answer with the run's searches and the addresses it asked for at its end. */
export async function answerWithWebSources(ports: PersonalRunPorts, run: Pick<RunRecord, 'id'>, answer: string,
  listed: (address: string) => Promise<string> = async (address) => address): Promise<string> {
  // Each address as the stored answer may hold it (#1149): one the run could read only by a site's path rule is listed, but not as a link a
  // later run would take as written.
  const reads = await Promise.all((await ports.runs.webReads(run.id)).map(async (item) => ({ ...item, finalUrl: await listed(item.finalUrl) })));
  const searches = await ports.runs.webSearches(run.id);
  const line = webSourcesLine(reads, { ...searches, cited: await Promise.all(searches.cited.map(listed)) });
  return line ? `${answer.trimEnd()}\n\n${line}` : answer;
}

/** The searches and addresses of a run that ended without an answer: the end line's second paragraph; empty when it had none. */
export async function endedWithWebSources(ports: PersonalRunPorts, run: Pick<RunRecord, 'id'>): Promise<string> {
  return webSourcesLine(await ports.runs.webReads(run.id), await ports.runs.webSearches(run.id));
}
