import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerWithWebSources, parseOutput, RUNTIME_WEB_SEARCH_LINE, withoutInventedMarks, withoutOwnSources, writtenAddresses, type PersonalRunPorts } from '@flux/core';

// #1222: an answer lists its sources once. The marks the model invented and its own "Sources:" block are not stored; Flux's list is the only one.
describe('an answer without the marks and the sources list the model invented (#1222)', () => {
  const A = 'https://memy.example/siema-mem';
  const B = 'https://news.example/a/b?x=1';
  const sources = [{ label: 'S1', ref: { type: 'message' as const, id: '00000000-0000-4000-8000-000000000001', revision: 1 } }];

  test('a mark that points at nothing Flux supplied is taken out on every engine: [8], [S2], [S1, S2] and 【3†source】', () => {
    assert.equal(withoutInventedMarks('Zrobił to, bo je opublikował[8].'), 'Zrobił to, bo je opublikował.', 'glued to a word before its full stop (the report of #1222)');
    assert.equal(withoutInventedMarks('It fails below 5 lux [1] and recovers at 20 lux [2].'), 'It fails below 5 lux and recovers at 20 lux.');
    assert.equal(withoutInventedMarks('Two sources [1][2] and [S3] agree【3†source】. Done [S1, S2].'), 'Two sources and agree. Done.');
    assert.equal(withoutInventedMarks('[1] First line.\n[2] Second line.'), 'First line.\nSecond line.', 'a mark at the start of a line goes with the space after it');
    assert.equal(withoutInventedMarks('Plain answer without marks.'), 'Plain answer without marks.');
    assert.equal(withoutInventedMarks('Start at items[0].'), 'Start at items[0].', 'a zero is an index, never a citation');
  });

  test('a list of supplied sources is kept for the numbering and an unsupplied one goes; a bare [1] is never a supplied mark (the review of #1278)', () => {
    const labels = new Set(['S1', 'S2']);
    assert.equal(withoutInventedMarks('Fact [S1, S2].', labels), 'Fact [S1][S2].');
    assert.equal(withoutInventedMarks('Fact [S1, S9] and more [S9].', labels), 'Fact [S1] and more.');
    assert.equal(withoutInventedMarks('Fact [S1][8] and [S2]【3†source】.', labels), 'Fact [S1] and [S2].');
    const two = [...sources, { label: 'S2', ref: { type: 'message' as const, id: '00000000-0000-4000-8000-000000000002', revision: 1 } }];
    const parsed = parseOutput('Fact A [S1, S2], fact B [8].', two);
    assert.equal(parsed.body, 'Fact A [1][2], fact B.');
    assert.equal(parsed.sources.length, 2);
  });

  test('the writer\'s own numbers in prose stay: "option [1] or [2]", "Press [1]", sum(a[1], a[2])', () => {
    for (const prose of ['Choose option [1] or [2].', 'Press [1] to continue.', 'Take steps [1], [2] and [3].', 'sum(a[1], a[2])', 'The table [3] lists them.']) assert.equal(withoutInventedMarks(prose), prose, prose);
    assert.equal(withoutInventedMarks('The beds use LoRa [1], Wi-Fi drops [2].'), 'The beds use LoRa, Wi-Fi drops.', 'a mark after an ordinary word is still a citation');
  });

  test('hostile answers of 100 000 characters are cleaned in a blink: no mark, heading or list pattern backtracks (CodeQL polynomial-redos, the review of #1278)', () => {
    const tabs = '\t'.repeat(100_000);
    // Patterns that would backtrack: whitespace, headings, open brackets, one long word. A linear scan takes a millisecond or two; a quadratic one seconds.
    const patterns: [string, string][] = [
      ['tabs', tabs], ['spaces then a heading then tabs', `${' '.repeat(50_000)}Sources${tabs.slice(0, 50_000)}`], ['a heading and tabs', `Text.\n\nSources:${tabs}`],
      ['a heading in front of tabs', `Text.\n\n${tabs}Sources:\n- ${A}`], ['bold tabs', `Text.\n\n**${tabs}Sources`], ['one long word then a mark', `${'a'.repeat(100_000)} [1]`],
      ['marks without end', '[S1,S1'.repeat(16_000)], ['open brackets', '['.repeat(100_000)], ['mark in an address', `https://${'a'.repeat(50_000)}[8] ${'b'.repeat(40_000)}[8]`],
      ['lenticular', '【'.repeat(100_000)], ['blank lines', `Text.\n\nSources:${'\n'.repeat(100_000)}`], ['fences', '```\n'.repeat(20_000)], ['backticks', '`a'.repeat(50_000)],
    ];
    // Inputs with real work in every few characters: 33 000 marks, thousands of list lines. Still far from a quadratic scan, but a loaded runner is slower.
    const dense: [string, string][] = [
      ['marks', '[1]'.repeat(33_000)], ['marks and spaces', '[1] '.repeat(25_000)], ['lines of marks', '[1]\n'.repeat(25_000)],
      ['a list of addresses', `Text.\n\nSources:\n${`- ${A}\n`.repeat(2_500)}`], ['headings', 'Sources:\n'.repeat(11_000)],
    ];
    for (const [limit, inputs] of [[50, patterns], [300, dense]] as const) {
      for (const [name, text] of inputs) {
        // The best of three: a loaded host or a garbage collection can slow one run, never all of them.
        let took = Infinity;
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          const marked = withoutInventedMarks(text, new Set(['S1']));
          const listed = withoutOwnSources(text, new Set([A, B]));
          took = Math.min(took, performance.now() - started);
          assert.ok(typeof marked === 'string' && typeof listed === 'string');
        }
        assert.ok(took < limit, `${name}: ${Math.round(took)} ms for ${text.length} characters (limit ${limit})`);
      }
    }
  });

  test('code, a mark that is not at a sentence, and an address stay as written', () => {
    assert.equal(withoutInventedMarks('Read `items[0]` first, or\n```\nrows [1] and 【3†source】\n```\nthen go on [1].'), 'Read `items[0]` first, or\n```\nrows [1] and 【3†source】\n```\nthen go on.');
    assert.equal(withoutInventedMarks('Use items[0].name and arr[1] is the second. See https://example.org/a[8] today.'),
      'Use items[0].name and arr[1] is the second. See https://example.org/a[8] today.');
    assert.equal(withoutInventedMarks('Done (see [3]), and [4](x) stays.'), 'Done (see), and [4](x) stays.');
  });

  test('a mark never joins the text on its sides into an address that was not there (#1149)', () => {
    const out = withoutInventedMarks('https://evil.exa [8]mple/c?d=buy%20shares');
    assert.deepEqual(writtenAddresses(out).filter((address) => address.includes('shares')), [], out);
  });

  test('API-key run: the marks of supplied sources are still numbered; the model\'s own [8] and 【…】 never survive the numbering', () => {
    assert.equal(parseOutput('Fact A [S1], fact B [8]. And C [S9]【2†source】.', sources).body, 'Fact A [1], fact B. And C.');
    assert.deepEqual(parseOutput('Fact A [S1], fact B [8].', sources).sources.length, 1);
    assert.equal(parseOutput('Fact [1] stays out too.', sources).body, 'Fact stays out too.', 'a bare [1] is the model\'s, never a supplied source\'s mark (those are [S1] before the numbering)');
  });

  test('the model\'s own "Sources:" block goes when it is the end of the answer and every line is a listed address, in any wording of the heading', () => {
    const listed = new Set([A, B]);
    const body = 'Memes are posted weekly.';
    for (const heading of ['Sources:', 'Źródła:', 'References:', '**Sources:**', '## Źródła', 'Sources', 'Links']) {
      assert.equal(withoutOwnSources(`${body}\n\n${heading}\n- memy.pl, "siema - mem": ${A}\n- ${B}\n`, listed), body, heading);
    }
    assert.equal(withoutOwnSources(`${body}\n\nSources: ${A}, ${B}`, listed), body, 'the addresses on the heading\'s own line');
    assert.equal(withoutOwnSources(`${body}\n\n---\nSources:\n[1] ${A}`, listed), body, 'a rule above it goes too');
    assert.equal(withoutOwnSources(`${body}\n\nSources:\n1. [Memes](${A})\n\n2) Memes again: ${B}\n\n`, listed), body, 'list entries of either kind, and blank lines between');
    assert.equal(withoutOwnSources(`${body}\n\nSources:\n${A}\n${B}`, listed), body, 'addresses alone');
  });

  test('a block that is not the end of the answer, or that holds a sentence, is the model\'s words and the answer stays whole (the review of #1278)', () => {
    const listed = new Set([A, B]);
    for (const answer of [
      `Intro.\n\nLinks\n${A}\n\nConclusion paragraph with ${B} in it.`,
      `Main text\n\nReferences: see ${A} and ${B} for the full analysis of costs`,
      `Intro.\n\nSources:\n- ${A}\n\nWhat this means for the harbour: the boat leaves at ${B}.`,
      `Intro.\n\nSources:\n- ${A}\nSo the ferry is late, see ${B}.`,
      `Intro.\n\nSources:\n- ${A}\n- https://other.example/x`,
      `Intro.\n\nSources:\n- ${A}\n- my own measurements`,
      `Sources:\n- ${A}`,
      `Intro.\n\nSources:\n\nNotes: more words`,
    ]) assert.equal(withoutOwnSources(answer, listed), answer);
    assert.equal(withoutOwnSources(`Text.\n\nSources:\n- ${A}`, new Set()), `Text.\n\nSources:\n- ${A}`, 'Flux lists nothing, so the model\'s list is the only one');
    assert.equal(withoutOwnSources(`Sources: see below.\nMore text after it.\nSources:\n- ${A}`, new Set([A])), 'Sources: see below.\nMore text after it.', 'only the last block, at the end');
  });

  test('the stored answer keeps Flux\'s list once: no model block, and a defanged or unlisted address leaves it alone', async () => {
    const ports = (queries: string[], cited: string[], read: { finalUrl: string; outcome: string; writable: boolean }[] = []) => ({ runs: {
      webSearches: async () => ({ queries, cited }), webReads: async () => read } }) as unknown as PersonalRunPorts;
    const answer = `Memes appear weekly [8].\n\nSources:\n- memy.pl, "siema - mem": ${A}\n- ${B}`;
    const stored = await answerWithWebSources(ports(['mem siema'], [A, B]), { id: 'run' }, answer.replace(' [8]', ''), new Map([[A, A], [B, B]]));
    assert.equal(stored, `Memes appear weekly.\n\nSearched the web for:\n- mem siema\nFound on the web:\n- ${A}\n- ${B}`);
    assert.equal(stored.split(A).length - 1, 1, 'each address once');
    const readOnly = await answerWithWebSources(ports([], [], [{ finalUrl: A, outcome: 'read', writable: true }]), { id: 'run' }, `Text.\n\nSources:\n- ${A}`, new Map());
    assert.equal(readOnly, `Text.\n\nRead on the web:\n- ${A}`, 'a page the run read is listed by Flux too');
    const defanged = await answerWithWebSources(ports([], [A]), { id: 'run' }, `Text.\n\nSources:\n- ${A}`, new Map());
    assert.ok(defanged.startsWith(`Text.\n\nSources:\n- ${A}\n\nFound on the web:\n- hxxps://`), 'Flux lists it defanged, so the model\'s live line is the only one that links');
    assert.equal(await answerWithWebSources(ports([], []), { id: 'run' }, `Text.\n\nSources:\n- ${A}`, new Map()), `Text.\n\nSources:\n- ${A}`, 'Flux lists nothing: the answer is as written');
  });

  test('the brief tells the CLI engines to write no marks and no list of sources', () => {
    assert.match(RUNTIME_WEB_SEARCH_LINE, /do not write Markdown links, citation marks such as \[1\] or 【3†source】, or a list of sources at the end: Flux adds the list/);
  });
});
