import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NamedPrincipal, NativeWorkRow } from '@flux/contracts';
import { AgentIdentity, Avatar, Icon, Kreska, Morph, prefersReducedMotion, StatusGlyph, TASK_STATE_WORD } from '../ui';
import { getWorkReferenceRows } from '../work/read-api';
import type { AgentOwners } from '../agents/owners';
import { ago, longDate, shortDate } from './format';
import { WikiIcon } from './WikiParts';

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

type Mark = { key: string; host: HTMLElement } & (
  { kind: 'glyph' | 'word' | 'decision'; row: NativeWorkRow } | { kind: 'page' }
);

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
      .filter((anchor) => ['work', 'decision', 'doc'].includes(anchor.dataset.refType ?? '') && anchor.dataset.refId);
    if (!anchors.length) return;
    // What each anchor currently carries, so a later read updates it in place and never doubles it.
    const carried = anchors.map(() => ({ hosts: [] as HTMLElement[], unwrap: null as (() => void) | null }));
    // Doc links were already resolved by the server. Their icon requires no new read or metadata.
    const refs = [...new Set(anchors.filter((anchor) => anchor.dataset.refType !== 'doc').map((anchor) => `${anchor.dataset.refType}:${anchor.dataset.refId}`))];
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
      anchors[index]!.classList.remove('doc-task', 'doc-decision', 'doc-page');
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
    // Stage the local page icons independently of the work-row read and its retry. The portal
    // hosts exist after this DOM effect; a failed work read cannot delay an already resolved page.
    void Promise.resolve().then(() => { if (!gone) apply(new Map()); });
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
    marks: marks.map((mark) => createPortal(<RefMark mark={mark} owners={owners} />, mark.host, mark.key)),
  };
}

const DECISION_WORD = { accepted: 'Decision accepted', proposed: 'Decision proposed', superseded: 'Decision replaced' } as const;
const DECISION_GLYPH = { accepted: 'done', proposed: 'open', superseded: 'not_pursued' } as const;

function RefMark({ mark, owners }: { mark: Mark; owners: AgentOwners }) {
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
    </>
  );
}

/**
 * A smooth outline jump that stopped short lands on its heading (#752). WebKit can end a smooth scroll of the reading
 * pane early while the page is still settling after it opens: `scrollend` fired with the heading halfway down the page
 * and the reader stayed there. Unless the reader scrolled meanwhile (wheel, touch, a key or a pointer press), the end of
 * the motion puts the heading where it was asked to go. Returns how to stop watching.
 */
function landOn(scroller: HTMLElement, node: HTMLElement): () => void {
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  const stop = () => {
    scroller.removeEventListener('scrollend', land);
    for (const name of inputs) scroller.removeEventListener(name, stop);
  };
  function land() {
    stop();
    if (!node.isConnected) return;
    const off = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (parseFloat(getComputedStyle(node).scrollMarginTop) || 0);
    const top = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + off));
    if (Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTo({ top, behavior: 'auto' });
  }
  scroller.addEventListener('scrollend', land);
  for (const name of inputs) scroller.addEventListener(name, stop, { passive: true });
  return stop;
}

/**
 * "On this page": the page's headings; the one being read is marked, and each moves focus to its heading.
 * In a wide reading pane it is the sticky column beside the page; in a narrower one the page toolbar's
 * chip opens it as a list instead (#511, AC-3). It is never placed below the page.
 */
export function Outline({ headings, scroller, onOpen, list = false }: { headings: Heading[]; scroller: HTMLElement | null; onOpen?: () => void; list?: boolean }) {
  const [current, setCurrent] = useState<string | null>(null);
  const landing = useRef<() => void>(() => undefined);
  useEffect(() => () => landing.current(), []);
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
    const smooth = !prefersReducedMotion();
    landing.current();
    node.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    if (smooth && scroller?.contains(node)) landing.current = landOn(scroller, node);
    node.focus({ preventScroll: true });
    setCurrent(id);
    onOpen?.();
  };
  const base = Math.min(...headings.map((heading) => heading.level));
  const links = (
    <ul>
      {headings.map((heading) => (
        <li key={heading.id} data-level={heading.level - base}>
          <a href={`#${heading.id}`} aria-current={heading.id === current ? 'location' : undefined} onClick={(event) => open(event, heading.id)}>{heading.text}</a>
        </li>
      ))}
    </ul>
  );
  if (list) return <nav className="wiki-outline-pop" aria-label="On this page">{links}</nav>;
  return (
    <aside className="wiki-outline" aria-label="On this page">
      <p className="wiki-outline__h">On this page</p>
      {links}
    </aside>
  );
}

/** Whether the reading pane is wide enough for the outline's own column (the same 860px as the stylesheet's container). */
function useOutlineColumn(pane: HTMLElement | null) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (!pane) return undefined;
    // The observer reports the pane's size once it starts watching, and again whenever it changes.
    const observer = new ResizeObserver(() => setWide(pane.clientWidth > 860));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);
  return wide;
}

/**
 * The page toolbar's "On this page" slot (#511, AC-3, AC-4): always in the same place. In a pane too
 * narrow for the outline's column it opens the list below the toolbar; where the column is beside the
 * page, and in editing, history or a page of one heading, it is dimmed.
 */
export function OutlineChip({ headings, scroller }: { headings: Heading[] | null; scroller?: HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const column = useOutlineColumn(scroller ?? null);
  const active = !!headings && headings.length > 1 && !column;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="wiki-outline-chip" data-slot="outline" ref={wrap}>
      <button type="button" className="ui-btn ui-btn--quiet wiki-outline-chip__btn" aria-label="On this page" aria-expanded={active ? open : undefined}
        disabled={!active} data-tip={active ? 'On this page' : undefined} onClick={() => setOpen((value) => !value)}>
        <WikiIcon name="outline" />
        <span className="wiki-outline-chip__label">On this page <span aria-hidden="true">▾</span></span>
      </button>
      {open && active ? <Outline headings={headings!} scroller={scroller ?? null} list onOpen={() => setOpen(false)} /> : null}
    </div>
  );
}
