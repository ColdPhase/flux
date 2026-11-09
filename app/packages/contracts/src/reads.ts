/**
 * Several reads in one request (#862). A view that opens asks for its space, its people, its pages, its conversation's roots, notices
 * and sources, the Inbox count and where the person left off, all in the same moment; the web client sends the ones it asks for in one
 * task as one `GET /api/v1/reads?path=…&path=…`, and the server answers each from its own route, as the same session would be answered.
 * Only the reads named here are folded, at most READS_LIMIT at a time.
 */
export const READS_PATH = '/api/v1/reads';
export const READS_LIMIT = 12;

/** One read's answer: the status its own route gave and its JSON body as text (empty for a 204 or an answer that is not JSON). */
export interface FoldedReadAnswer { status: number; body: string }
export interface FoldedReadsResponse { answers: FoldedReadAnswer[] }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// What a space and its conversation read when they open, and where the person left off. The person's own lists that change on their own
// (the Inbox, the agents' runs and status, the working agents) and a space's task list keep their own requests.
const FOLDED = [
  new RegExp(`^/api/v1/projects/${UUID}(?:/(?:people|docs|work-summary|work-associations|conversation-roots|task-notices|object-notices|materials|agent-questions))?$`),
  new RegExp(`^/api/v1/workspaces/${UUID}/(?:members|sketches|work/assigned)$`),
  /^\/api\/v1\/(?:return|agent-chats)$/,
];

/** Whether a read is one of those folded: a JSON read of the API named above, with a plain query string and nothing that leaves the API. */
export function foldableRead(path: string): boolean {
  if (path.length > 1024) return false;
  const mark = path.indexOf('?');
  const route = mark < 0 ? path : path.slice(0, mark);
  const query = mark < 0 ? '' : path.slice(mark + 1);
  return FOLDED.some((pattern) => pattern.test(route)) && /^[A-Za-z0-9_.~%&=:,+-]*$/.test(query);
}
