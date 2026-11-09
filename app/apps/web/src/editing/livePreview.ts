import { Autolink, Strikethrough, Table, parser as commonMark } from '@lezer/markdown';
import { TreeFragment, type ChangedRange, type Input, type SyntaxNode, type Tree } from '@lezer/common';
import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { DocMention, NativeWorkRow } from '@flux/contracts';

// The Wiki page edited where it is read (#869). The text stays Markdown, the one shared Y.Text that live co-editing,
// import, export and the saved versions use; this extension only draws it as the page. Headings, emphasis, lists,
// quotes, code, rules, links and tables look as they read, and the marks that make them appear on the line (or inside
// the span) where the caret is, so they can be changed by typing. A reference to a task, decision or page is the same
// chip or card the reader shows. Nothing here changes the text.

const markdown = commonMark.configure([Table, Strikethrough, Autolink]);

/** The editor's text as the parser reads it, without copying the whole document. */
class TextInput implements Input {
  constructor(private readonly text: Text) {}
  get length() { return this.text.length; }
  get lineChunks() { return false; }
  chunk(from: number) { return this.text.sliceString(from, Math.min(this.text.length, from + 4096)); }
  read(from: number, to: number) { return this.text.sliceString(from, to); }
}

interface Parsed { tree: Tree; fragments: readonly TreeFragment[] }
function parse(doc: Text, fragments: readonly TreeFragment[] = []): Parsed {
  const tree = markdown.parse(new TextInput(doc), fragments);
  return { tree, fragments: TreeFragment.addTree(tree) };
}
/** The Markdown tree of the text, parsed again only around a change. */
const syntax = StateField.define<Parsed>({
  create: (state) => parse(state.doc),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const changed: ChangedRange[] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => { changed.push({ fromA, toA, fromB, toB }); });
    return parse(transaction.newDoc, TreeFragment.applyChanges(value.fragments, changed));
  },
});
export const markdownTree = (state: EditorState) => state.field(syntax).tree;

const setFocus = StateEffect.define<boolean>();
/** Marks show only while the person is writing here: an editor without focus is the page as it reads. */
const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => transaction.effects.reduce((current, effect) => (effect.is(setFocus) ? effect.value : current), value),
});

/** What the references in the text lead to: tasks and decisions as the reader sees them now, and the server's mentions. */
export interface RefData { rows: ReadonlyMap<string, NativeWorkRow>; read: boolean; mentions: ReadonlyMap<string, DocMention> }
export const setRefData = StateEffect.define<RefData>();
const refData = StateField.define<RefData>({
  create: () => ({ rows: new Map(), read: false, mentions: new Map() }),
  update: (value, transaction) => transaction.effects.reduce((current, effect) => (effect.is(setRefData) ? effect.value : current), value),
});

