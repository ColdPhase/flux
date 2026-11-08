import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NamedPrincipal, NativeWorkRow } from '@flux/contracts';
import { AgentIdentity, Icon, Morph, StatusGlyph, TASK_STATE_WORD } from '../ui';
import { getWorkReferenceRows, getWorkRelations } from '../work/read-api';
import type { AgentOwners } from '../agents/owners';
import { shortDate } from './format';

// The references a page holds, as the page shows them (F-026, #354; F-034): a task as its glyph, #number and word,
// a page with its icon, and a decision alone on its line as a live card with its short reason. The editor (#869)
// and an earlier version read through here draw the same marks.

/** A person's name, or an agent as the final design names it: its name, the Agent tag and "for <owner>". */
function WhoName({ who, owners }: { who: NamedPrincipal; owners: AgentOwners }) {
  return who.kind === 'agent' ? <AgentIdentity name={who.name} owner={owners.get(who.id)} icon={false} className="wiki-who__agent" /> : <>{who.name}</>;
}

export interface Heading { id: string; text: string; level: number }

/** One mark of a reference; `source` is where a decision came from (CW-16). */
export type Mark = { kind: 'glyph' | 'word'; row: NativeWorkRow } | { kind: 'decision'; row: NativeWorkRow; source?: string } | { kind: 'page' };

/** The page's headings (levels 1–3), from the HTML it shows. */
export function headingsOfHtml(html: string): Heading[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('h1, h2, h3')].flatMap((node) => {
    const text = node.textContent?.trim() ?? '';
    return text ? [{ text, level: Number(node.tagName.slice(1)) }] : [];
  }).map((heading, index) => ({ ...heading, id: `section-${index + 1}` }));
}

/**
 * The tasks and decisions a page refers to, as this person can read them now (`type:id` keys, at most 100 per read),
 * and where each decision came from (its first source message, CW-16).
 */
export async function readReferences(projectId: string, refs: string[], signal: AbortSignal) {
  const chunks: string[][] = [];
  for (let start = 0; start < refs.length; start += 100) chunks.push(refs.slice(start, start + 100));
  const decisions = refs.filter((ref) => ref.startsWith('decision:')).slice(0, 100);
  const basedOn = decisions.length ? getWorkRelations(projectId, { objects: decisions.join(','), role: 'source', limit: 100 }, signal).then((page) => {
    const found = new Map<string, string>();
    for (const link of page.items) if (link.from.type === 'decision' && link.to.type === 'message' && !found.has(link.from.id) && link.toTitle) found.set(link.from.id, link.toTitle);
    return found;
  }, () => new Map<string, string>()) : Promise.resolve(new Map<string, string>());
  const [reads, sources] = await Promise.all([Promise.all(chunks.map((chunk) => getWorkReferenceRows(projectId, chunk.join(','), signal))), basedOn]);
  return { rows: new Map<string, NativeWorkRow>(reads.flatMap((read) => read.items).map((row) => [`${row.kind}:${row.id}`, row])), sources };
}

const RETRY_MS = 5000;

/**
 * Reads an earlier version's rendered HTML: gives its headings an id for Contents, and marks the work and decision
 * references that this person can read. What cannot be read stays the plain link the server wrote. The marks follow
 * the objects: the read repeats when the window gets focus, and soon after a failed read.
 */
