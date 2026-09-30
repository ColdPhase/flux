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

/** A message that asks something: a question mark at the end or before a space. */
export const isQuestion = (body: string) => /\?\s*(\p{Emoji_Presentation})?\s*$/u.test(body.trim()) || /\?\s/.test(body);
