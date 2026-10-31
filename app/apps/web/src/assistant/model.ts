import { useEffect, useSyncExternalStore } from 'react';
import { ASSISTANT_MODEL_PATH, assistantModelName, type AssistantModelChoice, type AssistantModelOption } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';
import { isWorking, runModelName } from './format';
import { listOwnRuns } from './api';

// The assistant's one model (F-027 AST-11): the ready card, Settings, the ask bar and the panel all read and write
// the same value, so they can never disagree. This is the shared store behind them; the server decides what is valid.

let choice: AssistantModelChoice | null = null;
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The list for the way being set up (the API key form names its connection), without touching the shared choice. */
export const fetchAssistantModel = (connectionId?: string, signal?: AbortSignal) =>
  request<AssistantModelChoice>(connectionId ? `${ASSISTANT_MODEL_PATH}?connectionId=${encodeURIComponent(connectionId)}` : ASSISTANT_MODEL_PATH, { signal });

/** Reads the caller's own choice again (when a control comes into view or opens its list). */
export async function refreshAssistantModel(signal?: AbortSignal) {
  try {
    choice = await request<AssistantModelChoice>(ASSISTANT_MODEL_PATH, { signal });
    started = true;
    emit();
  } catch (error) {
    if (!(error instanceof DOMException)) { started = true; emit(); }
  }
}

export const modelOption = (current: AssistantModelChoice | null, id: string | undefined): AssistantModelOption | null =>
  current?.options.find((option) => option.id === id) ?? null;

/** The line that confirms a change, for a polite live region (AST-11 "Behaviour"). */
async function confirmation(name: string) {
  let running = '';
  try {
    const working = (await listOwnRuns()).items.find(isWorking);
    if (working) running = ` The one running keeps ${runModelName(working.model)}.`;
  } catch { /* the line stays short */ }
  return running ? `Model: ${name} from your next request.${running}` : `Model: ${name}. It applies from your next request.`;
}

/**
 * Chooses the model on the server. Resolves with the confirming sentence; rejects with the server's plain error
 * ("Your Claude plan doesn't offer that model. It is still Sonnet.") and leaves the stored choice as it was.
 */
export async function chooseAssistantModel(id: string): Promise<string> {
  try {
    const next = await request<AssistantModelChoice>(ASSISTANT_MODEL_PATH, { method: 'PUT', body: { model: id } });
    choice = next;
    const sentence = await confirmation(modelOption(next, next.current)?.name ?? assistantModelName(next.current));
    emit();
    return sentence;
  } catch (error) {
    if (error instanceof NetworkError) throw new Error(`Offline. It is still ${modelOption(choice, choice?.current)?.name ?? 'the same'}.`);
    if (error instanceof ApiError && error.status < 500) { await refreshAssistantModel(); throw new Error(error.message); }
    throw new Error(`Couldn't change the model. It is still ${modelOption(choice, choice?.current)?.name ?? 'the same'}.`);
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