/** A reference's chip or card is drawn by React (the reader's own marks); the widget gives it a place. */
export type RefMarkSpec = { kind: 'glyph' | 'word'; row: NativeWorkRow } | { kind: 'decision'; row: NativeWorkRow } | { kind: 'page' };
export class RefHosts {
  private hosts = new Map<HTMLElement, { key: string; mark: RefMarkSpec }>();
  private listeners = new Set<() => void>();
  private snapshot: { key: string; host: HTMLElement; mark: RefMarkSpec }[] = [];
  private next = 0;
  add(host: HTMLElement, mark: RefMarkSpec) { this.hosts.set(host, { key: `r${this.next++}`, mark }); this.emit(); }
  remove(host: HTMLElement) { if (this.hosts.delete(host)) this.emit(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.snapshot;
  private emit() {
    this.snapshot = [...this.hosts].map(([host, value]) => ({ host, ...value }));
    for (const listener of this.listeners) listener();
  }
}

const REF = /^flux:(doc|work|decision|result|message|thought|sketch)\/([0-9a-f-]{36})$/i;
const KIND_WORD: Record<string, string> = { decision: 'Decision', work: 'Task', doc: 'Wiki page', message: 'Message', thought: 'Thought', sketch: 'Map' };

/** The reference's target while its line is written: the label stays text, the target reads as its kind (CW-4). */
class KindWord extends WidgetType {
  constructor(readonly word: string) { super(); }
  eq(other: KindWord) { return other.word === this.word; }
  toDOM() { const span = document.createElement('span'); span.className = 'editing-ref'; span.textContent = this.word; span.setAttribute('aria-label', `(${this.word})`); return span; }
  ignoreEvent() { return false; }
}

interface RefTarget { type: string; id: string; label: string; card: boolean }
/** A reference as the page shows it: a task chip, a page chip, a decision card, or the plain link the server would write. */
class RefChip extends WidgetType {
  constructor(readonly target: RefTarget, readonly row: NativeWorkRow | undefined, readonly mention: DocMention | undefined, readonly missing: boolean, readonly hosts: RefHosts) { super(); }
  eq(other: RefChip) {
    return other.target.type === this.target.type && other.target.id === this.target.id && other.target.label === this.target.label && other.target.card === this.target.card
      && other.row === this.row && other.mention?.path === this.mention?.path && other.missing === this.missing;
  }
  toDOM() {
    const { type, id, label, card } = this.target;
    if (this.missing) {
      const span = document.createElement('span');
      span.className = 'doc-ref doc-ref--missing';
      span.textContent = label;
      return span;
    }
    const link = document.createElement('a');
    link.className = 'doc-ref';
    link.dataset.refType = type; link.dataset.refId = id;
    const path = this.mention?.path;
    if (path) link.href = path;
    const host = (className: string, at: 'start' | 'end', mark: RefMarkSpec) => {
      const span = document.createElement('span');
      span.className = className;
      if (at === 'start') link.prepend(span); else link.append(span);
      this.hosts.add(span, mark);
    };
    if (this.row?.kind === 'work') {
      link.classList.add('doc-task');
      link.textContent = label;
      host('doc-task__mark', 'start', { kind: 'glyph', row: this.row });
      host('doc-task__word', 'end', { kind: 'word', row: this.row });
    } else if (this.row?.kind === 'decision' && card) {
      link.classList.add('doc-decision');
      link.setAttribute('aria-label', label);
      host('doc-decision__body', 'start', { kind: 'decision', row: this.row });
    } else if (type === 'doc') {
      link.classList.add('doc-page');
      link.textContent = label;
      host('doc-page__icon', 'start', { kind: 'page' });
    } else link.textContent = label;
    return link;
  }
  destroy(dom: HTMLElement) { for (const span of dom.querySelectorAll('span')) this.hosts.remove(span); }
  /** A click opens the reference (the page handles it); the keyboard reaches its text by moving onto its line. */
  ignoreEvent() { return true; }
}

class Bullet extends WidgetType {
  constructor(readonly ordinal: string | null) { super(); }
  eq(other: Bullet) { return other.ordinal === this.ordinal; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.ordinal ?? '•';
    return span;
  }
}

class Rule extends WidgetType {
  eq() { return true; }
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-rule'; span.setAttribute('role', 'separator'); return span; }
}

/** A table outside the caret reads as the reader's table card; a click puts the caret into its text. */
class TableCard extends WidgetType {
  constructor(readonly rows: string[][], readonly align: string[], readonly from: number) { super(); }
  eq(other: TableCard) { return JSON.stringify(other.rows) === JSON.stringify(this.rows) && other.align.join() === this.align.join(); }
  toDOM(view: EditorView) {
    const region = document.createElement('div');
    region.className = 'doc-table cm-md-table-card';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Table');
    region.tabIndex = 0;
    const table = document.createElement('table');
    this.rows.forEach((cells, index) => {
      const row = document.createElement('tr');
      cells.forEach((text, column) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        cell.textContent = text;
        if (this.align[column]) cell.style.textAlign = this.align[column]!;
        row.append(cell);
      });
      if (index === 0) table.createTHead().append(row);
      else (table.tBodies[0] ?? table.createTBody()).append(row);
    });
    region.append(table);
    const edit = (event: Event) => {
      if (!view.state.facet(EditorView.editable)) return;
      event.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(this.from, view.state.doc.length) } });
    };
    region.addEventListener('mousedown', edit);
    region.addEventListener('keydown', (event) => { if (event.key === 'Enter') edit(event); });
    return region;
  }
  ignoreEvent() { return true; }
}

