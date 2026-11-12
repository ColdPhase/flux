/**
 * Decoding and parsing for file previews (C-58, #1252). It runs in a Web Worker (`preview.worker.ts`), so a 5 MiB file never holds
 * the page. Every model is one string plus typed arrays of offsets: the page receives a single string and transferable arrays (no
 * million small strings to copy), and slices only the lines or cells it draws. Nothing here is ever drawn as HTML.
 */

export type ParsedFormat = 'text' | 'json' | 'csv' | 'tsv';
export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** Lines of text: line i is `text.slice(starts[i], ends[i])`; `columns[i]` is its width in monospace cells (tabs to the next stop of 8). */
export interface TextModel { kind: 'text'; encoding: Encoding; text: string; starts: Uint32Array; ends: Uint32Array; columns: Uint32Array }
/**
 * Pretty JSON: the same lines, with each line's depth and, for a line that opens an object or array, the line that closes it and how
 * many items it holds (-1 and 0 otherwise).
 */
export interface JsonModel { kind: 'json'; encoding: Encoding; text: string; starts: Uint32Array; ends: Uint32Array; columns: Uint32Array; depth: Uint16Array; close: Int32Array; items: Uint32Array }
/** JSON that does not parse: the text as written, with where and why. */
export interface JsonErrorModel { kind: 'json-error'; encoding: Encoding; message: string; line: number; column: number; lines: TextModel }
/**
 * A table: cell c is `text.slice(cellStart[c], cellEnd[c])`, with `""` read as `"` when `quoted[c]`; row r holds cells
 * `rowStart[r]` to `rowStart[r + 1]`. `widths` is a column's width in characters (from the first rows, 4–40) and `numeric` whether
 * every sampled value of it is a number. Row 0 is the header.
 */
export interface TableModel { kind: 'table'; encoding: Encoding; text: string; cellStart: Uint32Array; cellEnd: Uint32Array; quoted: Uint8Array; rowStart: Uint32Array; columns: number; widths: Uint16Array; numeric: Uint8Array }
export type PreviewModel = TextModel | JsonModel | JsonErrorModel | TableModel;

/** UTF-8 (a BOM is dropped), UTF-16 with its BOM, else Windows-1252, which decodes any byte. */
export function decode(bytes: Uint8Array): { text: string; encoding: Encoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }; }
}

/** A piece of a very long line is drawn as a line of its own, so no single element holds megabytes of text. */
const PIECE = 4096;

function columnsOf(text: string, start: number, end: number, indent = 0): number {
  let width = indent;
  for (let i = start; i < end; i++) width = text.charCodeAt(i) === 9 ? width + 8 - (width % 8) : width + 1;
  return width;
}

/** Splits text into lines (`\n`, `\r\n` or `\r`), long lines into pieces of {@link PIECE} characters. */
export function textModel(text: string, encoding: Encoding): TextModel {
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (start: number, end: number) => {
    for (let at = start; at < end || at === start; at += PIECE) { starts.push(at); ends.push(Math.min(end, at + PIECE)); if (end === start) break; }
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) {
      push(start, i);
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < text.length || starts.length === 0) push(start, text.length);
  const startArray = Uint32Array.from(starts);
  const endArray = Uint32Array.from(ends);
  const columns = new Uint32Array(startArray.length);
  for (let i = 0; i < columns.length; i++) columns[i] = columnsOf(text, startArray[i]!, endArray[i]!);
  return { kind: 'text', encoding, text, starts: startArray, ends: endArray, columns };
}

class JsonSyntax extends Error { constructor(message: string, readonly at: number) { super(message); } }

