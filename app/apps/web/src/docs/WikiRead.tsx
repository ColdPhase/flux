import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NamedPrincipal, NativeWorkRow } from '@flux/contracts';
import { Avatar, Kreska, StatusGlyph, TASK_STATE_WORD } from '../ui';
import { getWorkReferenceRows } from '../work/read-api';
import type { AgentOwners } from '../agents/owners';
import { ago, longDate, shortDate } from './format';

// The reading side of the wiki as drawn (F-026, #354): who edited the page, the "On this page"
// outline from its headings, and the references the page holds, a task as its glyph, #number and
// word, and a decision standing alone as a card. The page text itself is the server's sanitized
// HTML; the references are read through the same bounded read as the conversation's.

function Face({ who }: { who: NamedPrincipal }) {
  return who.kind === 'agent' ? <Kreska size={20} /> : <Avatar name={who.name} size="sm" />;
}

function WhoName({ who, owners }: { who: NamedPrincipal; owners: AgentOwners }) {
  const owner = who.kind === 'agent' ? owners.get(who.id) : undefined;
  return <>{who.name}{owner ? ` for ${owner}` : ''}</>;
}

/** "Edited by <who> · <time>" with the editors' faces: the last editor, then who started the page. */
export function EditedBy({ editor, at, reason, starter, startedAt, owners }: {
  editor: NamedPrincipal; at: string; reason: string; starter: NamedPrincipal; startedAt: string; owners: AgentOwners;
}) {
  const other = starter.id !== editor.id;
  return (
    <p className="wiki-who">
      <span className="wiki-who__by">
        <Face who={editor} />
        <span><span className="wiki-who__verb">Edited by </span><WhoName who={editor} owners={owners} /> · <time dateTime={at} title={`${longDate(at)} · ${reason}`}>{ago(at)}</time></span>
      </span>
      {other ? (
        <span className="wiki-who__by wiki-who__starter">
          <span className="wiki-who__dot" aria-hidden="true">·</span>
          <Face who={starter} />
          <span><span className="ui-vh">Started by </span><WhoName who={starter} owners={owners} /> · <time dateTime={startedAt} title={longDate(startedAt)}>{shortDate(startedAt)}</time></span>
        </span>
      ) : null}
    </p>
  );
}

export interface Heading { id: string; text: string; level: number }

interface Mark { key: string; host: HTMLElement; kind: 'glyph' | 'word' | 'decision'; row: NativeWorkRow }

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function headingsOf(html: string): Heading[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('h1, h2, h3')].flatMap((node) => {
    const text = node.textContent?.trim() ?? '';
    return text ? [{ text, level: Number(node.tagName.slice(1)) }] : [];
  }).map((heading, index) => ({ ...heading, id: `section-${index + 1}` }));
}

/**
 * Reads the rendered page: gives its headings an id for the outline, and marks the work and decision
 * references that this person can read. What cannot be read stays the plain link the server wrote.
 */
