import type { Doc, DocState, NamedPrincipal, ObjectLink } from '@flux/contracts';

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const shortDate = (iso: string) => day.format(new Date(iso));
export const longDate = (iso: string) => stamp.format(new Date(iso));

export const STATE_LABEL: Record<DocState, string> = { draft: 'Draft', published: 'Published' };
/** Who made a version: an agent writing under its owner's standing grant (#152) is named "name · agent", as in the conversation. */
export const authorLabel = (who: NamedPrincipal) => (who.kind === 'agent' ? `${who.name} · agent` : who.name);

const KIND: Record<string, string> = {
  doc: 'Doc', work: 'Work', decision: 'Decision', result: 'Result', message: 'Message', thought: 'Thought', sketch: 'Sketch', material: 'Material',
};
export const kindLabel = (type: string) => KIND[type] ?? type;

/** A doc's links split by what they mean for a reader. */
export function docLinks(doc: Doc) {
  const out = doc.links.filter((link) => link.from.id === doc.id);
  const backlinks = doc.links.filter((link) => link.to.id === doc.id && link.from.id !== doc.id);
  return {
    sources: out.filter((link) => link.role === 'source'),
    mentions: out.filter((link) => link.role === 'mentions'),
    backlinks: dedupe(backlinks),
  };
}

function dedupe(links: ObjectLink[]) {
  const seen = new Set<string>();
  return links.filter((link) => { const key = `${link.from.type}:${link.from.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/** App path of the other end of a link, or null when it opens in the Details panel. */
export function pathOfLink(projectId: string, link: ObjectLink, end: 'from' | 'to'): string | null {
  const ref = end === 'from' ? link.from : link.to;
  if (ref.type === 'doc') return `/projects/${projectId}/docs/${ref.id}`;
  if (ref.type === 'message') return link.conversationId ? `/projects/${projectId}/conversations/${link.conversationId}#message-${ref.id}` : null;
  if (ref.type === 'sketch') return `/map/${ref.id}`;
  if (ref.type === 'thought') return link.sketchId ? `/map/${link.sketchId}` : null;
  if (ref.type === 'material') return `/materials/${ref.id}/versions/${ref.version}`;
  return null;
}
