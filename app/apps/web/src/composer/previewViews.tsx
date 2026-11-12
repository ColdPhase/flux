import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../ui';
import { MessageText } from '../app/MessageText';
import { TABLE_COLUMNS, cellText, markdownChunk, type JsonErrorModel, type JsonModel, type MarkdownModel, type TableModel, type TextModel } from './previewParse';

// The text views of a file preview (C-60, #1252): plain text and source, pretty JSON and CSV/TSV tables. Only the lines or rows in view
// are in the DOM; everything is drawn as text by React, never as HTML.

const OVERSCAN = 24;
/** A table row can hold 200 cells, so a table draws fewer rows beyond the view than a text does lines. */
const TABLE_OVERSCAN = 6;

/** The scroller's size and scroll position, and the width and height of one monospace character inside it. */
function useScroller() {
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0, top: 0, char: 8, line: 20 });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      const glyph = probe.current?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setBox({ width, height: element.clientHeight, top: element.scrollTop, char: glyph?.width ? glyph.width / 10 : 8, line: glyph?.height || 20 });
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setBox((old) => ({ ...old, top: element.scrollTop })); }); };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });
    void document.fonts?.ready.then(read);
    return () => { observer.disconnect(); element.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);
  return { scroller, probe, box };
}

/** The first index whose start is past `y` in `prefix` (heights summed), minus one: the item at `y`. */
function at(prefix: Float64Array, y: number) {
  let low = 0;
  let high = prefix.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (prefix[mid]! <= y) low = mid; else high = mid - 1; }
  return Math.min(low, Math.max(0, prefix.length - 2));
}

/**
 * Lines that wrap, of which only those in view are drawn. Each line's height is known before it is drawn: monospace text that breaks
 * anywhere takes ceil(columns / width) rows, so the scroll height is right for millions of characters without measuring them.
 */
function WrappedLines({ count, columnsOf, indentOf = () => 0, gutter = 0, render, label }: {
  count: number; columnsOf: (index: number) => number; indentOf?: (index: number) => number; gutter?: number; render: (index: number) => ReactNode; label: string;
}) {
  const { scroller, probe, box } = useScroller();
  const width = Math.max(20, Math.floor(box.width / box.char) - gutter);
  const prefix = useMemo(() => {
    const sums = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      const room = Math.max(20, width - indentOf(i));
      sums[i + 1] = sums[i]! + Math.max(1, Math.ceil(columnsOf(i) / room)) * box.line;
    }
    return sums;
  }, [count, width, box.line, columnsOf, indentOf]);
  const first = Math.max(0, at(prefix, box.top) - OVERSCAN);
  const last = Math.min(count, at(prefix, box.top + box.height) + 1 + OVERSCAN);
  const lines: ReactNode[] = [];
  for (let i = first; i < last; i++) lines.push(render(i));
  const style = { paddingTop: prefix[first], paddingBottom: prefix[count]! - prefix[last]!, '--line': `${box.line}px`, '--gutter': `${gutter}ch` } as CSSProperties;
  return (
    <div ref={scroller} className="file-viewer__scroll file-viewer__mono" tabIndex={0} role="region" aria-label={label}>
      <span ref={probe} className="file-viewer__probe" aria-hidden="true">0000000000</span>
      <div className="file-viewer__lines" style={style}>{lines}</div>
    </div>
  );
}

const slice = (model: { text: string; starts: Uint32Array; ends: Uint32Array }, index: number) => model.text.slice(model.starts[index], model.ends[index]);
const digits = (count: number) => String(count).length + 1;

/** Plain text, logs and source: wrapped monospace, line numbers when asked. */
export function TextView({ model, numbers, label }: { model: TextModel; numbers: boolean; label: string }) {
  const gutter = numbers ? digits(model.starts.length) + 1 : 0;
  const columnsOf = useCallback((index: number) => model.columns[index]!, [model]);
  return <WrappedLines count={model.starts.length} columnsOf={columnsOf} gutter={gutter} label={label} render={(index) => (
    <div key={index} className="file-viewer__line" data-line={index + 1}>
      {numbers ? <span className="file-viewer__num" aria-hidden="true">{index + 1}</span> : null}<span className="file-viewer__text">{slice(model, index)}</span>
    </div>
  )} />;
}

