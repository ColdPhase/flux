import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocSectionSource } from '@flux/contracts';
import { describeChange } from '@flux/core';
import { cause, causeSentence, FILE_NAME_SHOWN, fileLabel, sectionSource } from '../../packages/core/src/docs/text.js';

// The input rules and wording of project docs (#112): the version-history text and the decision
// that "Add to docs" writes. All are pure: no database, no network.
// `sectionSource` and the other helpers are imported from the module because `@flux/core` re-exports
// only `describeChange`; its errors are checked by name and code, since the
// module and the built `@flux/core` each carry their own `InvalidInputError` class.

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DECISION: DocSectionSource = { type: 'decision', id: id(2) };

describe('describeChange', () => {
  type Version = { title: string; body: string };
  const version = (change: Partial<Version> = {}): Version => ({ title: 'Plan', body: 'text', ...change });

  test('gives an empty string when nothing changed', () => {
    assert.equal(describeChange(version(), version()), '');
  });

  test('names a single change', () => {
    assert.equal(describeChange(version(), version({ title: 'New plan' })), 'Renamed to “New plan”');
    assert.equal(describeChange(version(), version({ body: 'other text' })), 'Edited the text');
  });

  test('names the rename first, then the edit, joined with a middle dot', () => {
    assert.equal(describeChange(version(), version({ title: 'New plan', body: 'other' })), 'Renamed to “New plan” · Edited the text');
  });

  test('a change of whitespace in the text is an edit', () => {
    assert.equal(describeChange(version({ body: 'text' }), version({ body: 'text\n' })), 'Edited the text');
  });

  test('a title of 80 characters is quoted whole, a longer one is cut to 79 characters and an ellipsis', () => {
    const eighty = 'a'.repeat(80);
    assert.equal(describeChange(version(), version({ title: eighty })), `Renamed to “${eighty}”`);
    assert.equal(describeChange(version(), version({ title: `${eighty}b` })), `Renamed to “${'a'.repeat(79)}…”`);
    assert.equal(describeChange(version(), version({ title: 'z'.repeat(200) })), `Renamed to “${'z'.repeat(79)}…”`);
  });

  test('only the new title is quoted', () => {
    assert.equal(describeChange(version({ title: 'Old title' }), version({ title: 'Fresh title' })), 'Renamed to “Fresh title”');
  });
});

