import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { docRef, type DocSectionSource, type DocState } from '@flux/contracts';
import { describeChange, upsertSection } from '@flux/core';
import { dateLine, sectionSource, sourceLine } from '../../packages/core/src/docs/text.js';

// The input rules and wording of project docs (#112): the version-history text and the `Source:`
// line that links a doc section to its result or decision. All are pure: no database, no network.
// `sectionSource` and the other helpers are imported from the module because `@flux/core` re-exports
// only `describeChange` and `upsertSection`; its errors are checked by name and code, since the
// module and the built `@flux/core` each carry their own `InvalidInputError` class.

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const RESULT: DocSectionSource = { type: 'result', id: id(1) };
const DECISION: DocSectionSource = { type: 'decision', id: id(2) };

describe('describeChange', () => {
  type Version = { title: string; body: string; state: DocState };
  const version = (change: Partial<Version> = {}): Version => ({ title: 'Plan', body: 'text', state: 'draft', ...change });

  test('gives an empty string when nothing changed', () => {
    assert.equal(describeChange(version(), version()), '');
    assert.equal(describeChange(version({ state: 'published' }), version({ state: 'published' })), '');
  });

  test('names a single change', () => {
    assert.equal(describeChange(version(), version({ state: 'published' })), 'Published');
    assert.equal(describeChange(version({ state: 'published' }), version({ state: 'draft' })), 'Moved back to draft');
    assert.equal(describeChange(version(), version({ title: 'New plan' })), 'Renamed to “New plan”');
    assert.equal(describeChange(version(), version({ body: 'other text' })), 'Edited the text');
  });

  test('names the state change first, then the rename, then the edit, joined with a middle dot', () => {
    assert.equal(describeChange(version(), version({ state: 'published', title: 'New plan', body: 'other' })),
      'Published · Renamed to “New plan” · Edited the text');
    assert.equal(describeChange(version({ state: 'published' }), version({ state: 'draft', title: 'New plan', body: 'other' })),
      'Moved back to draft · Renamed to “New plan” · Edited the text');
    assert.equal(describeChange(version(), version({ title: 'New plan', body: 'other' })), 'Renamed to “New plan” · Edited the text');
    assert.equal(describeChange(version(), version({ state: 'published', body: 'other' })), 'Published · Edited the text');
    assert.equal(describeChange(version(), version({ state: 'published', title: 'New plan' })), 'Published · Renamed to “New plan”');
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

describe('sourceLine', () => {
  test('is `Source: [label](target)` with the target docRef(type, id)', () => {
    assert.equal(sourceLine(RESULT, 'Launch plan'), `Source: [Launch plan](${docRef('result', RESULT.id)})`);
    assert.equal(sourceLine(DECISION, 'Use Postgres'), `Source: [Use Postgres](${docRef('decision', DECISION.id)})`);
    assert.equal(sourceLine(RESULT, 'Launch plan'), `Source: [Launch plan](flux:result/${id(1)})`);
  });

  test('escapes Markdown characters in the label', () => {
    assert.equal(sourceLine(RESULT, 'Q3 *draft* [v2]'), `Source: [Q3 \\*draft\\* \\[v2\\]](flux:result/${id(1)})`);
    for (const character of '\\`*_{}[]()#+!<>|~') {
      assert.equal(sourceLine(RESULT, `a${character}b`), `Source: [a\\${character}b](flux:result/${id(1)})`, character);
    }
  });

  test('leaves other punctuation and non-ASCII letters as they are', () => {
    assert.equal(sourceLine(RESULT, 'Plan: v2.0 - “final”, ąęł'), `Source: [Plan: v2.0 - “final”, ąęł](flux:result/${id(1)})`);
  });

  test('collapses whitespace and line breaks in the label to single spaces', () => {
    assert.equal(sourceLine(RESULT, '  two\n\n lines\t here  '), `Source: [two lines here](flux:result/${id(1)})`);
  });

  test('a label cannot close the link and aim it elsewhere', () => {
    const line = sourceLine(RESULT, 'x](https://example.test) [y');
    assert.equal(line, `Source: [x\\]\\(https://example.test\\) \\[y](flux:result/${id(1)})`);
    assert.ok(line.endsWith(`](flux:result/${id(1)})`));
    assert.ok(!line.includes('](https'), 'no raw `](` before the real target');
  });
});

describe('dateLine', () => {
  test('formats the UTC calendar date in English with a short month', () => {
    assert.equal(dateLine(new Date('2026-10-22T23:30:00Z')), 'Oct 22, 2026');
    assert.equal(dateLine(new Date('2026-01-05T08:00:00Z')), 'Jan 5, 2026');
    assert.equal(dateLine(new Date('2026-05-31T12:00:00Z')), 'May 31, 2026');
    assert.equal(dateLine(new Date('2026-09-09T00:00:00Z')), 'Sep 9, 2026');
  });

  test('the UTC day changes at midnight UTC, including at the end of a year', () => {
    assert.equal(dateLine(new Date('2026-12-31T23:59:59.999Z')), 'Dec 31, 2026');
    assert.equal(dateLine(new Date('2027-01-01T00:00:00Z')), 'Jan 1, 2027');
  });

  test('an instant given with another UTC offset is read as the instant it names', () => {
    assert.equal(dateLine(new Date('2026-10-23T01:30:00+03:00')), 'Oct 22, 2026');
    assert.equal(dateLine(new Date('2026-10-22T20:00:00-05:00')), 'Oct 23, 2026');
  });
});

describe('sectionSource', () => {
  const refusal = { name: 'InvalidInputError', code: 'INVALID_INPUT', message: 'from must be { type: "result" | "decision", id }' };

  test('accepts a result and a decision with a UUID id', () => {
    assert.deepEqual(sectionSource({ type: 'result', id: id(1) }), { type: 'result', id: id(1) });
    assert.deepEqual(sectionSource({ type: 'decision', id: id(2) }), { type: 'decision', id: id(2) });
  });

  test('lowercases the id', () => {
    assert.deepEqual(sectionSource({ type: 'result', id: id(0xabc).toUpperCase() }), { type: 'result', id: id(0xabc) });
  });

  test('returns only the type and the id', () => {
    assert.deepEqual(sectionSource({ type: 'decision', id: id(2), extra: 'ignored' }), { type: 'decision', id: id(2) });
  });

  test('refuses another type', () => {
    for (const type of ['task', 'doc', 'message', 'RESULT', 'result ', '', undefined, null, 1]) {
      assert.throws(() => sectionSource({ type, id: id(1) }), refusal, String(type));
    }
  });

  test('refuses an id that is not a UUID', () => {
    for (const value of ['abc', '', ` ${id(1)}`, `${id(1)} `, id(1).slice(1), `${id(1)}0`, id(1).replace(/-/g, ''), 1, null, undefined]) {
      assert.throws(() => sectionSource({ type: 'result', id: value }), refusal, String(value));
    }
    assert.throws(() => sectionSource({ type: 'result' }), refusal, 'no id');
  });

  test('refuses null, undefined and a value that is not an object', () => {
    for (const value of [null, undefined, 'result', 7, true, [], [RESULT.type, RESULT.id]]) {
      assert.throws(() => sectionSource(value), refusal, JSON.stringify(value));
    }
  });
});

describe('upsertSection', () => {
  const section = (source: DocSectionSource, title: string, text: string, heading = '##') => `${heading} ${title}\n\n${sourceLine(source, title)}\n\n${text}\n`;
  const lines = (...parts: string[]) => parts.join('\n');

  test('adds the section after the text when no section cites the source', () => {
    const added = upsertSection('# Plan\n\nIntro.\n\n', RESULT, section(RESULT, 'Result A', 'New text.'));
    assert.equal(added.replaced, false);
    assert.equal(added.body, `# Plan\n\nIntro.\n\n${section(RESULT, 'Result A', 'New text.')}`);
  });

  test('starts the doc with the section when the text is empty or blank', () => {
    for (const text of ['', ' \n\n  ']) {
      const added = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New text.'));
      assert.equal(added.replaced, false);
      assert.equal(added.body, section(RESULT, 'Result A', 'New text.'));
    }
  });

  test('replaces only the section whose Source line cites the same reference', () => {
    const intro = '# Plan\n\nIntro stays.\n';
    const a = (text: string) => section(RESULT, 'Result A', text);
    const b = section(DECISION, 'Decision B', 'B text stays.');
    const replaced = upsertSection(`${intro}\n${a('Old A text.')}\n${b}`, RESULT, a('New A text.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, `${intro}\n${a('New A text.')}\n${b}`);
    assert.ok(replaced.body.endsWith(b), 'the section after it is kept byte for byte');
    assert.ok(replaced.body.startsWith(intro), 'the text before it is kept byte for byte');

    const other = upsertSection(`${intro}\n${a('A text stays.')}\n${b}`, DECISION, section(DECISION, 'Decision B', 'New B text.'));
    assert.equal(other.replaced, true);
    assert.equal(other.body, `${intro}\n${a('A text stays.')}\n${section(DECISION, 'Decision B', 'New B text.')}`);
  });

  test('the same id under another type is another reference', () => {
    const asDecision = section({ type: 'decision', id: id(1) }, 'Decision with the same id', 'Keep.');
    const added = upsertSection(asDecision, RESULT, section(RESULT, 'Result A', 'New text.'));
    assert.equal(added.replaced, false);
    assert.equal(added.body, `${asDecision}\n${section(RESULT, 'Result A', 'New text.')}`);
  });

  test('a # line inside a fenced code block is not a section boundary', () => {
    const text = lines('# Plan', '', '## Result A', '', sourceLine(RESULT, 'Result A'), '', '```sh', '# not a heading', 'echo hi', '```', '',
      'Tail of A.', '', '## Other', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, lines('# Plan', '', '## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '## Other', '', 'Keep me.', ''));
  });

  test('a # line in a fenced block before the Source line is not the start of the section', () => {
    const text = lines('# Plan', '', '## Result A', '', '~~~', '# fake heading', '~~~', '', sourceLine(RESULT, 'Result A'), '', 'Old.', '', '## Other', '',
      'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, lines('# Plan', '', '## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '## Other', '', 'Keep me.', ''));
  });

  test('a backtick fence is not closed by a tilde line', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '```', '~~~', '# inside', '```', '', '## Other', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.body, lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '## Other', '', 'Keep me.', ''));
  });

  // A fence closes only on the same character and a run at least as long as the opener's (CommonMark, #677).
  const rewritten = (...rest: string[]) => lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', ...rest);

  test('a four-backtick block holding a three-backtick block is one block: a # line in it is not a section boundary', () => {
    const text = lines('# Plan', '', '## Result A', '', sourceLine(RESULT, 'Result A'), '', '````md', '```sh', '# inside the inner block', '```',
      '# still inside the outer block', '````', '', 'Tail of A.', '', '## Other', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, `# Plan\n\n${rewritten('## Other', '', 'Keep me.', '')}`);
  });

  test('a # line in such a block before the Source line is not the start of the section', () => {
    const text = lines('# Plan', '', '## Result A', '', '````md', '```sh', '# fake heading', '```', '````', '', sourceLine(RESULT, 'Result A'), '', 'Old.', '',
      '## Other', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, `# Plan\n\n${rewritten('## Other', '', 'Keep me.', '')}`);
  });

  test('an outer block is closed by a fence longer than its opener, and the heading after it is a boundary again', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '```', '# inside', '``````', '', 'Tail of A.', '', '## Other', '', 'Keep me.', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));

    const exact = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '````', '# inside', '````', '', 'Tail of A.', '', '## Other', '', 'Keep me.', '');
    assert.equal(upsertSection(exact, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));
  });

  test('a shorter fence of the same character does not close a block', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '`````', '```', '# inside', '````', '# also inside', '`````', '', 'Tail of A.', '', '## Other', '',
      'Keep me.', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));
  });

  test('a longer tilde block holding a shorter one is one block, and a backtick fence does not close a tilde block', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '~~~~', '~~~', '# inside the inner block', '~~~', '# still inside', '````', '# and here', '~~~~', '',
      'Tail of A.', '', '## Other', '', 'Keep me.', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));
  });

  test('a tilde block is closed by a longer tilde fence', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '~~~', '# inside', '~~~~~~', '', 'Tail of A.', '', '## Other', '', 'Keep me.', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));
  });

  test('an unclosed block runs to the end of the text', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '````', '```', '# inside', '```', '## inside too', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, section(RESULT, 'Result A', 'New.'));
  });

  test('a fence may be indented by up to three spaces', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '   ````', '  ```', '# inside', '  ```', '   ````', '', 'Tail of A.', '', '## Other', '', 'Keep me.', '');
    assert.equal(upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.')).body, rewritten('## Other', '', 'Keep me.', ''));
  });

  test('lines that are not headings do not end a section', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '#hashtag', '#', '####### seven', '', '## Other', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.body, lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '## Other', '', 'Keep me.', ''));
  });

  test('the section reaches its deeper headings and ends at the next heading of its level or above', () => {
    const text = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', '### Details', '', 'Deep.', '', '#### Deeper', '', 'Deeper.', '', '# Appendix', '', 'Keep me.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.body, lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '# Appendix', '', 'Keep me.', ''));

    const sibling = lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'Old.', '', '## Sibling', '', 'Keep me.', '');
    assert.equal(upsertSection(sibling, RESULT, section(RESULT, 'Result A', 'New.')).body,
      lines('## Result A', '', sourceLine(RESULT, 'Result A'), '', 'New.', '', '## Sibling', '', 'Keep me.', ''));
  });

  test('the last section is replaced to the end of the text', () => {
    const text = lines('# Plan', '', section(RESULT, 'Result A', 'Old.').replace(/\n$/, ''));
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, `# Plan\n\n${section(RESULT, 'Result A', 'New.')}`);
  });

  test('the heading of the section is rewritten with it', () => {
    const text = lines('## Old name', '', sourceLine(RESULT, 'Old name'), '', 'Old.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'New name', 'New.'));
    assert.equal(replaced.body, section(RESULT, 'New name', 'New.'));
  });

  test('a Source line with trailing spaces still names its section', () => {
    const text = lines('## Result A', '', `${sourceLine(RESULT, 'Result A')}   `, '', 'Old.', '');
    const replaced = upsertSection(text, RESULT, section(RESULT, 'Result A', 'New.'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.body, section(RESULT, 'Result A', 'New.'));
  });

  test('a section written with sourceLine is found again, whatever its label, and rewriting is stable', () => {
    const title = 'Plan *v2* [draft] (final)';
    const first = upsertSection('# Plan\n', RESULT, section(RESULT, title, 'First.'));
    assert.equal(first.replaced, false);
    const second = upsertSection(first.body, RESULT, section(RESULT, title, 'Second.'));
    assert.equal(second.replaced, true);
    assert.equal(second.body, `# Plan\n\n${section(RESULT, title, 'Second.')}`);
    const third = upsertSection(second.body, RESULT, section(RESULT, title, 'Second.'));
    assert.equal(third.replaced, true);
    assert.equal(third.body, second.body);
  });
});