/** JSON that does not parse: the parse error's line first, then the text as written with line numbers. */
export function JsonErrorView({ model, label }: { model: JsonErrorModel; label: string }) {
  return <div className="file-viewer__split">
    <p className="file-viewer__error" role="alert">Not valid JSON: line {model.line}, column {model.column}: {model.message}.</p>
    <TextView model={model.lines} numbers label={label} />
  </div>;
}

/** Pretty JSON; each object and array folds. A large file starts folded below the second level. */
export function JsonView({ model, label }: { model: JsonModel; label: string }) {
  const count = model.starts.length;
  const [folded, setFolded] = useState(() => {
    const start = new Uint8Array(count);
    if (count > 5000) for (let i = 0; i < count; i++) if (model.close[i]! > i && model.depth[i]! >= 2) start[i] = 1;
    return start;
  });
  // The lines in view after folding: a folded line stands for everything up to its closing line.
  const shown = useMemo(() => {
    const out = new Uint32Array(count);
    let n = 0;
    for (let i = 0; i < count;) { out[n++] = i; i = folded[i] ? model.close[i]! + 1 : i + 1; }
    return out.subarray(0, n);
  }, [count, folded, model]);
  const textOf = useCallback((line: number) => {
    const text = slice(model, line);
    if (!folded[line]) return text;
    const items = model.items[line]!;
    return `${text} … ${items} ${items === 1 ? 'item' : 'items'} ${slice(model, model.close[line]!)}`;
  }, [folded, model]);
  const columnsOf = useCallback((index: number) => textOf(shown[index]!).length, [shown, textOf]);
  const indentOf = useCallback((index: number) => 2 * (model.depth[shown[index]!]! + 1), [shown, model]);
  const toggle = (line: number) => setFolded((old) => { const next = old.slice(); next[line] = next[line] ? 0 : 1; return next; });
  return <WrappedLines count={shown.length} columnsOf={columnsOf} indentOf={indentOf} label={label} render={(index) => {
    const line = shown[index]!;
    const opens = model.close[line]! > line;
    return (
      <div key={line} className="file-viewer__line file-viewer__json" style={{ '--depth': model.depth[line] } as CSSProperties} data-line={line + 1}>
        {opens ? <button type="button" className="file-viewer__fold" onClick={() => toggle(line)} aria-expanded={!folded[line]} aria-label={folded[line] ? 'Unfold' : 'Fold'}>
          <Icon name={folded[line] ? 'chevron-right' : 'chevron-down'} size={12} /></button> : null}
        <span className="file-viewer__text">{textOf(line)}</span>
      </div>
    );
  }} />;
}

const CELL_CHARS = 1000;