describe('a cause is the only thing a person says about why a version was made (#942)', () => {
  const rejects = (value: unknown, allowed: Parameters<typeof cause>[1]) => assert.throws(() => cause(value, allowed), { name: 'InvalidInputError', code: 'INVALID_INPUT' }, JSON.stringify(value));

  test('nothing is no cause; a cause names a kind this call allows and nothing else', () => {
    assert.equal(cause(undefined, ['restore']), undefined);
    assert.equal(cause(null, ['restore']), undefined);
    assert.deepEqual(cause({ kind: 'restore', version: 3 }, ['restore', 'keep_mine', 'page_left']), { kind: 'restore', version: 3 });
    assert.deepEqual(cause({ kind: 'keep_mine', version: 4 }, ['restore', 'keep_mine', 'page_left']), { kind: 'keep_mine', version: 4 });
    assert.deepEqual(cause({ kind: 'page_left', version: 5 }, ['restore', 'keep_mine', 'page_left']), { kind: 'page_left', version: 5 });
    rejects({ kind: 'import', fileName: 'notes.md' }, ['restore', 'keep_mine', 'page_left']);
    rejects({ kind: 'restore', version: 3 }, ['import']);
    rejects('Restored version 3', ['restore']);
    rejects({ kind: 'published' }, ['restore']);
  });

  test('a version is a whole number from 1, and a cause carries no other field', () => {
    for (const version of [0, -1, 1.5, '3', null, undefined, Number.MAX_SAFE_INTEGER + 1]) rejects({ kind: 'restore', version }, ['restore']);
    rejects({ kind: 'restore', version: 3, reason: 'Because I said so' }, ['restore']);
    rejects({ kind: 'import', fileName: 'notes.md', version: 1 }, ['import']);
  });

  test('an import names its file, tidied and at most 200 characters', () => {
    assert.deepEqual(cause({ kind: 'import', fileName: '  my   notes.md ' }, ['import']), { kind: 'import', fileName: 'my notes.md' });
    assert.deepEqual(cause({ kind: 'import', fileName: 'x'.repeat(200) }, ['import']), { kind: 'import', fileName: 'x'.repeat(200) });
    rejects({ kind: 'import', fileName: 'x'.repeat(201) }, ['import']);
    rejects({ kind: 'import', fileName: '   ' }, ['import']);
    rejects({ kind: 'import' }, ['import']);
  });

  test('the server words each cause', () => {
    assert.equal(causeSentence({ kind: 'import', fileName: 'notes.md' }, null), 'Imported from notes.md');
    assert.equal(causeSentence({ kind: 'restore', version: 3 }, null), 'Restored version 3');
    assert.equal(causeSentence({ kind: 'keep_mine', version: 4 }, 'Ada'), 'In place of Ada’s version 4');
    assert.equal(causeSentence({ kind: 'keep_mine', version: 4 }, null), '', 'the saver\'s own version is no "in place of": the change describes itself');
    assert.equal(causeSentence({ kind: 'page_left', version: 5 }, null), 'Saved as the page was left, in place of version 5');
  });

  test('a file name in a reason is the last part of the name, on one line, without direction characters, and short (#1021)', () => {
    assert.equal(fileLabel('notes.md'), 'notes.md');
    assert.equal(fileLabel('C:\\Users\\Ada\\Lamp notes.md'), 'Lamp notes.md');
    assert.equal(fileLabel('../../etc/passwd'), 'passwd');
    assert.equal(fileLabel('a\u202Eb\u200B\nc\td.md'), 'ab c d.md', 'a direction override is dropped, a control becomes a space');
    assert.equal(fileLabel('dir/'), 'dir');
    assert.equal(fileLabel('///'), '///', 'a name with nothing in it is kept as it is');
    assert.equal(fileLabel(' \u0007 '), 'a file');
    const long = fileLabel(`${'x'.repeat(150)}.markdown`);
    assert.deepEqual([Array.from(long).length, long.endsWith('….markdown'), long.startsWith('xxx')], [FILE_NAME_SHOWN, true, true]);
    assert.equal(fileLabel('y'.repeat(FILE_NAME_SHOWN)), 'y'.repeat(FILE_NAME_SHOWN), 'a name of exactly the limit is not shortened');
    assert.equal(causeSentence({ kind: 'import', fileName: `${'z'.repeat(150)}.md` }, null).length, 'Imported from '.length + FILE_NAME_SHOWN);
  });
});

describe('sectionSource', () => {
  const refusal = { name: 'InvalidInputError', code: 'INVALID_INPUT', message: 'from must be { type: "decision", id }' };

  test('accepts a decision with a UUID id', () => {
    assert.deepEqual(sectionSource({ type: 'decision', id: id(2) }), { type: 'decision', id: id(2) });
  });

  test('lowercases the id', () => {
    assert.deepEqual(sectionSource({ type: 'decision', id: id(0xabc).toUpperCase() }), { type: 'decision', id: id(0xabc) });
  });

  test('returns only the type and the id', () => {
    assert.deepEqual(sectionSource({ type: 'decision', id: id(2), extra: 'ignored' }), { type: 'decision', id: id(2) });
  });

  test('refuses another type', () => {
    for (const type of ['task', 'doc', 'message', 'result', 'DECISION', 'decision ', '', undefined, null, 1]) {
      assert.throws(() => sectionSource({ type, id: id(2) }), refusal, String(type));
    }
  });

  test('refuses an id that is not a UUID', () => {
    for (const value of ['abc', '', ` ${id(1)}`, `${id(1)} `, id(1).slice(1), `${id(1)}0`, id(1).replace(/-/g, ''), 1, null, undefined]) {
      assert.throws(() => sectionSource({ type: 'decision', id: value }), refusal, String(value));
    }
    assert.throws(() => sectionSource({ type: 'decision' }), refusal, 'no id');
  });

  test('refuses null, undefined and a value that is not an object', () => {
    for (const value of [null, undefined, 'decision', 7, true, [], [DECISION.type, DECISION.id]]) {
      assert.throws(() => sectionSource(value), refusal, JSON.stringify(value));
    }
  });
});
