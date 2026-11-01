import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SearchText } from '@flux/contracts';
import { plainSnippet } from '../../apps/web/src/search/plain.js';

// A result's snippet is a slice of the body and can carry Markdown; a result row shows it as one plain
// line with the matched words still marked (#514 AC-2).

const plain = (parts: SearchText | null) => JSON.stringify(plainSnippet(parts));
const hit = (text: string) => ({ text, match: true });
const rest = (text: string) => ({ text, match: false });

describe('search snippets without Markdown', () => {
  test('a heading and a table become one line of words, the match kept', () => {
    assert.equal(
      plain([rest('## '), hit('Radio'), rest('\n\n| Bed | Distance |\n|---|---|\n| North | 3 m |')]),
      JSON.stringify([hit('Radio'), rest(' Bed · Distance North · 3 m')]),
    );
  });

  test('emphasis, links and code keep their words and the match inside them stays marked', () => {
    assert.equal(
      plain([rest('Use **the '), hit('radio'), rest('** near [the gateway](https://x.test/g) and `set_band()`.')]),
      JSON.stringify([rest('Use the '), hit('radio'), rest(' near the gateway and set_band().')]),
    );
  });

  test('list bullets go, plain asterisks and underscores in words stay', () => {
    assert.equal(plain([rest('- one\n- two '), hit('radio')]), JSON.stringify([rest('one two '), hit('radio')]));
    assert.equal(plain([rest('snake_case_name and 2 * 3 * 4 '), hit('radio')]), JSON.stringify([rest('snake_case_name and 2 * 3 * 4 '), hit('radio')]));
  });

  test('nothing to show gives null', () => {
    assert.equal(plainSnippet(null), null);
    assert.equal(plainSnippet([]), null);
    assert.equal(plainSnippet([rest('  \n| --- |\n')]), null);
  });
  test('a slice that starts or ends inside a link keeps its words, never the flux: target (CW-4)', () => {
    assert.equal(plain([rest('Pickup ideas](flux:sketch/f4dd5c1e-0000-4000-8000-000000000000) '), hit('map'), rest('.')]),
      JSON.stringify([rest('Pickup ideas '), hit('map'), rest('.')]));
    assert.equal(plain([hit('Pickup'), rest(' with the [SMS code](flux:deci')]), JSON.stringify([hit('Pickup'), rest(' with the SMS code')]));
  });
});
