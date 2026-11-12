import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TABLE_COLUMNS, cellText, decode, jsonModel, markdownChunk, markdownModel, parsePreview, tableModel, textModel, type JsonModel, type TableModel, type TextModel } from '../../apps/web/src/composer/previewParse.js';

// The file preview's parsers (C-60, #1252), which run in a Web Worker in the browser.

const lines = (model: { text: string; starts: Uint32Array; ends: Uint32Array }) => Array.from(model.starts, (start, i) => model.text.slice(start, model.ends[i]));
const rows = (model: TableModel) => Array.from({ length: model.rowStart.length - 1 }, (_, r) =>
  Array.from({ length: model.rowStart[r + 1]! - model.rowStart[r]! }, (__, c) => cellText(model, model.rowStart[r]! + c)));

test('bytes decode as UTF-8, UTF-16 with a BOM, else Windows-1252', () => {
  assert.deepEqual(decode(new TextEncoder().encode('Zażółć')), { text: 'Zażółć', encoding: 'utf-8' });
  assert.deepEqual(decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), { text: 'a', encoding: 'utf-8' });
  assert.deepEqual(decode(Uint8Array.from([0x43, 0x61, 0x66, 0xe9])), { text: 'Café', encoding: 'windows-1252' });
  assert.deepEqual(decode(Uint8Array.from([0xff, 0xfe, 0x61, 0x00])), { text: 'a', encoding: 'utf-16le' });
});

test('text splits on every line ending, measures tabs, and cuts a very long line into pieces', () => {
  const model = textModel('a\r\nb\rc\n\td\n', 'utf-8');
  assert.deepEqual(lines(model), ['a', 'b', 'c', '\td']);
  assert.equal(model.columns[3], 9);
  assert.deepEqual(lines(textModel('', 'utf-8')), ['']);
  assert.deepEqual(lines(textModel('x\n\ny', 'utf-8')), ['x', '', 'y']);
  const long = textModel('z'.repeat(10_000), 'utf-8') as TextModel;
  assert.deepEqual(Array.from(long.ends, (end, i) => end - long.starts[i]!), [4096, 4096, 1808]);
});

test('JSON is pretty, keeps values as written, and knows each fold', () => {
  const model = jsonModel('{"a":[1,2.50,{"b":"\\u00e9"}],"e":{},"n":null}', 'utf-8') as JsonModel;
  assert.equal(model.kind, 'json');
  assert.deepEqual(lines(model), ['{', '"a": [', '1,', '2.50,', '{', '"b": "\\u00e9"', '}', '],', '"e": {},', '"n": null', '}']);
  assert.deepEqual(Array.from(model.depth), [0, 1, 2, 2, 2, 3, 2, 1, 1, 1, 0]);
  assert.deepEqual(Array.from(model.close), [10, 7, -1, -1, 6, -1, -1, -1, -1, -1, -1]);
  assert.deepEqual(Array.from(model.items).filter(Boolean), [3, 3, 1]);
  assert.equal(model.columns[5], 6 + 13);
});

test('invalid JSON says the line, the column and why, and keeps the text', () => {
  const bad = jsonModel('{\n  "beds": [1, 2,, 3]\n}', 'utf-8');
  assert.equal(bad.kind, 'json-error');
  if (bad.kind !== 'json-error') return;
  assert.deepEqual([bad.line, bad.column, bad.message], [2, 17, 'Unexpected ","']);
  assert.deepEqual(lines(bad.lines), ['{', '  "beds": [1, 2,, 3]', '}']);
  for (const [source, message] of [['{"a" 1}', "Expected ':' after a property name"], ['[1] 2', 'Unexpected text after the JSON value'],
    ['"open', 'Unterminated string'], ['{a:1}', 'Expected a property name in double quotes'], ['[01]', "Expected ',' or ']'"], ['', 'Unexpected end of JSON']] as const) {
    const parsed = jsonModel(source, 'utf-8');
    assert.equal(parsed.kind === 'json-error' && parsed.message, message, source);
  }
  const deep = jsonModel('['.repeat(200_000), 'utf-8');
  assert.equal(deep.kind, 'json-error', 'a nesting too deep for the stack is shown as text, not a crash');
});

