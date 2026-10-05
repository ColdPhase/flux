import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKETCH_LIMITS } from '@flux/contracts';
import { imageRefusal, linkOf, PASTE_TEXT_CHARS, pastedImageName, pastedText } from '../../apps/web/src/sketch/paste.js';

// #252: what a paste on the map becomes, before any draft or upload (docs/design/thought-drafts.md "Paste on the map").

test('clipboard lines: trimmed, empty dropped, one line is one draft, more than the cap is refused whole', () => {
  assert.deepEqual(pastedText('  Bedside lamp dims at dusk  '), { kind: 'one', text: 'Bedside lamp dims at dusk' });
  assert.deepEqual(pastedText('Swipe to dim\r\n\n  Hold to switch off \r\n\t\nDouble tap for reading light\n'),
    { kind: 'lines', lines: ['Swipe to dim', 'Hold to switch off', 'Double tap for reading light'] });
  assert.deepEqual(pastedText('Old Mac line\rNext line'), { kind: 'lines', lines: ['Old Mac line', 'Next line'] });
  assert.deepEqual(pastedText(' \n\t\n'), { kind: 'empty' });
  assert.deepEqual(pastedText(''), { kind: 'empty' });
  const full = Array.from({ length: SKETCH_LIMITS.pasteLines }, (_, index) => `Idea ${index + 1}`);
  assert.deepEqual(pastedText(full.join('\n')), { kind: 'lines', lines: full });
  assert.deepEqual(pastedText([...full, 'One too many'].join('\n')), { kind: 'too-many', count: SKETCH_LIMITS.pasteLines + 1 });
  assert.deepEqual(pastedText('x'.repeat(PASTE_TEXT_CHARS + 1)), { kind: 'too-long' });
  // Markup stays literal text; it is never interpreted.
  assert.deepEqual(pastedText('<b>Literal</b>\n<script>alert(1)</script>'), { kind: 'lines', lines: ['<b>Literal</b>', '<script>alert(1)</script>'] });
});

test('a link thought is exactly one http(s) URL; other schemes and sentences stay text', () => {
  assert.equal(linkOf('https://example.test/lamp-notes?draft=2#dusk')?.host, 'example.test');
  assert.equal(linkOf('  http://lamp.example.test:8080/ ')?.host, 'lamp.example.test:8080');
  for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.test/file', 'mailto:ada@example.test',
    'see https://example.test/lamp', 'https://', 'https://exa mple.test', 'example.test/lamp', 'https://example.test/a\nhttps://example.test/b']) {
    assert.equal(linkOf(text), null, text);
  }
});

test('a pasted image is PNG, JPEG, GIF or WebP from 1 byte to 5 MiB; it gets a readable name', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(imageRefusal({ type, size: 2048 }), null);
  assert.match(imageRefusal({ type: 'image/svg+xml', size: 2048 })!, /Only PNG, JPEG, GIF or WebP/);
  assert.match(imageRefusal({ type: 'application/pdf', size: 2048 })!, /Only PNG, JPEG, GIF or WebP/);
  assert.match(imageRefusal({ type: 'image/png', size: 0 })!, /empty/);
  assert.equal(imageRefusal({ type: 'image/png', size: 5 * 1024 * 1024 }), null);
  assert.match(imageRefusal({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })!, /at most 5 MB/);
  assert.equal(pastedImageName('image/jpeg', new Date(2026, 9, 5, 14, 7)), 'Pasted image 2026-10-05 14.07.jpg');
  assert.equal(pastedImageName('image/webp', new Date(2026, 0, 9, 8, 30)), 'Pasted image 2026-01-09 08.30.webp');
});
