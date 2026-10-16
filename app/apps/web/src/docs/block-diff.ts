import { diffWordsWithSpace } from 'diff';

// The rendered comparison of two versions (#511, AC-1): the page as it reads, in its own typography.
// The top-level blocks of both versions' sanitized HTML are aligned; a block that is only in the newer
// version is added, one only in the older is removed. A changed block of the same kind keeps its
// structure and marks the words: added words as <ins>, removed words as <del> where they stood. Lists
// and tables are compared item by item and row by row, so one changed cell does not replace a table.
// The output is built from the server's sanitized nodes and text only; nothing is parsed as markup.

export type BlockKind = 'same' | 'added' | 'removed' | 'changed';
export interface BlockOp { kind: BlockKind; html: string }

/** Above this many pairs a full alignment is too costly; the comparison falls back to remove-all, add-all. */
const MAX_PAIRS = 250_000;
/** Below this share of words in common, two blocks read better as one removed and one added. */
const MIN_COMMON = 0.3;
/** Elements whose children are blocks of their own (compared one by one). */
const CONTAINERS = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'BLOCKQUOTE']);

function childrenOf(html: string): Element[] {
  if (!html.trim()) return [];
  return [...new DOMParser().parseFromString(html, 'text/html').body.children];
}

function marked(node: Element, kind: 'added' | 'removed'): Element {
  const copy = node.cloneNode(true) as Element;
  copy.classList.add('wiki-chg', `wiki-chg--${kind}`);
  return copy;
}

/** Longest common subsequence of two key lists, as aligned operations. */
function align<T>(before: T[], after: T[], key: (item: T) => string): { kind: 'same' | 'added' | 'removed'; a?: T; b?: T }[] {
  const keysA = before.map(key);
  const keysB = after.map(key);
  const n = keysA.length;
  const m = keysB.length;
  if (n * m > MAX_PAIRS) return [...before.map((a) => ({ kind: 'removed' as const, a })), ...after.map((b) => ({ kind: 'added' as const, b }))];
  const lengths = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] = keysA[i] === keysB[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const ops: { kind: 'same' | 'added' | 'removed'; a?: T; b?: T }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keysA[i] === keysB[j]) ops.push({ kind: 'same', a: before[i++], b: after[j++] });
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) ops.push({ kind: 'removed', a: before[i++] });
    else ops.push({ kind: 'added', b: after[j++] });
  }
  while (i < n) ops.push({ kind: 'removed', a: before[i++] });
  while (j < m) ops.push({ kind: 'added', b: after[j++] });
  return ops;
}

/** The text nodes that carry the block's words (whitespace between structural children is layout, not text). */
function textNodes(root: Element): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.trim() && text.parentElement && (CONTAINERS.has(text.parentElement.tagName) || text.parentElement.tagName === 'TR')) continue;
    nodes.push(text);
  }
  return nodes;
}

interface Change { value: string; added?: boolean; removed?: boolean }

/**
 * A run of changed words reads as one phrase: spaces between two changes join them, so "Two sensors
 * reached the gateway" is one added phrase, not five words with gaps between their marks.
 */
function phrases(changes: Change[]): Change[] {
  const out: Change[] = [];
  let run: { removed: string; added: string; space: string } | null = null;
  const close = () => {
    if (!run) return;
    if (run.removed) out.push({ value: run.removed, removed: true });
    if (run.added) out.push({ value: run.added, added: true });
    if (run.space) out.push({ value: run.space });
    run = null;
  };
  for (const change of changes) {
    if (change.added || change.removed) {
      run ??= { removed: '', added: '', space: '' };
      if (run.space) { run.removed += run.space; run.added += run.space; run.space = ''; }
      if (change.removed) run.removed += change.value; else run.added += change.value;
    } else if (run && !change.value.trim()) run.space += change.value;
    else { close(); out.push(change); }
  }
  close();
  return out;
}

/**
 * The newer block with its added words wrapped in <ins> and the removed words put back as <del> where
 * they stood. Null when the two share too little to read as one changed block.
 */
