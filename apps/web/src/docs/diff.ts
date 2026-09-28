import { diffLines, diffWordsWithSpace } from 'diff';

// Line diff between two doc versions, with the changed words marked inside a changed line
// (jsdiff, pinned). Long unchanged stretches fold into one "n unchanged lines" row.

export interface DiffPart { text: string; changed: boolean }
export type DiffRow =
  | { kind: 'same' | 'added' | 'removed'; parts: DiffPart[] }
  | { kind: 'fold'; count: number };

const CONTEXT = 2;

const lines = (value: string) => {
  const split = value.split('\n');
  if (split[split.length - 1] === '') split.pop();
  return split;
};

function words(before: string, after: string): { removed: DiffPart[]; added: DiffPart[] } {
  const removed: DiffPart[] = [];
  const added: DiffPart[] = [];
  for (const change of diffWordsWithSpace(before, after)) {
    if (!change.added) removed.push({ text: change.value, changed: !!change.removed });
    if (!change.removed) added.push({ text: change.value, changed: !!change.added });
  }
  return { removed, added };
}

export function diffDocs(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const changes = diffLines(before, after);
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      for (const line of lines(change.value)) rows.push({ kind: 'same', parts: [{ text: line, changed: false }] });
      continue;
    }
    const next = changes[index + 1];
    const removed = change.removed ? lines(change.value) : [];
    const added = change.added ? lines(change.value) : next?.added && change.removed ? lines(next.value) : [];
    if (change.removed && next?.added) index++;
    const paired = Math.min(removed.length, added.length);
    const out: DiffRow[] = [];
    const addedRows: DiffRow[] = [];
    removed.forEach((line, i) => {
      if (i < paired) {
        const marked = words(line, added[i]!);
        out.push({ kind: 'removed', parts: marked.removed });
        addedRows.push({ kind: 'added', parts: marked.added });
      } else out.push({ kind: 'removed', parts: [{ text: line, changed: true }] });
    });
    added.slice(paired).forEach((line) => addedRows.push({ kind: 'added', parts: [{ text: line, changed: true }] }));
    rows.push(...out, ...addedRows);
  }
  return fold(rows);
}

/** Keeps a little context around changes and folds the rest. */
function fold(rows: DiffRow[]): DiffRow[] {
  const near = rows.map((row, index) => row.kind !== 'same'
    || rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((item) => item.kind !== 'same'));
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (near[index]) {
      if (hidden) { out.push({ kind: 'fold', count: hidden }); hidden = 0; }
      out.push(row);
    } else hidden++;
  });
  if (hidden) out.push({ kind: 'fold', count: hidden });
  return out;
}

/** Counts of added and removed lines, for a one-line summary. */
export function diffStats(rows: DiffRow[]) {
  return { added: rows.filter((row) => row.kind === 'added').length, removed: rows.filter((row) => row.kind === 'removed').length };
}