export function useProse(el: HTMLElement | null, html: string, projectId: string, owners: AgentOwners) {
  const [marks, setMarks] = useState<(Mark & { key: string; host: HTMLElement })[]>([]);
  const headings = useMemo(() => headingsOfHtml(html), [html]);

  useEffect(() => {
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('h1, h2, h3')].filter((node) => node.textContent?.trim());
    nodes.forEach((node, index) => { node.id = `section-${index + 1}`; node.tabIndex = -1; });
  }, [el, html]);

  useEffect(() => {
    if (!el) return;
    const anchors = [...el.querySelectorAll<HTMLAnchorElement>('a.doc-ref[data-ref-type]')]
      .filter((anchor) => ['work', 'decision', 'doc'].includes(anchor.dataset.refType ?? '') && anchor.dataset.refId);
    if (!anchors.length) return;
    // What each anchor currently carries, so a later read updates it in place and never doubles it.
    const carried = anchors.map(() => ({ hosts: [] as HTMLElement[], unwrap: null as (() => void) | null }));
    // Doc links were already resolved by the server. Their icon requires no new read or metadata.
    const refs = [...new Set(anchors.filter((anchor) => anchor.dataset.refType !== 'doc').map((anchor) => `${anchor.dataset.refType}:${anchor.dataset.refId}`))];
    let controller = new AbortController();
    let retry = 0;
    let gone = false;

    const clear = (index: number) => {
      const own = carried[index]!;
      own.hosts.forEach((node) => node.remove());
      own.hosts = [];
      own.unwrap?.();
      own.unwrap = null;
      anchors[index]!.classList.remove('doc-task', 'doc-decision', 'doc-page');
    };
    const apply = (rows: Map<string, NativeWorkRow>, sources = new Map<string, string>()) => {
      const next: (Mark & { key: string; host: HTMLElement })[] = [];
      anchors.forEach((anchor, index) => {
        const row = rows.get(`${anchor.dataset.refType}:${anchor.dataset.refId}`);
        const own = carried[index]!;
        const solo = anchor.parentElement?.tagName === 'P' && anchor.parentElement.children.length === 1 && anchor.parentElement.textContent?.trim() === anchor.textContent?.trim();
        const host = (at: 'start' | 'end', className: string) => {
          const span = document.createElement('span');
          span.className = className;
          if (at === 'start') anchor.prepend(span); else anchor.append(span);
          own.hosts.push(span);
          return span;
        };
        if (anchor.dataset.refType === 'doc') {
          if (!own.hosts.length) {
            anchor.classList.add('doc-page');
            host('start', 'doc-page__icon');
          }
          next.push({ key: `${index}p`, host: own.hosts[0]!, kind: 'page' });
        } else if (row?.kind === 'work') {
          if (!own.hosts.length) {
            anchor.classList.add('doc-task');
            host('start', 'doc-task__mark'); host('end', 'doc-task__word');
          }
          next.push({ key: `${index}g`, host: own.hosts[0]!, kind: 'glyph', row }, { key: `${index}w`, host: own.hosts[1]!, kind: 'word', row });
        } else if (row?.kind === 'decision' && (own.hosts.length || solo)) {
          if (!own.hosts.length) {
            anchor.classList.add('doc-decision');
            // The card names the decision itself; the author's link text steps out of the way, not out of the page.
            const written = document.createElement('span');
            written.hidden = true;
            written.append(...anchor.childNodes);
            anchor.append(written);
            own.unwrap = () => { anchor.append(...written.childNodes); written.remove(); };
            host('start', 'doc-decision__body');
          }
          next.push({ key: `${index}d`, host: own.hosts[0]!, kind: 'decision', row, source: sources.get(row.id) });
        } else if (own.hosts.length) clear(index);
      });
      setMarks(next);
    };
    const load = () => {
      controller.abort();
      window.clearTimeout(retry);
      controller = new AbortController();
      const signal = controller.signal;
      readReferences(projectId, refs, signal).then(({ rows, sources }) => {
        if (signal.aborted || gone) return;
        apply(rows, sources);
      }, () => { if (!signal.aborted && !gone) retry = window.setTimeout(load, RETRY_MS); });
    };
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    // Stage the local page icons independently of the work-row read and its retry.
    void Promise.resolve().then(() => { if (!gone) apply(new Map()); });
    load();
    window.addEventListener('focus', refresh);
    return () => {
      gone = true;
      controller.abort();
      window.clearTimeout(retry);
      window.removeEventListener('focus', refresh);
      anchors.forEach((_, index) => clear(index));
      setMarks([]);
    };
  }, [el, html, projectId]);

  return {
    headings,
    marks: marks.map((mark) => createPortal(<RefMark mark={mark} owners={owners} />, mark.host, mark.key)),
  };
}

const DECISION_WORD = { accepted: 'Decision accepted', proposed: 'Decision proposed', superseded: 'Decision replaced' } as const;
const DECISION_GLYPH = { accepted: 'done', proposed: 'open', superseded: 'replaced' } as const;

export function RefMark({ mark, owners }: { mark: Mark; owners: AgentOwners }) {
  if (mark.kind === 'page') return <Icon name="doc" size={16} />;
  const { row } = mark;
  if (row.kind === 'work') {
    return mark.kind === 'glyph'
      ? <><StatusGlyph status={row.status} size={14} /><span className="doc-task__n">#{row.number}</span></>
      : <>{' '}<span className="doc-task__state">{TASK_STATE_WORD[row.status]}</span></>;
  }
  if (row.kind !== 'decision') return null;
  const when = row.decidedAt ?? row.createdAt;
  const who = row.decidedBy ?? row.proposedBy;
  return (
    <>
      <StatusGlyph status={DECISION_GLYPH[row.status]} size={18} className="doc-decision__ic" />
      <span className="doc-decision__t"><b><Morph value={row.status}>{DECISION_WORD[row.status]}</Morph></b><span className="doc-decision__title"><span className="doc-decision__sep"> · </span>{row.title}</span></span>
      <span className="doc-decision__meta">{shortDate(when)} · <WhoName who={who} owners={owners} /></span>
      {row.reason ? <span className="doc-decision__reason">{row.reason}</span> : null}
      {mark.kind === 'decision' && mark.source ? <span className="doc-decision__meta doc-decision__from">From the message “{mark.source}”</span> : null}
    </>
  );
}

/**
 * A smooth jump that stopped short lands on its heading (#752). WebKit can end a smooth scroll of the page early while
 * it is still settling after it opens. Unless the reader scrolled meanwhile (wheel, touch, a key or a pointer press),
 * the end of the motion puts the target where it was asked to go. `top()` answers the scroll position the target
 * needs. Returns how to stop watching.
 */
export function landOn(scroller: HTMLElement, top: () => number | null): () => void {
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  const stop = () => {
    scroller.removeEventListener('scrollend', land);
    for (const name of inputs) scroller.removeEventListener(name, stop);
  };
  function land() {
    stop();
    const wanted = top();
    if (wanted === null) return;
    const clamped = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, wanted));
    if (Math.abs(clamped - scroller.scrollTop) > 1) scroller.scrollTo({ top: clamped, behavior: 'auto' });
  }
  scroller.addEventListener('scrollend', land);
  for (const name of inputs) scroller.addEventListener(name, stop, { passive: true });
  return stop;
}
