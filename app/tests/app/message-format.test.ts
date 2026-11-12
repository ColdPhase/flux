import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { messageLinkUrls, messagePreview, parseInline, parseMessage, plainMessageText, type MessageBlock, type MessageInline } from '@flux/contracts';
import { plainWords } from '../../apps/web/src/work/messageWords.js';

// The one parser of the message subset (#1247): `**bold**`, `*italic*`, `` `code` ``, fenced code, `- ` and `1. ` lists and `> ` quotes.
// It reads text and returns plain data, so what it returns is all the renderer can draw: text, bold, italic, code, quote, list, code block.

const t = (text: string): MessageInline => ({ kind: 'text', text });
const bold = (...children: MessageInline[]): MessageInline => ({ kind: 'bold', children });
const italic = (...children: MessageInline[]): MessageInline => ({ kind: 'italic', children });
const code = (text: string): MessageInline => ({ kind: 'code', text });
const text = (...inline: MessageInline[]): MessageBlock => ({ kind: 'text', inline });

describe('inline marks', () => {
  test('bold, italic and code, with the text between them kept as typed', () => {
    assert.deepEqual(parseInline('a **b** c *d* e `f` g'), [t('a '), bold(t('b')), t(' c '), italic(t('d')), t(' e '), code('f'), t(' g')]);
    assert.deepEqual(parseInline('no marks at all'), [t('no marks at all')]);
    assert.deepEqual(parseInline(''), []);
  });

  test('marks nest, and a triple star is bold italic', () => {
    assert.deepEqual(parseInline('**bold *and italic* mix**'), [bold(t('bold '), italic(t('and italic')), t(' mix'))]);
    assert.deepEqual(parseInline('*italic **and bold** mix*'), [italic(t('italic '), bold(t('and bold')), t(' mix'))]);
    assert.deepEqual(parseInline('***both***'), [bold(italic(t('both')))]);
    assert.deepEqual(parseInline('**bold *it***'), [bold(t('bold '), italic(t('it')))]);
  });

  test('a mark opens next to a word and closes next to one: spaces and glued stars are text', () => {
    for (const plain of ['2 * 3 * 4', 'a*b*c', 'a * b', '* not italic *', '**  spaced  **', 'a ** b', '5*3 and 2*4', 'lone *', '**', '****', '* *']) {
      assert.deepEqual(parseInline(plain), [t(plain)], plain);
    }
    // Scripts with no spaces between words have no word edge to wait for.
    assert.deepEqual(parseInline('这是**重点**内容'), [t('这是'), bold(t('重点')), t('内容')]);
    assert.deepEqual(parseInline('(*in brackets*) and "**quoted**"'), [t('('), italic(t('in brackets')), t(') and "'), bold(t('quoted')), t('"')]);
  });

  test('a mark that never closes stays as typed', () => {
    assert.deepEqual(parseInline('**open and never closed'), [t('**open and never closed')]);
    assert.deepEqual(parseInline('*also open'), [t('*also open')]);
    assert.deepEqual(parseInline('**a* b'), [t('**a* b')]);
    assert.deepEqual(parseInline('`no end'), [t('`no end')]);
    assert.deepEqual(parseInline('**bold** and **open'), [bold(t('bold')), t(' and **open')]);
  });

  test('marks run across the lines of one paragraph', () => {
    assert.deepEqual(parseInline('**two\nlines** here'), [bold(t('two\nlines')), t(' here')]);
  });

  test('a code span holds its marks and its references as text, and a longer fence holds a backtick', () => {
    assert.deepEqual(parseInline('`**not bold** and *not italic* #4 @Ada`'), [code('**not bold** and *not italic* #4 @Ada')]);
    assert.deepEqual(parseInline('`` a`b ``'), [code('a`b')]);
    assert.deepEqual(parseInline('``` x ``y`` ```'), [code('x ``y``')]);
    assert.deepEqual(parseInline('` padded `'), [code('padded')]);
    assert.deepEqual(parseInline('`  `'), [code('  ')]);
    // The marks of a span do not close a mark outside it.
    assert.deepEqual(parseInline('**a `b**c` d**'), [bold(t('a '), code('b**c'), t(' d'))]);
    assert.deepEqual(parseInline('*a `b*c` d*'), [italic(t('a '), code('b*c'), t(' d'))]);
    assert.deepEqual(parseInline('**`code in bold`**'), [bold(code('code in bold'))]);
  });

  test('references stay text for the renderer inside the marks: mentions, tasks, Wiki pages and web addresses', () => {
    assert.deepEqual(parseInline('**@Jonas Berg** did *#4*'), [bold(t('@Jonas Berg')), t(' did '), italic(t('#4'))]);
    assert.deepEqual(parseInline('see **[[Garden *beds* plan]]** now'), [t('see '), bold(t('[[Garden *beds* plan]]')), t(' now')]);
    // An address is read as it is: the stars of a path are not marks, and the stars around it are.
    assert.deepEqual(parseInline('**https://example.com/a**'), [bold(t('https://example.com/a'))]);
    assert.deepEqual(parseInline('*https://example.com/a*'), [italic(t('https://example.com/a'))]);
    assert.deepEqual(parseInline('https://example.com/*a*/b and *x*'), [t('https://example.com/*a*/b and '), italic(t('x'))]);
    assert.deepEqual(parseInline('(**https://example.com/a**).'), [t('('), bold(t('https://example.com/a')), t(').')]);
  });

  test('other marks are not part of the subset', () => {
    for (const plain of ['_under_ and __double__', '~~strike~~', '# heading', '## heading', '<b>html</b>', '![image](https://example.test/a.png)', '[link](https://example.test)', '| a | b |']) {
      assert.deepEqual(parseInline(plain), [t(plain)], plain);
      assert.equal(plainMessageText(plain), plain, plain);
    }
    // There is no escape: a mark that must show as typed goes in a code span.
    assert.deepEqual(parseInline('\\*kept\\*'), [t('\\'), italic(t('kept\\'))]);
    assert.deepEqual(parseInline('`**kept**`'), [code('**kept**')]);
  });

  test('deeply nested marks do not run away, and a hostile long line is read in linear time', () => {
    const deep = '*a '.repeat(50) + 'z' + '*'.repeat(50);
    assert.doesNotThrow(() => parseInline(deep));
    for (const hostile of ['*a '.repeat(8000), '**a *b '.repeat(3000), '` `` ``` '.repeat(2000), ('*a ' + '**b ').repeat(3000), `${'*'.repeat(20000)}`, 'a'.repeat(50000)]) {
      const started = performance.now();
      parseMessage(hostile);
      assert.ok(performance.now() - started < 500, `${hostile.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
    }
  });
});

describe('blocks', () => {
  test('a body without marks is one text block, exactly as typed', () => {
    assert.deepEqual(parseMessage('hello\nthere\n\nworld'), [text(t('hello\nthere\n\nworld'))]);
    assert.deepEqual(parseMessage('\n  spaced \n'), [text(t('\n  spaced \n'))]);
    assert.deepEqual(parseMessage(''), [text()]);
    assert.deepEqual(parseMessage('line one\r\nline two'), [text(t('line one\nline two'))]);
  });

  test('a fenced code block holds its lines literally, marks and quotes included', () => {
    assert.deepEqual(parseMessage('before\n```ts\nconst a = **1**;\n> not a quote\n- not a list\n```\nafter'), [
      text(t('before')), { kind: 'code', text: 'const a = **1**;\n> not a quote\n- not a list', lang: 'ts' }, text(t('after'))]);
    assert.deepEqual(parseMessage('```\nno language\n```'), [{ kind: 'code', text: 'no language', lang: null }]);
    assert.deepEqual(parseMessage('```\n\n  indented\n\n```'), [{ kind: 'code', text: '\n  indented\n', lang: null }]);
    assert.deepEqual(parseMessage('```\n```'), [{ kind: 'code', text: '', lang: null }]);
  });

  test('a longer fence closes only with as many backticks, and a fence left open runs to the end', () => {
    assert.deepEqual(parseMessage('````\n```\ninner\n```\n````'), [{ kind: 'code', text: '```\ninner\n```', lang: null }]);
    assert.deepEqual(parseMessage('```\nnever closed\nstill code'), [{ kind: 'code', text: 'never closed\nstill code', lang: null }]);
    assert.deepEqual(parseMessage('text\n```'), [text(t('text\n```'))], 'a fence with nothing after it is text');
    assert.deepEqual(parseMessage('```js and more words\nx\n```')[0], { kind: 'code', text: 'x', lang: 'js' });
    assert.deepEqual(parseMessage('```<script>\nx\n```')[0], { kind: 'code', text: 'x', lang: null }, 'a language that is not a short name is dropped');
  });

  test('three backticks inside a line are an inline span, not a fence', () => {
    assert.deepEqual(parseMessage('use ```code``` inline'), [text(t('use '), code('code'), t(' inline'))]);
    assert.deepEqual(parseMessage('```code``` first'), [text(code('code'), t(' first'))]);
  });

  test('lists: bullets and numbers, one level, continuation lines and a blank line between items', () => {
    assert.deepEqual(parseMessage('- a\n- **b**\n- c'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a')], [bold(t('b'))], [t('c')]] }]);
    assert.deepEqual(parseMessage('1. one\n2. two\n10. three'), [{ kind: 'list', ordered: true, start: 1, items: [[t('one')], [t('two')], [t('three')]] }]);
    assert.deepEqual(parseMessage('3. start at three\n4. next'), [{ kind: 'list', ordered: true, start: 3, items: [[t('start at three')], [t('next')]] }]);
    assert.deepEqual(parseMessage('- a\n  more of a\n- b'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a\nmore of a')], [t('b')]] }]);
    assert.deepEqual(parseMessage('- a\n\n- b'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a')], [t('b')]] }], 'a blank line between items keeps one list');
    assert.deepEqual(parseMessage('- a\n    - nested\n- b'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a')], [t('nested')], [t('b')]] }], 'an indented item is an item of the same list');
    assert.deepEqual(parseMessage('Steps:\n- a\n- b\nDone.'), [text(t('Steps:')), { kind: 'list', ordered: false, start: 1, items: [[t('a')], [t('b')]] }, text(t('Done.'))]);
    assert.deepEqual(parseMessage('- a\n1. b'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a')]] }, { kind: 'list', ordered: true, start: 1, items: [[t('b')]] }]);
    assert.deepEqual(parseMessage('- a\n\nA paragraph.'), [{ kind: 'list', ordered: false, start: 1, items: [[t('a')]] }, text(t('A paragraph.'))]);
  });

  test('a dash or a number without its space, or an empty item, is text', () => {
    for (const plain of ['-5 degrees', '--- rule', '-', '- ', '1.5 litres', '2024. A year', '1.', '+ plus', '* star item']) {
      assert.deepEqual(parseMessage(plain), [text(t(plain))], plain);
    }
  });

  test('quotes keep their attribution line and hold marks', () => {
    assert.deepEqual(parseMessage('> Jonas Berg:\n> the **hedge** is wet\nreply'), [
      { kind: 'quote', author: 'Jonas Berg', inline: [t('the '), bold(t('hedge')), t(' is wet')] }, text(t('reply'))]);
    assert.deepEqual(parseMessage('> just words'), [{ kind: 'quote', author: null, inline: [t('just words')] }]);
    assert.deepEqual(parseMessage('>tight'), [{ kind: 'quote', author: null, inline: [t('tight')] }]);
  });

  test('the blank lines beside a block give way to the block, and a paragraph between blocks is kept', () => {
    assert.deepEqual(parseMessage('Intro\n\n- a\n\nOutro'), [text(t('Intro')), { kind: 'list', ordered: false, start: 1, items: [[t('a')]] }, text(t('Outro'))]);
    assert.deepEqual(parseMessage('one\n\n\ntwo\n```\nx\n```'), [text(t('one\n\n\ntwo')), { kind: 'code', text: 'x', lang: null }]);
  });
});

describe('plain words', () => {
  test('what a reader sees, without the marks: previews, notifications and Copy text', () => {
    const body = '**Soil** is *low*, run `calibrate`.\n\n- check #12\n- ask @Ben\n\n1. dry\n2. read\n\n> Ben:\n> wet hedge\n\n```py\nx = **2**\n```';
    assert.equal(plainMessageText(body), 'Soil is low, run calibrate.\n- check #12\n- ask @Ben\n1. dry\n2. read\nBen:\nwet hedge\nx = **2**');
    assert.equal(plainMessageText('plain words stay'), 'plain words stay');
    assert.equal(plainMessageText('2 * 3 * 4 and `a`'), '2 * 3 * 4 and a');
    assert.equal(messagePreview('**Done** the sensors', 0), 'Done the sensors');
    assert.equal(messagePreview('', 2), '2 attached files');
    assert.equal(messagePreview('', 1), '1 attached file');
    assert.equal(messagePreview('**', 0), '**');
  });

  test('Copy text: the marks go, a Wiki page is its title, a mention and a task stay', () => {
    assert.equal(plainWords('**See** [[Calibration]] for #12 with @Ada\n> Ben:\n> wet'), 'See Calibration for #12 with @Ada\nBen:\nwet');
  });
});

describe('web addresses', () => {
  test('a star ends no address, so bold and italic around one stay marks', () => {
    assert.deepEqual(messageLinkUrls('**https://a.example/x** and *http://b.example/y* and https://c.example/z*'), ['https://a.example/x', 'http://b.example/y', 'https://c.example/z']);
    assert.deepEqual(messageLinkUrls('See (https://a.example/x), http://b.example/y. Again https://a.example/x'), ['https://a.example/x', 'http://b.example/y']);
  });
});

describe('nothing in the data can be HTML', () => {
  /** Every string of the parse and the kinds of its nodes: all a renderer can be asked to draw. */
  function walk(blocks: MessageBlock[]): { kinds: Set<string>; strings: string[] } {
    const kinds = new Set<string>();
    const strings: string[] = [];
    const inline = (nodes: MessageInline[]) => nodes.forEach((node) => {
      kinds.add(node.kind);
      if (node.kind === 'text' || node.kind === 'code') strings.push(node.text); else inline(node.children);
    });
    for (const block of blocks) {
      kinds.add(block.kind);
      if (block.kind === 'text' || block.kind === 'quote') inline(block.inline);
      else if (block.kind === 'list') block.items.forEach(inline);
      else strings.push(block.text);
    }
    return { kinds, strings };
  }

  test('markup, script, event handlers and javascript: links stay words, and every node is one of the subset', () => {
    const hostile = [
      '<img src=x onerror="alert(1)">', '<script>alert(1)</script>', '[click](javascript:alert(1))', '**<b onmouseover="x">bold?</b>**', '`</code><iframe src="javascript:alert(1)">`',
      '```html\n<a href="javascript:alert(1)">x</a>\n```', '> <svg onload=alert(1)>', '- <details open ontoggle=alert(1)>', '1. <style>*{display:none}</style>',
      '![x](javascript:alert(1))', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '&lt;script&gt;', '\u0000**x**\u0000', '**' + '<'.repeat(100) + '**',
    ];
    const allowed = new Set(['text', 'bold', 'italic', 'code', 'quote', 'list']);
    for (const body of hostile) {
      const { kinds, strings } = walk(parseMessage(body));
      for (const kind of kinds) assert.ok(allowed.has(kind), `${body}: ${kind}`);
      // Nothing is dropped or rewritten: the hostile characters are text the renderer escapes as text.
      for (const needle of ['<img', '<script', 'javascript:', '<svg', '<details', '<style', 'onerror', 'onmouseover', 'onload']) {
        if (body.includes(needle)) assert.ok(strings.some((value) => value.includes(needle)), `${body}: ${needle} is kept as text`);
      }
    }
  });
});
