import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_THOUGHT_SIZE, SKETCH_LIMITS } from '@flux/contracts';
import { useIntentKeys } from '../api/intent-keys';
import { addThought, getSketch, openMyMap } from '../api/sketches';
import { useShellData } from '../app/data';
import { assertSignedInAs, AccountChangedError } from '../app/personalSpace';
import { useToast } from '../ui';
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

/**
 * "Add to map" on a private message (#867, #948): its words become a thought on My map, which is private like the message. A project's
 * message opens that space's map with a draft instead (`useAddToMap`); a private one has no space to open.
 */
export function useAddToMyMap() {
  const { me, workspace } = useShellData();
  const intents = useIntentKeys();
  const toast = useToast();
  const navigate = useNavigate();
  return useCallback(async (body: string) => {
    const text = body.trim();
    if (!text) { toast({ message: 'There are no words in this message to put on the map', tone: 'danger' }); return; }
    if (text.length > SKETCH_LIMITS.text) { toast({ message: `This message is longer than a thought (${SKETCH_LIMITS.text} characters)`, tone: 'danger' }); return; }
    if (!workspace) { toast({ message: 'You’re not in a company on this Flux yet', tone: 'danger' }); return; }
    try {
      await assertSignedInAs(me.user.id);
      await putThoughtOnMyMap(workspace.id, text, intents);
      toast({ message: 'Added to My map', tone: 'success', timeout: 4000, action: { label: 'Open', onClick: () => navigate('/map') } });
    } catch (cause) {
      toast({ message: cause instanceof AccountChangedError ? cause.message : 'Could not add it to My map. Try again.', tone: 'danger' });
    }
  }, [me.user.id, workspace, intents, toast, navigate]);
}
