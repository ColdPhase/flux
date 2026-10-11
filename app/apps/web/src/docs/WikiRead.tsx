import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NamedPrincipal, NativeWorkRow } from '@flux/contracts';
import { AgentIdentity, Avatar, Icon, Kreska, prefersReducedMotion, StatusGlyph, TASK_STATE_WORD } from '../ui';
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

/** A person's name, or an agent as the final design names it: its name, the Agent tag and "for <owner>". */
function WhoName({ who, owners }: { who: NamedPrincipal; owners: AgentOwners }) {
  return who.kind === 'agent' ? <AgentIdentity name={who.name} owner={owners.get(who.id)} icon={false} className="wiki-who__agent" /> : <>{who.name}</>;
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

function headingsOf(html: string): Heading[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('h1, h2, h3')].flatMap((node) => {
    const text = node.textContent?.trim() ?? '';
    return text ? [{ text, level: Number(node.tagName.slice(1)) }] : [];
  }).map((heading, index) => ({ ...heading, id: `section-${index + 1}` }));
}

const REFRESH_MS = 20000;
const RETRY_MS = 5000;

/**
 * Reads the rendered page: gives its headings an id for the outline, and marks the work and decision
 * references that this person can read. What cannot be read stays the plain link the server wrote.
 * The marks follow the objects: the read repeats with the reader's own refresh (focus, every 20
 * seconds), also while the page's HTML is unchanged, and retries soon after a failed read.
 */
export function useProse(el: HTMLElement | null, html: string, projectId: string, owners: AgentOwners) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [pageMarks, setPageMarks] = useState<{ key: string; host: HTMLElement }[]>([]);
  // The outline is read from the same HTML the page shows, then the rendered headings get these ids.
  const headings = useMemo(() => headingsOf(html), [html]);

  useEffect(() => {
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('h1, h2, h3')].filter((node) => node.textContent?.trim());
    nodes.forEach((node, index) => { node.id = `section-${index + 1}`; node.tabIndex = -1; });
  }, [el, html]);

  useEffect(() => {
    if (!el) return;
    // Only links already resolved by the server receive the page icon. Unavailable references
    // remain plain spans; the written title, href and audience/version semantics stay untouched.
    const anchors = [...el.querySelectorAll<HTMLAnchorElement>('a.doc-ref[data-ref-type="doc"][data-ref-id]')];
    const next = anchors.map((anchor, index) => {
      const host = document.createElement('span');
      host.className = 'doc-page__icon';
      anchor.classList.add('doc-page');
      anchor.prepend(host);
      return { key: `page-${index}`, host };
    });
    setPageMarks(next);
    return () => {
      next.forEach((mark, index) => { mark.host.remove(); anchors[index]!.classList.remove('doc-page'); });
      setPageMarks([]);
    };
  }, [el, html]);

  useEffect(() => {
    if (!el) return;
    const anchors = [...el.querySelectorAll<HTMLAnchorElement>('a.doc-ref[data-ref-type]')]
      .filter((anchor) => (anchor.dataset.refType === 'work' || anchor.dataset.refType === 'decision') && anchor.dataset.refId);
    if (!anchors.length) return;
    // What each anchor currently carries, so a later read updates it in place and never doubles it.
    const carried = anchors.map(() => ({ hosts: [] as HTMLElement[], unwrap: null as (() => void) | null }));
    const refs = [...new Set(anchors.map((anchor) => `${anchor.dataset.refType}:${anchor.dataset.refId}`))];
    const chunks: string[][] = [];
    for (let start = 0; start < refs.length; start += 100) chunks.push(refs.slice(start, start + 100));
    let controller = new AbortController();
    let retry = 0;
    let gone = false;

    const clear = (index: number) => {
      const own = carried[index]!;
      own.hosts.forEach((node) => node.remove());
      own.hosts = [];
      own.unwrap?.();
      own.unwrap = null;
      anchors[index]!.classList.remove('doc-task', 'doc-decision');
    };
    const apply = (rows: Map<string, NativeWorkRow>) => {
      const next: Mark[] = [];
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
        if (row?.kind === 'work') {
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
          next.push({ key: `${index}d`, host: own.hosts[0]!, kind: 'decision', row });
        } else if (own.hosts.length) clear(index);
      });
      setMarks(next);
    };
    const load = () => {
      controller.abort();
      window.clearTimeout(retry);
      controller = new AbortController();
      const signal = controller.signal;
      Promise.all(chunks.map((chunk) => getWorkReferenceRows(projectId, chunk.join(','), signal))).then((reads) => {
        if (signal.aborted || gone) return;
        apply(new Map<string, NativeWorkRow>(reads.flatMap((read) => read.items).map((row) => [`${row.kind}:${row.id}`, row])));
      }, () => { if (!signal.aborted && !gone) retry = window.setTimeout(load, RETRY_MS); });
    };
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    load();
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, REFRESH_MS);
    return () => {
      gone = true;
      controller.abort();
      window.clearTimeout(retry);
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      anchors.forEach((_, index) => clear(index));
      setMarks([]);
    };
  }, [el, html, projectId]);

  return {
    headings,
    marks: [
      ...marks.map((mark) => createPortal(<RefMark mark={mark} owners={owners} />, mark.host, mark.key)),
      ...pageMarks.map((mark) => createPortal(<Icon name="doc" size={16} />, mark.host, mark.key)),
    ],
  };
}

const DECISION_WORD = { accepted: 'Decision accepted', proposed: 'Decision proposed', superseded: 'Decision replaced' } as const;
const DECISION_GLYPH = { accepted: 'done', proposed: 'open', superseded: 'not_pursued' } as const;

function RefMark({ mark, owners }: { mark: Mark; owners: AgentOwners }) {
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
      <span className="doc-decision__meta">{shortDate(when)} · <WhoName who={who} owners={owners} /></span>
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
    node.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
