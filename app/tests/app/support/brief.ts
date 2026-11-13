import { buildBrief } from '@flux/core';

// TEST SUPPORT ONLY (#1064): one real brief of `/ai` in a direct message, for the adapter suites that check what goes on the wire. Its exact text
// for every place is pinned in ai-brief.test.ts; here it only has to be the real shape: Flux's rules as the system prompt, the place's
// messages fenced as data and the request last as the one user message.

export const BRIEF = buildBrief({
  kind: 'ask', tools: ['flux_read_around', 'flux_search'], agentName: 'Assistant', agentId: '7a6c1f0e-3b2d-4c5e-8f90-a1b2c3d4e5f9', ownerName: 'Kai Weber', now: new Date('2026-11-08T09:02:00Z'), timeZone: 'UTC',
  place: { kind: 'dm', others: ['Jonas Berg'], thread: false },
  task: null, scheduleTitle: null, agent: null, prompt: 'Where are we?', requestedAt: new Date('2026-11-08T09:01:00Z'), leftOut: false, turns: [], earlier: null, thought: null,
  messages: [{ id: 'm-1', sequence: 1, body: 'Camera fails below 5 lux', authorName: 'Jonas Berg', author: { kind: 'human', id: 'u-1' }, createdAt: new Date('2026-11-07T15:00:00Z') }],
});