/** Pretty JSON in two-space indents, values exactly as written (no number or escape is rewritten), or where it stops parsing. */
export function jsonModel(source: string, encoding: Encoding): JsonModel | JsonErrorModel {
  const lines: string[] = [];
  const depths: number[] = [];
  const closes: number[] = [];
  const counts: number[] = [];
  let i = 0;
  const ws = () => { for (let c = source.charCodeAt(i); c === 32 || c === 10 || c === 13 || c === 9; c = source.charCodeAt(++i)); };
  const fail = (message: string): never => { throw new JsonSyntax(message, i); };
  const string = (): string => {
    const start = i;
    i++;
    for (;;) {
      const c = source.charCodeAt(i);
      if (Number.isNaN(c)) fail('Unterminated string');
      if (c === 34) { i++; return source.slice(start, i); }
      if (c < 32) fail('Unescaped control character in a string');
      if (c === 92) {
        const next = source[i + 1];
        if (next === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) { i++; fail('Bad \\u escape'); } i += 6; }
        else if (next !== undefined && '"\\/bfnrt'.includes(next)) i += 2;
        else { i++; fail('Bad escape'); }
      } else i++;
    }
  };
  const scalar = (): string => {
    const c = source[i];
    if (c === '"') return string();
    const literal = /^(?:true|false|null)/.exec(source.slice(i, i + 5));
    if (literal) { i += literal[0].length; return literal[0]; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i, i + 400));
    if (number && number[0] !== '-') { i += number[0].length; return number[0]; }
    return c === undefined ? fail('Unexpected end of JSON') : fail(`Unexpected ${JSON.stringify(c)}`);
  };
  const line = (depth: number, text: string) => { lines.push(text); depths.push(depth); closes.push(-1); counts.push(0); return lines.length - 1; };
  const value = (depth: number, prefix: string) => {
    ws();
    const c = source[i];
    if (c !== '{' && c !== '[') { line(depth, prefix + scalar()); return; }
    const object = c === '{';
    const end = object ? '}' : ']';
    i++;
    ws();
    if (source[i] === end) { i++; line(depth, prefix + c + end); return; }
    const open = line(depth, prefix + c);
    let count = 0;
    for (;;) {
      ws();
      let key = '';
      if (object) {
        if (source[i] !== '"') fail('Expected a property name in double quotes');
        key = `${string()}: `;
        ws();
        if (source[i] !== ':') fail("Expected ':' after a property name");
        i++;
      }
      value(depth + 1, key);
      count++;
      ws();
      if (source[i] === ',') { i++; lines[lines.length - 1] += ','; continue; }
      if (source[i] === end) { i++; break; }
      fail(`Expected ',' or '${end}'`);
    }
    closes[open] = line(depth, end);
    counts[open] = count;
  };
  try {
    if (source.charCodeAt(0) === 0xfeff) i = 1;
    value(0, '');
    ws();
    if (i < source.length) fail('Unexpected text after the JSON value');
  } catch (error) {
    const at = error instanceof JsonSyntax ? error.at : i;
    const message = error instanceof JsonSyntax ? error.message : 'Too deeply nested to show as a tree';
    let lineNumber = 1;
    let lineStart = 0;
    for (let k = 0; k < at && k < source.length; k++) if (source.charCodeAt(k) === 10) { lineNumber++; lineStart = k + 1; }
    return { kind: 'json-error', encoding, message, line: lineNumber, column: at - lineStart + 1, lines: textModel(source, encoding) };
  }
  const starts = new Uint32Array(lines.length);
  const ends = new Uint32Array(lines.length);
  const columns = new Uint32Array(lines.length);
  let offset = 0;
  for (let k = 0; k < lines.length; k++) {
    starts[k] = offset;
    offset += lines[k]!.length;
    ends[k] = offset;
    columns[k] = 2 * depths[k]! + lines[k]!.length;
    offset += 1;
  }
  return { kind: 'json', encoding, text: lines.join('\n'), starts, ends, columns, depth: Uint16Array.from(depths), close: Int32Array.from(closes), items: Uint32Array.from(counts) };
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)?(?:[.,]\d+)?(?:[eE][-+]?\d+)?%?$/;

