import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TypingContext } from '@flux/contracts';
import { TypingClient } from './client';

export function useTyping(identity: string, context: TypingContext | null, writable: boolean) {
  const kind = context?.kind; const id = context?.id;
  const client = useMemo(() => new TypingClient(kind && id ? { kind, id } : null, identity), [identity, kind, id]);
  const view = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  useEffect(() => { client.setWritable(writable); }, [client, writable]);
  useEffect(() => { client.start(); return () => client.close(); }, [client]);
  return { ...view, input: (hasText: boolean) => client.input(hasText), stop: client.stop };
}
