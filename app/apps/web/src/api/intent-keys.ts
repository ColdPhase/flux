import { useMemo, useRef } from 'react';

/**
 * One Idempotency-Key per user intent. Retrying the same intent (same inputs) after a failed or lost
 * response reuses its key, so the server replays the original result instead of creating a duplicate.
 * Once the intent succeeds its key is released: a later identical but deliberate request is a new one.
 */
export function useIntentKeys() {
  const keys = useRef(new Map<string, string>());
  return useMemo(() => ({
    keyFor(intent: string): string {
      let key = keys.current.get(intent);
      if (!key) { key = crypto.randomUUID(); keys.current.set(intent, key); }
      return key;
    },
    settle(intent: string): void { keys.current.delete(intent); },
  }), []);
}