/** RFC 4180 rows: quoted cells may hold the delimiter, `""` and line breaks; a row may be shorter or longer than the header. */
export function tableModel(text: string, encoding: Encoding, delimiter: ',' | '\t'): TableModel {
  const cellStart: number[] = [];
  const cellEnd: number[] = [];
  const quoted: number[] = [];
  const rowStart: number[] = [0];
  const split = delimiter.charCodeAt(0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let columns = 0;
  let rowCells = 0;
  const endRow = () => { columns = Math.max(columns, rowCells); rowCells = 0; rowStart.push(cellStart.length); };
  while (i < text.length) {
    let start = i;
    let end: number;
    let isQuoted = 0;
    if (text.charCodeAt(i) === 34) {
      isQuoted = 1;
      start = i + 1;
      i = start;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) { i = text.length; end = i; break; }
        if (text.charCodeAt(q + 1) === 34) { i = q + 2; continue; }
        end = q;
        i = q + 1;
        break;
      }
      // Anything between the closing quote and the delimiter is kept out; such a cell is not valid CSV.
      while (i < text.length && text.charCodeAt(i) !== split && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
    } else {
      while (i < text.length && text.charCodeAt(i) !== split && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
      end = i;
    }
    cellStart.push(start); cellEnd.push(end!); quoted.push(isQuoted); rowCells++;
    const c = text.charCodeAt(i);
    if (c === split) { i++; if (i === text.length) { cellStart.push(i); cellEnd.push(i); quoted.push(0); rowCells++; } continue; }
    if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2; else if (c === 10 || c === 13) i++;
    endRow();
  }
  if (rowCells) endRow();
  const model: TableModel = { kind: 'table', encoding, text, cellStart: Uint32Array.from(cellStart), cellEnd: Uint32Array.from(cellEnd), quoted: Uint8Array.from(quoted),
    rowStart: Uint32Array.from(rowStart), columns, widths: new Uint16Array(columns), numeric: new Uint8Array(columns) };
  const sampled = Math.min(rowStart.length - 1, 1000);
  const seen = new Uint8Array(columns);
  model.numeric.fill(1);
  for (let r = 0; r < sampled; r++) {
    for (let c = rowStart[r]!, col = 0; c < rowStart[r + 1]!; c++, col++) {
      const value = cellText(model, c);
      model.widths[col] = Math.max(model.widths[col]!, Math.min(40, value.length));
      if (r > 0 && value) { seen[col] = 1; if (!NUMBER.test(value.trim())) model.numeric[col] = 0; }
    }
  }
  for (let col = 0; col < columns; col++) { model.widths[col] = Math.max(4, model.widths[col]!); if (!seen[col]) model.numeric[col] = 0; }
  return model;
}

/** One cell's text as written: a quoted cell's `""` is one `"`. A cell starting with `=`, `+`, `-` or `@` is still only text. */
export function cellText(model: TableModel, cell: number): string {
  const raw = model.text.slice(model.cellStart[cell], model.cellEnd[cell]);
  return model.quoted[cell] ? raw.replaceAll('""', '"') : raw;
}

export function parsePreview(bytes: Uint8Array, format: ParsedFormat): PreviewModel {
  const { text, encoding } = decode(bytes);
  if (format === 'json') return jsonModel(text, encoding);
  if (format === 'csv' || format === 'tsv') return tableModel(text, encoding, format === 'csv' ? ',' : '\t');
  return textModel(text, encoding);
}

/** The typed arrays of a model, handed to the page without a copy. */
export function transferablesOf(model: PreviewModel): ArrayBuffer[] {
  const arrays: ArrayBufferView[] = model.kind === 'text' ? [model.starts, model.ends, model.columns]
    : model.kind === 'json' ? [model.starts, model.ends, model.columns, model.depth, model.close, model.items]
      : model.kind === 'json-error' ? [model.lines.starts, model.lines.ends, model.lines.columns]
        : [model.cellStart, model.cellEnd, model.quoted, model.rowStart, model.widths, model.numeric];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}
