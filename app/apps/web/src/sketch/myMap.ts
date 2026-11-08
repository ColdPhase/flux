import { DEFAULT_THOUGHT_SIZE } from '@flux/contracts';
import type { useIntentKeys } from '../api/intent-keys';
import { addThought, getSketch, openMyMap } from '../api/sketches';
import { freeSpot, rectOf } from './geometry';

/** The part of the intent-key store a thought needs: one key per text and map, released once the thought exists. */
export type IntentKeys = ReturnType<typeof useIntentKeys>;

/**
 * Puts a thought on the person's My map (#866) where the map has room, and returns the map. One key per text and map (#178): a retry
 * after a lost answer returns the same thought. The caller has checked the text against `SKETCH_LIMITS.text`.
 */
export async function putThoughtOnMyMap(workspaceId: string, text: string, intents: IntentKeys): Promise<{ id: string }> {
  const map = await openMyMap(workspaceId);
  const found = await getSketch(map.id);
  const size = { w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height };
  const spot = freeSpot(found.thoughts.map((thought) => rectOf(thought, new Map())), null, size);
  const intent = `thought:${map.id}:${text}`;
  await addThought(map.id, { text, ...spot }, intents.keyFor(intent));
  intents.settle(intent);
  return map;
}