function wordMerge(before: Element, after: Element): Element | null {
  const result = after.cloneNode(true) as Element;
  const nodes = textNodes(result);
  const oldText = textNodes(before).map((node) => node.data).join('');
  const newText = nodes.map((node) => node.data).join('');
  const changes = phrases(diffWordsWithSpace(oldText, newText));
  const common = changes.filter((change) => !change.added && !change.removed && change.value.trim()).reduce((total, change) => total + change.value.length, 0);
  const longest = Math.max(oldText.replace(/\s+/g, '').length, newText.replace(/\s+/g, '').length);
  if (!longest || common / longest < MIN_COMMON) return null;
  // Positions in the newer text: added ranges (without their edge spaces), and removed runs inserted at an offset.
  const added: [number, number][] = [];
  const removed: { at: number; text: string }[] = [];
  let at = 0;
  for (const change of changes) {
    const text = change.value.trim();
    if (change.removed) { if (text) removed.push({ at, text }); continue; }
    if (change.added && text) {
      const lead = change.value.length - change.value.trimStart().length;
      added.push([at + lead, at + lead + text.length]);
    }
    at += change.value.length;
  }
  const doc = result.ownerDocument;
  const del = (text: string) => { const node = doc.createElement('del'); node.textContent = text; return node; };
  let start = 0;
  nodes.forEach((node, index) => {
    const end = start + node.data.length;
    const last = index === nodes.length - 1;
    // A removed run at a node's edge belongs to the node that starts there, or to the last node.
    const owns = (offset: number) => offset >= start && (offset < end || (last && offset === end));
    const cuts = new Set<number>([start, end]);
    for (const [from, to] of added) { if (from > start && from < end) cuts.add(from); if (to > start && to < end) cuts.add(to); }
    for (const run of removed) if (owns(run.at)) cuts.add(run.at);
    const points = [...cuts].sort((a, b) => a - b);
    const parts: Node[] = [];
    const removedAt = (offset: number) => { for (const run of removed) if (run.at === offset && owns(offset)) parts.push(del(run.text)); };
    for (let k = 0; k < points.length - 1; k++) {
      const from = points[k]!;
      const to = points[k + 1]!;
      removedAt(from);
      const text = node.data.slice(from - start, to - start);
      if (added.some(([a, b]) => from >= a && to <= b)) {
        const ins = doc.createElement('ins');
        ins.textContent = text;
        // Removed words then added words read as two phrases, not one run-on word.
        if (parts[parts.length - 1]?.nodeName === 'DEL') parts.push(doc.createTextNode(' '));
        parts.push(ins);
      } else parts.push(doc.createTextNode(text));
    }
    if (last) removedAt(end);
    node.replaceWith(...parts);
    start = end;
  });
  // A block whose text was empty has nowhere to hold removed words: put them at its end.
  if (!nodes.length) for (const run of removed) result.append(del(run.text));
  return result;
}

/** One changed block pair: compared item by item, cell by cell or word by word. */
function merge(before: Element, after: Element): Element[] {
  if (CONTAINERS.has(after.tagName)) {
    const shell = after.cloneNode(false) as Element;
    shell.append(...diffBlocks([...before.children], [...after.children]));
    return [shell];
  }
  if (after.tagName === 'TR') {
    if (before.children.length !== after.children.length) return [marked(before, 'removed'), marked(after, 'added')];
    const row = after.cloneNode(false) as Element;
    [...after.children].forEach((cell, index) => {
      const old = before.children[index]!;
      row.append(old.outerHTML === cell.outerHTML ? cell.cloneNode(true) : wordMerge(old, cell) ?? markedCell(old, cell));
    });
    return [row];
  }
  const words = wordMerge(before, after);
  return words ? [words] : [marked(before, 'removed'), marked(after, 'added')];
}

/** A cell rewritten completely: its old text struck, then its new text. */
function markedCell(before: Element, after: Element): Element {
  const cell = after.cloneNode(false) as Element;
  const del = cell.ownerDocument.createElement('del');
  del.textContent = before.textContent ?? '';
  const ins = cell.ownerDocument.createElement('ins');
  ins.textContent = after.textContent ?? '';
  cell.append(del, ' ', ins);
  return cell;
}

function diffBlocks(before: Element[], after: Element[]): Element[] {
  const out: Element[] = [];
  const ops = align(before, after, (node) => node.outerHTML);
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    if (op.kind === 'same') { out.push(op.b!.cloneNode(true) as Element); index++; continue; }
    // A run of removed and added blocks: pair blocks of the same kind in order.
    const removed: Element[] = [];
    const addedBlocks: Element[] = [];
    while (index < ops.length && ops[index]!.kind !== 'same') {
      const item = ops[index++]!;
      if (item.kind === 'removed') removed.push(item.a!); else addedBlocks.push(item.b!);
    }
    let r = 0;
    for (const block of addedBlocks) {
      const match = removed.findIndex((old, k) => k >= r && old.tagName === block.tagName);
      if (match === -1) { out.push(marked(block, 'added')); continue; }
      for (; r < match; r++) out.push(marked(removed[r]!, 'removed'));
      out.push(...merge(removed[r]!, block));
      r++;
    }
    for (; r < removed.length; r++) out.push(marked(removed[r]!, 'removed'));
  }
  return out;
}

/** What changed between two versions, as the page reads. */
export function blockDiff(fromHtml: string, toHtml: string): { html: string; changed: boolean } {
  const blocks = diffBlocks(childrenOf(fromHtml), childrenOf(toHtml));
  const html = blocks.map((block) => block.outerHTML).join('');
  return { html, changed: /<(ins|del)[\s>]|wiki-chg--/.test(html) };
}