export function useProse(el: HTMLElement | null, html: string, projectId: string) {
  const [marks, setMarks] = useState<Mark[]>([]);
  // The outline is read from the same HTML the page shows, then the rendered headings get these ids.
  const headings = useMemo(() => headingsOf(html), [html]);

  useEffect(() => {
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('h1, h2, h3')].filter((node) => node.textContent?.trim());
    nodes.forEach((node, index) => { node.id = `section-${index + 1}`; node.tabIndex = -1; });
  }, [el, html]);

  useEffect(() => {
    if (!el) return;
    const anchors = [...el.querySelectorAll<HTMLAnchorElement>('a.doc-ref[data-ref-type]')]
      .filter((anchor) => (anchor.dataset.refType === 'work' || anchor.dataset.refType === 'decision') && anchor.dataset.refId);
    if (!anchors.length) return;
    const controller = new AbortController();
    const inserted: HTMLElement[] = [];
    const classed: HTMLElement[] = [];
    const unwrap: (() => void)[] = [];
    const refs = [...new Set(anchors.map((anchor) => `${anchor.dataset.refType}:${anchor.dataset.refId}`))];
    const chunks: string[][] = [];
    for (let start = 0; start < refs.length; start += 100) chunks.push(refs.slice(start, start + 100));
    Promise.all(chunks.map((chunk) => getWorkReferenceRows(projectId, chunk.join(','), controller.signal))).then((reads) => {
      if (controller.signal.aborted) return;
      const rows = new Map<string, NativeWorkRow>(reads.flatMap((read) => read.items).map((row) => [`${row.kind}:${row.id}`, row]));
      const next: Mark[] = [];
      const host = (anchor: HTMLElement, at: 'start' | 'end', className: string) => {
        const span = document.createElement('span');
        span.className = className;
        if (at === 'start') anchor.prepend(span); else anchor.append(span);
        inserted.push(span);
        return span;
      };
      anchors.forEach((anchor, index) => {
        const row = rows.get(`${anchor.dataset.refType}:${anchor.dataset.refId}`);
        if (!row) return;
        const key = `${index}`;
        if (row.kind === 'work') {
          anchor.classList.add('doc-task'); classed.push(anchor);
          next.push({ key: `${key}g`, host: host(anchor, 'start', 'doc-task__mark'), kind: 'glyph', row });
          next.push({ key: `${key}w`, host: host(anchor, 'end', 'doc-task__word'), kind: 'word', row });
        } else if (row.kind === 'decision') {
          const paragraph = anchor.parentElement;
          if (paragraph?.tagName !== 'P' || paragraph.children.length !== 1 || paragraph.textContent?.trim() !== anchor.textContent?.trim()) return;
          anchor.classList.add('doc-decision'); classed.push(anchor);
          // The card names the decision itself; the author's link text steps out of the way, not out of the page.
          const written = document.createElement('span');
          written.hidden = true;
          written.append(...anchor.childNodes);
          anchor.append(written);
          unwrap.push(() => { anchor.append(...written.childNodes); written.remove(); });
          next.push({ key: `${key}d`, host: host(anchor, 'start', 'doc-decision__body'), kind: 'decision', row });
        }
      });
      setMarks(next);
    }, () => undefined);
    return () => {
      controller.abort();
      inserted.forEach((node) => node.remove());
      unwrap.forEach((restore) => restore());
      classed.forEach((node) => node.classList.remove('doc-task', 'doc-decision'));
      setMarks([]);
    };
  }, [el, html, projectId]);

  return {
    headings,
    marks: marks.map((mark) => createPortal(<RefMark mark={mark} />, mark.host, mark.key)),
  };
}

const DECISION_WORD = { accepted: 'Decision accepted', proposed: 'Decision proposed', superseded: 'Decision replaced' } as const;
const DECISION_GLYPH = { accepted: 'done', proposed: 'open', superseded: 'not_pursued' } as const;

function RefMark({ mark }: { mark: Mark }) {
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
      <span className="doc-decision__t"><b>{DECISION_WORD[row.status]}</b><span className="doc-decision__title"><span className="doc-decision__sep"> · </span>{row.title}</span></span>
      <span className="doc-decision__meta">{shortDate(when)} · {who.name}</span>
    </>
  );
}

/** "On this page": the page's headings; the one being read is marked, and each moves focus to its heading. */
export function Outline({ headings, scroller }: { headings: Heading[]; scroller: HTMLElement | null }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!scroller || !headings.length) return;
    const measure = () => {
      const line = scroller.getBoundingClientRect().top + 120;
      let found = headings[0]!.id;
      for (const heading of headings) {
        const node = document.getElementById(heading.id);
        if (node && node.getBoundingClientRect().top <= line) found = heading.id;
      }
      setCurrent(found);
    };
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    return () => scroller.removeEventListener('scroll', measure);
  }, [scroller, headings]);
  const open = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const node = document.getElementById(id);
    if (!node) return;
    event.preventDefault();
    node.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    node.focus({ preventScroll: true });
    setCurrent(id);
  };
  const base = Math.min(...headings.map((heading) => heading.level));
  return (
    <aside className="wiki-outline" aria-label="On this page">
      <p className="wiki-outline__h">On this page</p>
      <ul>
        {headings.map((heading) => (
          <li key={heading.id} data-level={heading.level - base}>
            <a href={`#${heading.id}`} aria-current={heading.id === current ? 'location' : undefined} onClick={(event) => open(event, heading.id)}>{heading.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