/** CSV/TSV: every row, the header sticky; a cell is always text, so `=SUM(A1)` is shown as written and never computed. */
export function TableView({ model, label }: { model: TableModel; label: string }) {
  const { scroller, probe, box } = useScroller();
  const rows = model.rowStart.length - 1;
  const height = Math.round(box.line + 12);
  const first = Math.max(1, Math.floor(box.top / height) + 1 - TABLE_OVERSCAN);
  const last = Math.min(rows, Math.ceil((box.top + box.height) / height) + 1 + TABLE_OVERSCAN);
  const shown = Math.min(model.columns, TABLE_COLUMNS);
  const template = Array.from(model.widths.subarray(0, shown), (width) => `${width + 3}ch`).join(' ');
  const row = (r: number, header = false) => {
    const cells: ReactNode[] = [];
    for (let col = 0; col < shown; col++) {
      const cell = model.rowStart[r]! + col;
      const full = cell < model.rowStart[r + 1]! ? cellText(model, cell) : '';
      // A cell is one line that ends in an ellipsis: a megabyte in one cell would only cost layout.
      const value = full.length > CELL_CHARS ? `${full.slice(0, CELL_CHARS)}…` : full;
      cells.push(<div key={col} role={header ? 'columnheader' : 'cell'} className={`file-viewer__cell${model.numeric[col] ? (header ? ' is-end' : ' is-number') : ''}`}
        title={value.length > model.widths[col]! ? value : undefined}>{value}</div>);
    }
    return <div key={r} role="row" aria-rowindex={r + 1} className={`file-viewer__row${header ? ' is-header' : ''}`}>{cells}</div>;
  };
  const body: ReactNode[] = [];
  for (let r = first; r < last; r++) body.push(row(r));
  return (
    <div ref={scroller} className="file-viewer__scroll file-viewer__table-scroll" tabIndex={0} role="table" aria-label={label} aria-rowcount={rows} aria-colcount={model.columns}
      style={{ '--cols': template, '--row': `${height}px` } as CSSProperties}>
      <span ref={probe} className="file-viewer__probe" aria-hidden="true">0000000000</span>
      {rows ? <div role="rowgroup" className="file-viewer__head">{row(0, true)}</div> : null}
      <div role="rowgroup" style={{ paddingTop: (first - 1) * height, paddingBottom: Math.max(0, rows - last) * height }}>{body}</div>
    </div>
  );
}

/** The note for a table wider than {@link TABLE_COLUMNS} columns, or null. */
export const hiddenColumns = (model: TableModel) => model.columns > TABLE_COLUMNS
  ? `Showing the first ${TABLE_COLUMNS} of ${model.columns.toLocaleString('en-GB')} columns. Download to see them all.` : null;

/** The number of data rows, for the note under a table. */
export const tableRows = (model: TableModel) => Math.max(0, model.rowStart.length - 2);

/**
 * Markdown drawn by the message renderer (#1247): bold, italic, code, lists and quotes; a web address is a link that opens a new tab with
 * `noopener`; an image or HTML stays as typed, so nothing loads. Chunks out of view are empty boxes of their last height.
 */
/** A chunk's rows before it is drawn: its lines, or its characters over a reading line (a 4,000-character line is many rows). */
const estimatedRows = (model: MarkdownModel, index: number) => Math.max(model.lines[index]!, Math.ceil((model.ends[index]! - model.starts[index]!) / 120));

export function MarkdownView({ model, label }: { model: MarkdownModel; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = model.starts.length;
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set(Array.from({ length: Math.min(count, 3) }, (_, i) => i)));
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const sized = new ResizeObserver((entries) => setHeights((old) => {
      let next: Map<number, number> | null = null;
      for (const entry of entries) {
        const chunk = entry.target as HTMLElement;
        const index = Number(chunk.dataset.chunk);
        if (chunk.dataset.drawn !== 'true' || old.get(index) === chunk.offsetHeight) continue;
        next ??= new Map(old);
        next.set(index, chunk.offsetHeight);
      }
      return next ?? old;
    }));
    const near = new IntersectionObserver((entries) => setShown((old) => {
      const next = new Set(old);
      for (const entry of entries) { const index = Number((entry.target as HTMLElement).dataset.chunk); if (entry.isIntersecting) next.add(index); else next.delete(index); }
      return next;
    }), { root, rootMargin: '1200px 0px' });
    for (const chunk of root.querySelectorAll<HTMLElement>('[data-chunk]')) { near.observe(chunk); sized.observe(chunk); }
    return () => { near.disconnect(); sized.disconnect(); };
  }, [count]);
  const chunks: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const drawn = shown.has(i);
    chunks.push(<div key={i} data-chunk={i} data-drawn={drawn} className="message-body file-viewer__chunk"
      style={drawn ? undefined : { height: heights.get(i) ?? `calc(${estimatedRows(model, i)} * var(--fs-base) * var(--lh))` }}>
      {drawn ? <MessageText body={markdownChunk(model, i)} /> : null}
    </div>);
  }
  return <div ref={scroller} className="file-viewer__scroll file-viewer__markdown" tabIndex={0} role="region" aria-label={label}>{chunks}</div>;
}
