import { useEffect, useSyncExternalStore } from 'react';
import { ASSISTANT_MODEL_PATH, type AssistantModelChoice } from '@flux/contracts';
import { request } from '../api/client';

// The caller's models of every connection and the current pick (F-027 AST-11; any connection's, #854): Settings and the agents' pages
// read the same value, so they can never disagree. This is the shared store behind them; the server decides what is valid.

let choice: AssistantModelChoice | null = null;
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };


/** Reads the caller's own choice again (when a page that shows it comes into view or the connections changed). */
export async function refreshAssistantModel(signal?: AbortSignal) {
  try {
    choice = await request<AssistantModelChoice>(ASSISTANT_MODEL_PATH, { signal });
    started = true;
    emit();
  } catch (error) {
    if (!(error instanceof DOMException)) { started = true; emit(); }
  }
}

/** The caller's own choice, shared by every control on the page; read again whenever one mounts. */
export function useAssistantModel(): { choice: AssistantModelChoice | null; loaded: boolean } {
  const current = useSyncExternalStore(subscribe, () => choice, () => null);
  const loaded = useSyncExternalStore(subscribe, () => started, () => false);
  useEffect(() => {
    const controller = new AbortController();
    void refreshAssistantModel(controller.signal);
    return () => controller.abort();
  }, []);
  return { choice: current, loaded };
}
