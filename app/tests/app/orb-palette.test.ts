import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_PALETTES, ASSISTANT_PALETTE, ORB_PALETTES, agentPalette, orbClassName, orbHash } from '../../apps/web/src/ui/orb-palette.js';

// F-025 PA-2 (docs/design/people-and-ai.md): eight orb palettes; the built-in assistant is violet and every
// other agent's palette comes from a stable hash of its agent id.

test('eight palettes; the assistant is violet and no agent connection can look like it', () => {
  assert.equal(ORB_PALETTES.length, 8);
  assert.equal(new Set(ORB_PALETTES).size, 8);
  assert.equal(ASSISTANT_PALETTE, 'violet');
  assert.deepEqual([...AGENT_PALETTES], ORB_PALETTES.filter((palette) => palette !== 'violet'));
});

test('an agent keeps its palette: the same id gives the same palette every time, in any case', () => {
  // Pinned values: a change to the hash or the order of the palettes would recolour every agent people know.
  const pinned: [string, number, string][] = [
    ['3f1c2a9e-8d7b-4c6a-9e21-5b0d4f7a1c33', 0xbf41801e, 'gold'],
    ['a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d', 0x2cebb558, 'fern'],
    ['00000000-0000-4000-8000-000000000000', 0xd0703f35, 'gold'],
    ['agent', 0x4fe7f1a6, 'ocean'],
  ];
  for (const [id, hash, palette] of pinned) {
    assert.equal(orbHash(id), hash, id);
    assert.equal(agentPalette(id), palette, id);
    // Repeated calls, another spelling of the same UUID and stray whitespace never change it.
    for (let round = 0; round < 3; round += 1) assert.equal(agentPalette(id), palette);
    assert.equal(agentPalette(id.toUpperCase()), palette);
    assert.equal(agentPalette(` ${id} `), palette);
  }
});

test('agents spread over all seven agent palettes and never get violet', () => {
  const seen = new Map<string, number>();
  for (let index = 0; index < 700; index += 1) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${(index * 7919).toString(16).padStart(12, '0')}`;
    const palette = agentPalette(id);
    assert.notEqual(palette, ASSISTANT_PALETTE, id);
    seen.set(palette, (seen.get(palette) ?? 0) + 1);
  }
  assert.deepEqual([...seen.keys()].sort(), [...AGENT_PALETTES].sort());
  // Roughly even: no palette takes more than twice its share.
  for (const count of seen.values()) assert.ok(count < 200, `uneven spread: ${[...seen.entries()].join(', ')}`);
});

test('the orb turns only when live, through one class that CSS gates on reduced motion', () => {
  assert.equal(orbClassName('ember', 'sm', false), 'ui-orb ui-orb--sm ui-orb--ember');
  assert.equal(orbClassName('violet', 'md', true), 'ui-orb ui-orb--md ui-orb--violet ui-orb--live');
});