function cellText(state: EditorState, cell: SyntaxNode) {
  return state.doc.sliceString(cell.from, cell.to).replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1').trim();
}

/** Whether a selection range touches [from, to] while the person writes here. */
function touches(state: EditorState, from: number, to: number) {
  if (!state.field(focused)) return false;
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}
function lineTouched(state: EditorState, position: number) {
  const line = state.doc.lineAt(position);
  return touches(state, line.from, line.to);
}

/** Tables are blocks across lines, so they come from the state (CodeMirror draws block replacements only from a field). */
const tables = StateField.define<DecorationSet>({
  create: (state) => tableCards(state),
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection || transaction.effects.some((effect) => effect.is(setFocus))) return tableCards(transaction.state);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
function tableCards(state: EditorState): DecorationSet {
  const found: Range<Decoration>[] = [];
  const tree = state.field(syntax).tree;
  tree.iterate({
    enter(node) {
      if (node.name !== 'Table') return node.name === 'Document' || node.name === 'Blockquote' || node.name === 'ListItem' || node.name.endsWith('List');
      if (touches(state, node.from, node.to)) return false;
      const rows: string[][] = [];
      let align: string[] = [];
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'TableHeader' || child.name === 'TableRow') {
          const cells: string[] = [];
          for (let cell = child.firstChild; cell; cell = cell.nextSibling) if (cell.name === 'TableCell') cells.push(cellText(state, cell));
          rows.push(cells);
        } else if (child.name === 'TableDelimiter' && state.doc.lineAt(child.from).from === child.from) {
          align = state.doc.sliceString(child.from, child.to).split('|').map((part) => part.trim()).filter(Boolean)
            .map((part) => (part.startsWith(':') && part.endsWith(':') ? 'center' : part.endsWith(':') ? 'right' : part.startsWith(':') ? 'left' : ''));
        }
      }
      const from = state.doc.lineAt(node.from).from, to = state.doc.lineAt(node.to).to;
      found.push(Decoration.replace({ widget: new TableCard(rows, align, from), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(found, true);
}

const HEADINGS: Record<string, number> = { ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 4, ATXHeading6: 4, SetextHeading1: 1, SetextHeading2: 2 };
const INLINE: Record<string, string> = { Emphasis: 'cm-md-em', StrongEmphasis: 'cm-md-strong', Strikethrough: 'cm-md-s', InlineCode: 'cm-md-code' };
const MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

function build(view: EditorView, hosts: RefHosts): { all: DecorationSet; atomic: DecorationSet } {
  const { state } = view;
  const tree = state.field(syntax).tree;
  const refs = state.field(refData);
  const all: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const lineClass = (position: number, className: string, style?: string) => {
    all.push(Decoration.line({ class: className, ...(style ? { attributes: { style } } : {}) }).range(state.doc.lineAt(position).from));
  };
  const hide = (from: number, to: number) => { if (to > from) all.push(Decoration.replace({}).range(from, to)); };
  const spaceAfter = (to: number) => (/[ \t]/.test(state.doc.sliceString(to, to + 1)) ? to + 1 : to);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const name = node.name;
        const level = HEADINGS[name];
        if (level) {
          for (let line = state.doc.lineAt(node.from); ; line = state.doc.line(line.number + 1)) {
            lineClass(line.from, `cm-md-h cm-md-h${level}`);
            if (line.to >= node.to || line.number >= state.doc.lines) break;
          }
          return true;
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent;
          if (parent?.name.startsWith('Setext')) { lineClass(node.from, 'cm-md-setext'); return false; }
          if (!lineTouched(state, node.from)) {
            // The opening marks and their space; a closing sequence with the space before it.
            if (parent && node.from === parent.from) hide(node.from, spaceAfter(node.to));
            else hide(/[ \t]/.test(state.doc.sliceString(node.from - 1, node.from)) ? node.from - 1 : node.from, node.to);
          }
          return false;
        }
        const inline = INLINE[name];
        if (inline) {
          all.push(Decoration.mark({ class: inline }).range(node.from, node.to));
          if (!touches(state, node.from, node.to)) {
            for (let child = node.node.firstChild; child; child = child.nextSibling) if (MARKS.has(child.name)) hide(child.from, child.to);
          }
          return name !== 'InlineCode';
        }
        if (name === 'Link') { link(node.node); return false; }
        if (name === 'Autolink') {
          all.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));
          if (!touches(state, node.from, node.to)) { hide(node.from, node.from + 1); hide(node.to - 1, node.to); }
          return false;
        }
        if (name === 'URL') { all.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to)); return false; }
        if (name === 'Escape') { if (!touches(state, node.from, node.to)) hide(node.from, node.from + 1); return false; }
        if (name === 'Blockquote') {
          for (let line = state.doc.lineAt(node.from); ; line = state.doc.line(line.number + 1)) {
            lineClass(line.from, 'cm-md-quote');
            if (line.to >= node.to || line.number >= state.doc.lines) break;
          }
          return true;
        }
        if (name === 'QuoteMark') { if (!lineTouched(state, node.from)) hide(node.from, spaceAfter(node.to)); return false; }
        if (name === 'ListMark') {
          const item = node.node.parent;
          let depth = 0;
          for (let up = item; up; up = up.parent) if (up.name === 'ListItem') depth++;
          const line = state.doc.lineAt(node.from);
          const ordered = item?.parent?.name === 'OrderedList';
          lineClass(line.from, 'cm-md-li', `--md-depth:${depth}`);
          if (!lineTouched(state, node.from) && /^\s*$/.test(state.doc.sliceString(line.from, node.from))) {
            all.push(Decoration.replace({ widget: new Bullet(ordered ? state.doc.sliceString(node.from, node.to) : null) }).range(line.from, spaceAfter(node.to)));
          }
          return false;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
          for (let number = first.number; number <= last.number; number++) {
            const line = state.doc.line(number);
            const edge = name === 'FencedCode' && (number === first.number || (number === last.number && /^\s*(`{3,}|~{3,})\s*$/.test(line.text)));
            // The fences read as the block's edges until the caret is on them.
            const quiet = edge && !lineTouched(state, line.from);
            lineClass(line.from, `cm-md-pre${number === first.number ? ' cm-md-pre--first' : ''}${number === last.number ? ' cm-md-pre--last' : ''}${edge ? ' cm-md-fence' : ''}${quiet ? ' cm-md-fence--quiet' : ''}`);
            if (quiet) hide(line.from, line.to);
          }
          return false;
        }
        if (name === 'HorizontalRule') {
          lineClass(node.from, 'cm-md-hr');
          if (!lineTouched(state, node.from)) all.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to));
          return false;
        }
        if (name === 'Table') {
          // Drawn as a card by the field above while the caret is outside; written, it is its monospace text.
          if (touches(state, node.from, node.to)) {
            for (let line = state.doc.lineAt(node.from); ; line = state.doc.line(line.number + 1)) {
              lineClass(line.from, 'cm-md-table');
              if (line.to >= node.to || line.number >= state.doc.lines) break;
            }
          }
          return false;
        }
        if (name === 'HTMLBlock' || name === 'HTMLTag' || name === 'Image' || name === 'Comment' || name === 'CommentBlock') return false;
        return true;
      },
    });
  }

  function link(node: SyntaxNode) {
    const marks: SyntaxNode[] = [];
    let url: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'LinkMark') marks.push(child);
      else if (child.name === 'URL') url = child;
    }
    const open = marks[0], close = marks[1];
    if (!open || !close || open.from !== node.from) return;
    const href = url ? state.doc.sliceString(url.from, url.to) : '';
    const ref = REF.exec(href);
    const active = touches(state, node.from, node.to);
    if (ref) {
      const type = ref[1]!.toLowerCase(), id = ref[2]!.toLowerCase();
      if (active) {
        // The label is text; its target is one unit that reads as its kind.
        const target = Decoration.replace({ widget: new KindWord(cardLine(node) && type === 'decision' ? 'Decision card' : KIND_WORD[type] ?? 'Link') });
        all.push(target.range(close.to, node.to)); atomic.push(target.range(close.to, node.to));
        return;
      }
      const key = `${type}:${id}`;
      const row = refs.rows.get(key);
      const mention = refs.mentions.get(key);
      const missing = (type === 'work' || type === 'decision') ? refs.read && !row : !!mention && !mention.path;
      const label = state.doc.sliceString(open.to, close.from).replace(/\\(.)/g, '$1');
      const card = type === 'decision' && cardLine(node);
      if (card) lineClass(node.from, 'cm-md-card');
      const chip = Decoration.replace({ widget: new RefChip({ type, id, label, card }, row, mention, missing, hosts) });
      all.push(chip.range(node.from, node.to)); atomic.push(chip.range(node.from, node.to));
      return;
    }
    all.push(Decoration.mark({ class: 'cm-md-link', attributes: href ? { title: href } : {} }).range(open.to, close.from));
    if (!active) { hide(open.from, open.to); hide(close.from, node.to); }
    else all.push(Decoration.mark({ class: 'cm-md-mark' }).range(close.from, node.to));
  }
  /** A decision alone on its line is a card (F-034), as the reader draws it. */
  function cardLine(node: SyntaxNode) {
    const line = state.doc.lineAt(node.from);
    return line.text.trim() === state.doc.sliceString(node.from, node.to).trim() && node.parent?.name === 'Paragraph';
  }
  return { all: Decoration.set(all, true), atomic: Decoration.set(atomic, true) };
}

function preview(hosts: RefHosts) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    atomic: DecorationSet;
    constructor(view: EditorView) { ({ all: this.decorations, atomic: this.atomic } = build(view, hosts)); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || update.startState.field(refData) !== update.state.field(refData) || update.startState.field(focused) !== update.state.field(focused)) {
        ({ all: this.decorations, atomic: this.atomic } = build(update.view, hosts));
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  });
}

/**
 * The Markdown of the page drawn as the page. `hosts` receives the places of the reference chips and cards, which the
 * page fills with the reader's own marks.
 */
export function livePreview(hosts: RefHosts): Extension {
  return [
    syntax, focused, refData, tables, preview(hosts),
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
  ];
}

export interface Heading { id: string; text: string; level: number; at: number }
/** The page's headings (levels 1–3), for Contents. */
export function headingsOf(state: EditorState): Heading[] {
  const found: Heading[] = [];
  const tree = state.field(syntax, false)?.tree;
  if (!tree) return found;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const level = HEADINGS[node.name];
    if (!level || level > 3) continue;
    let text = '';
    for (let line = state.doc.lineAt(node.from); ; line = state.doc.line(line.number + 1)) {
      const body = node.name.startsWith('Setext') && line.to >= node.to && line.from !== state.doc.lineAt(node.from).from ? '' : line.text;
      text += `${text && body ? ' ' : ''}${body}`;
      if (line.to >= node.to || line.number >= state.doc.lines) break;
    }
    text = text.replace(/^\s*#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();
    if (text) found.push({ id: `section-${found.length + 1}`, text, level, at: node.from });
  }
  return found;
}

/** The `flux:` references of the text whose state the page reads: tasks and decisions. */
export function workRefs(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\]\(flux:(work|decision)\/([0-9a-f-]{36})\)/gi)) found.add(`${match[1]!.toLowerCase()}:${match[2]!.toLowerCase()}`);
  return [...found];
}