test('CSV follows RFC 4180, and a formula is only text', () => {
  const model = tableModel('bed,note\r\nfar east,"behind the hedge, ""low"""\nnorth,=HYPERLINK("x")\n"multi\nline",+1\nshort\n', 'utf-8', ',');
  assert.deepEqual(rows(model), [['bed', 'note'], ['far east', 'behind the hedge, "low"'], ['north', '=HYPERLINK("x")'], ['multi\nline', '+1'], ['short']]);
  assert.equal(model.columns, 2);
  assert.deepEqual(rows(tableModel('a,b,\n', 'utf-8', ',')), [['a', 'b', '']]);
  assert.deepEqual(rows(tableModel('a\tb\n1\t2', 'utf-8', '\t')), [['a', 'b'], ['1', '2']]);
  const numbers = tableModel('name,rssi\nfar,-112\nnorth,-98\n', 'utf-8', ',');
  assert.deepEqual(Array.from(numbers.numeric), [0, 1]);
});

test('a 5 MiB CSV parses to every row', () => {
  const body = Array.from({ length: 100_000 }, (_, n) => `2026-11-07T14:00:00Z,bed ${n % 40},-${90 + (n % 30)},3.71`).join('\n');
  const model = parsePreview(new TextEncoder().encode(`time,bed,rssi,battery\n${body}\n`), 'csv') as TableModel;
  assert.equal(model.rowStart.length - 1, 100_001);
  assert.deepEqual(rows(model).at(-1), ['2026-11-07T14:00:00Z', 'bed 39', '-99', '3.71']);
});

test('a table as wide as a file allows is parsed whole and measured only where it is drawn', () => {
  const model = tableModel(','.repeat(1_000_000), 'utf-8', ',');
  assert.equal(model.columns, 1_000_001);
  assert.equal(model.rowStart.length - 1, 1);
  assert.equal(model.widths[TABLE_COLUMNS - 1], 4);
  assert.equal(model.widths[TABLE_COLUMNS], 0, 'columns past the drawn ones are not measured');
});

test('Markdown is cut into chunks only at a blank line outside a code fence', () => {
  const paragraph = `${'word '.repeat(900)}\n`;
  const fence = '```\n' + 'code\n\n'.repeat(1000) + '```\n';
  const text = `${paragraph}\n${fence}\n${paragraph}\n${paragraph}`;
  const model = markdownModel(text, 'utf-8');
  const chunks = lines(model);
  assert.equal(chunks.join('\n'), text, 'nothing is lost or repeated');
  for (let i = 0; i < chunks.length; i++) assert.equal((markdownChunk(model, i).match(/```/g) ?? []).length % 2, 0, 'every chunk opens and closes its fences');
  assert.ok(chunks.length >= 3);
  assert.deepEqual(lines(markdownModel('', 'utf-8')), ['']);
});

test('Markdown with no blank line is still cut, a list into lists and a huge code block into code blocks', () => {
  const list = Array.from({ length: 60_000 }, (_, n) => `- item ${n}`).join('\n');
  const listModel = markdownModel(list, 'utf-8');
  assert.ok(listModel.starts.length > 30, `${listModel.starts.length} chunks`);
  for (let i = 0; i < listModel.starts.length; i++) assert.ok(listModel.ends[i]! - listModel.starts[i]! <= 16_100);
  assert.equal(lines(listModel).join('\n'), list);
  const code = `before\n\n\`\`\`js\n${'let x = 1;\n'.repeat(20_000)}\`\`\`\nafter`;
  const codeModel = markdownModel(code, 'utf-8');
  const drawn = Array.from(codeModel.starts, (_, i) => markdownChunk(codeModel, i));
  assert.ok(drawn.length > 5);
  for (const chunk of drawn) assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, chunk.slice(0, 40));
  assert.match(drawn.at(-1)!, /after$/);
});
