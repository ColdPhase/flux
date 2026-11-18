// Whether a message addresses a person (shared by the return view #106 and notifications #116).
// Deterministic and conservative: a mention never grants access, it only selects a reason.

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a message addresses the reader: "@Ari", "@Ari Kowal", or opening with "Ari," / "Ari:". */
export function mentions(body: string, name: string) {
  const full = name.trim();
  if (full.length < 2) return false;
  const first = full.split(/\s+/)[0]!;
  const names = [...new Set([full, first])].filter((item) => item.length >= 2).map(escape);
  const at = new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  const opening = new RegExp(`^\\s*(${names.join('|')})\\s*[,:]`, 'iu');
  return at.test(body) || opening.test(body);
}

/**
 * A message that asks something: a question mark at the end (with at most one emoji after it) or before a space. A question mark
 * followed by space is the second test's, so the first needs none: a run of spaces after a `?` cost this check quadratic time, and a
 * message may be 100,000 characters long (v0.2.1 audit #1270).
 */
export const isQuestion = (body: string) => /\?\p{Emoji_Presentation}?$/u.test(body.trim()) || /\?\s/.test(body);

/** Whether a message names someone with "@" (#763 A2): a question to "@Jonas" is his to answer, not everyone's in the thread. */
export const mentionsSomeone = (body: string) => /(^|[^\p{L}\p{N}_])@\p{L}/u.test(body);

/**
 * Whether a message in a space's thread asks the thread's starter (personas-27, one rule for Home, Waiting for you and the Inbox): a
 * question that names nobody with "@" is for the person who started the thread, unless they asked it themselves. Nobody else is asked.
 */
export const asksStarter = (body: string, authorId: string | null, starterId: string | null) =>
  !!starterId && authorId !== starterId && isQuestion(body) && !mentionsSomeone(body);

/**
 * Who a thread's question that names nobody asks: its starter, a person (`asksStarter`). A decision's discussion has no starter of its own: it
 * asks the decision's proposer, an agent's owner for an agent's proposal, never whoever wrote in it first (#1424, persona round 8 P2 3). One
 * rule for the Inbox and its notifications and for Home's Continue (personas-33 P2 5).
 */
export const threadAskee = (thread: { createdBy: { kind: 'human' | 'agent'; id: string }; decision?: { askee: string | null } | null }): string | null =>
  thread.decision ? thread.decision.askee : thread.createdBy.kind === 'human' ? thread.createdBy.id : null;
