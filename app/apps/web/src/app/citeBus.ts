// "Cite" on a message quotes it into the composer of the same pane (F-026 S6). The stream and the open
// thread are two composers on one route, so the message's pane names which one answers.

export type CitePane = 'stream' | 'thread';
type Listener = (quote: string) => void;
const listeners = new Map<CitePane, Set<Listener>>();

/** The lines a quote adds above what the person writes: the message's words, each behind "> ". */
export function quoteOf(body: string, author: string): string {
  const lines = body.trim().split('\n').slice(0, 4).map((line) => `> ${line}`.trimEnd());
  return `> ${author}:\n${lines.join('\n')}\n\n`;
}

export function cite(pane: CitePane, quote: string) { listeners.get(pane)?.forEach((listener) => listener(quote)); }

export function onCite(pane: CitePane, listener: Listener): () => void {
  const set = listeners.get(pane) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(pane, set);
  return () => { set.delete(listener); };
}
