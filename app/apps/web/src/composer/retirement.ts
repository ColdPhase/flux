import { forgetReloadRetention } from '../app/reload-retention';
import { forgetPlaces } from '../place/memory';

/**
 * Where this browser learns that a session has ended (#326, #592): sign-out here, and a sign-out in another tab of the same browser. The
 * composer's drafts are the first thing a session leaves behind, so they are retired the moment it ends: their stored copies go, a writer of
 * the earlier session never writes again, and a tab that has not signed out itself goes to the sign-in page. It is a module of its own, apart
 * from the composer (`draft.ts`, with the sending, the uploads and the outbox), because every tab must hear this from the first screen on,
 * while the composer's code comes only when a conversation is opened (#1428). The composer registers what it holds in memory with `onRetire`.
 */

export const PREFIX = 'flux:composer:';
const RETIREMENT_KEY = 'flux:session:composer-retirement';
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

let sessionGeneration = 0;
let retiredStorage = false;
const readRetirement = () => { try { return localStorage.getItem(RETIREMENT_KEY) ?? ''; } catch { return ''; } };
let storageRetirement = readRetirement();
let retirement = storageRetirement;
let retirementChannel: BroadcastChannel | null = null;
let externallyRetired = false;
const holders = new Set<() => void>();

/** The session's number: a writer remembers the one it began in, and is a late writer once it has changed. */
export const sessionNumber = () => sessionGeneration;
/** Whether this visit has retired a session, so no stored draft is read back into it. */
export const storageRetired = () => retiredStorage;

/** What the composer holds in memory (its records, picked files, running sends); called when a session is retired, if the composer is loaded. */
export function onRetire(clear: () => void) {
  holders.add(clear);
}

function retireDrafts() {
  sessionGeneration++;
  retiredStorage = true;
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const target = storage();
      for (const key of Object.keys(target)) {
        if (key.startsWith(PREFIX) || key.startsWith('flux:draft:')) target.removeItem(key);
      }
    } catch { /* Memory still clears; this visit never reimports a retired session's records. */ }
  }
  // The places the person kept (where they read, which panel was open) go with their drafts (#592).
  forgetPlaces();
  forgetReloadRetention('composer');
  for (const clear of holders) clear();
}

function receiveRetirement(id: unknown) {
  if (!uuid(id) || id === retirement) return;
  retirement = id;
  storageRetirement = readRetirement();
  externallyRetired = true;
  retireDrafts();
  // The shared cookie has ended: retire the old account's mounted tree as well.
  window.location.replace('/sign-in?notice=signed-out');
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => { if (event.key === RETIREMENT_KEY) receiveRetirement(event.newValue); });
  try {
    retirementChannel = new BroadcastChannel('flux:composer:device-session');
    retirementChannel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { type?: unknown; id?: unknown } | null;
      if (value?.type === 'retire') receiveRetirement(value.id);
    };
  } catch { /* The storage event remains available when browser channels are refused. */ }
}

/** Called only after confirmed sign-out. Old acknowledgements belong to a retired session. */
export function forgetComposerDrafts() {
  retirement = crypto.randomUUID();
  retireDrafts();
  try { localStorage.setItem(RETIREMENT_KEY, retirement); } catch { /* Visit-only storage uses the browser channel. */ }
  // A refused marker write leaves an older durable value; it is not a new remote logout.
  storageRetirement = readRetirement();
  try { retirementChannel?.postMessage({ type: 'retire', id: retirement }); } catch { /* Durable marker still fences old writers. */ }
}

/** Whether a writer that began in session `generation` may still write: no other tab has ended the session since, and this one has not either. */
export function sessionHolds(generation: number) {
  const observed = readRetirement();
  if (observed && observed !== storageRetirement) receiveRetirement(observed);
  return !externallyRetired && generation === sessionGeneration;
}
