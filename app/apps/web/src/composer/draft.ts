import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { FILE_LIMITS, type Conversation, type ConversationMessage, type SendMessageCommand, type StagedFile } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { reply, startConversation } from '../app/conversation-api';
import { sendDmMessage } from '../api/direct-messages';
import { contributeToTask, stageFile } from './api';
import { assumeReachable, connectionState, onConnectionChange, reportReachable, reportUnreachable } from './connection';
import { forgetReloadRetention, setReloadRetention } from '../app/reload-retention';

export interface DraftReference { materialId: string; version: number; title: string }
export interface DraftFile {
  uploadId: string; name: string; size: number;
  state: 'uploading' | 'failed' | 'ready';
  staged?: StagedFile; error?: string;
  /** The upload got no answer (offline): a queued message uploads it again when the connection is back. */
  offline?: boolean;
}
export interface ComposerDraft {
  version: 1; body: string; files: DraftFile[]; references: DraftReference[];
  commandId: string; unconfirmed: boolean;
}
/**
 * A sent message waiting for the server's confirmation (#264): what the draft held when Send was
 * pressed, with its command id. "sending" includes one queued behind another of the same composer.
 */
export interface PendingSend {
  id: string; body: string; files: DraftFile[]; references: DraftReference[];
  state: 'uploading' | 'sending' | 'waiting' | 'failed';
  /** Why it was not sent, beside "Not sent". */
  error?: string;
  /** A request was made, so the server may already hold it (the retry reuses the id). */
  attempted?: boolean;
  /** When it was sent, for display. */
  at: string;
  /** The newest message sequence (or root time) shown when it was sent: a newer copy from a refresh is this one. */
  after?: number | string;
  /** It had to wait for the connection. */
  waited?: boolean;
}
/** A confirmed message, kept for this visit so a view shows it until its own read includes it. */
export interface SentMessage { id: string; message: ConversationMessage; conversation?: Conversation }
export type SendOutcome =
  /** `waited`: it was stored only after waiting for the connection, not as the person sent it. */
  | { status: 'delivered'; message: ConversationMessage; conversation?: Conversation; waited: boolean }
  | { status: 'failed'; cause: unknown; restored: boolean }
  | { status: 'removed' };
interface Snapshot { draft: ComposerDraft; pending: PendingSend[]; sent: SentMessage[]; storage: 'device' | 'visit'; sending: boolean; error: string }
const snapshots = new Map<string, Snapshot>();
const listeners = new Map<string, Set<() => void>>();
/** Where each loaded record lives: direct messages keep theirs in the tab (session storage). */
const places = new Map<string, { accountId: string; projectId: string; context: string }>();
// The selected bytes live only in this visit. After reload, failed uploads ask for the same file.
const selected = new Map<string, Map<string, File>>();
const PREFIX = 'flux:composer:';
const RETIREMENT_KEY = 'flux:session:composer-retirement';
let sessionGeneration = 0;
let retiredStorage = false;
export const composerKey = (accountId: string, projectId: string, context: string) => `${PREFIX}${accountId}:${projectId}:${context}`;
const empty = (): ComposerDraft => ({ version: 1, body: '', files: [], references: [], commandId: crypto.randomUUID(), unconfirmed: false });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const storageFor = (context: string) => context.startsWith('dm:') ? sessionStorage : localStorage;
const blank = (draft: ComposerDraft) => !draft.body.trim() && !draft.files.length && !draft.references.length;

const readRetirement = () => { try { return localStorage.getItem(RETIREMENT_KEY) ?? ''; } catch { return ''; } };
let storageRetirement = readRetirement();
let retirement = storageRetirement;
let retirementChannel: BroadcastChannel | null = null;
let externallyRetired = false;
const running = new Set<string>();
const waiters = new Map<string, (outcome: SendOutcome) => void>();
const sentListeners = new Set<(sent: SentMessage) => void>();

/** Each stored message, wherever it was sent from: a stream can count a reply sent in a thread that has closed. */
export function onSent(listener: (sent: SentMessage) => void) {
  sentListeners.add(listener);
  return () => { sentListeners.delete(listener); };
}

function retireDrafts() {
  sessionGeneration++;
  retiredStorage = true;
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const target = storage();
      for (const key of Object.keys(target)) {
        if (key.startsWith(PREFIX) || key.startsWith('flux:draft:') || key.startsWith('flux.project-composer.') || key.startsWith('flux.dm-composer.')) target.removeItem(key);
      }
    } catch { /* Memory still clears; this visit never reimports a retired session's records. */ }
  }
  snapshots.clear();
  selected.clear();
  forgetReloadRetention('composer');
  running.clear();
  waiters.clear();
  // Keep subscriptions valid until the signed-in tree unmounts; any remaining view reads empty.
  listeners.forEach((set) => set.forEach((listener) => listener()));
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

/** A late writer of an earlier session (or a retired record) never writes. */
function alive(key: string, generation: number) {
  const observed = readRetirement();
  if (observed && observed !== storageRetirement) receiveRetirement(observed);
  return !externallyRetired && generation === sessionGeneration && snapshots.has(key);
}

const validFile = (file: DraftFile, projectId: string) => uuid(file.uploadId) && typeof file.name === 'string' && typeof file.size === 'number'
  && ['uploading', 'failed', 'ready'].includes(file.state) && (file.state !== 'ready' || (!!file.staged && uuid(file.staged.id) && file.staged.projectId === projectId));
const validRefs = (refs: unknown): refs is DraftReference[] => Array.isArray(refs) && refs.length <= 1
  && refs.every((ref: DraftReference) => uuid(ref.materialId) && Number.isInteger(ref.version) && typeof ref.title === 'string');
// A reload interrupts an upload: its bytes are gone, so the person selects the same file again.
const interrupted = (files: DraftFile[]) => files.map((file): DraftFile => file.state === 'uploading'
  ? { ...file, state: 'failed', offline: undefined, error: 'Upload was interrupted. Select the same file to retry.' } : file);

function load(key: string, accountId: string, projectId: string, context: string): Snapshot {
  if (snapshots.has(key)) return snapshots.get(key)!;
  places.set(key, { accountId, projectId, context });
  let draft = empty();
  let pending: PendingSend[] = [];
  let storage: Snapshot['storage'] = 'device';
  try {
    const stored = retiredStorage ? null : storageFor(context).getItem(key);
    if (stored) {
      const value = JSON.parse(stored) as ComposerDraft & { pending?: PendingSend[] };
      if (value.version === 1 && typeof value.body === 'string' && value.body.length <= 100000 && uuid(value.commandId)
        && Array.isArray(value.files) && value.files.length <= FILE_LIMITS.messageFiles && value.files.every((file) => validFile(file, projectId))
        && validRefs(value.references)) {
        const { pending: queued, ...rest } = value;
        draft = { ...rest, files: interrupted(value.files) };
        if (Array.isArray(queued)) {
          pending = queued.filter((item) => uuid(item.id) && typeof item.body === 'string' && item.body.length <= 100000 && Array.isArray(item.files)
            && item.files.length <= FILE_LIMITS.messageFiles && item.files.every((file) => validFile(file, projectId)) && validRefs(item.references)
            && ['uploading', 'sending', 'waiting', 'failed'].includes(item.state) && typeof item.at === 'string')
            // An outcome a reload interrupted is unknown: it is sent again, with the same id, when it can be.
            .map((item) => ({ ...item, files: interrupted(item.files), state: item.state === 'failed' ? 'failed' : 'waiting' }));
        }
      }
    } else if (!retiredStorage && context.startsWith('dm:')) {
      // The earlier direct-message composer kept its text and retry id in this tab.
      const oldKey = `flux.dm-composer.${accountId}.${context.slice('dm:'.length)}`;
      const body = sessionStorage.getItem(oldKey);
      if (body) {
        draft.body = body;
        const saved = JSON.parse(sessionStorage.getItem(`${oldKey}.pending`) ?? 'null') as { body?: string; clientMessageId?: string } | null;
        if (saved?.body === body.trim() && uuid(saved.clientMessageId)) { draft.commandId = saved.clientMessageId; draft.unconfirmed = true; }
      }
    } else if (!retiredStorage) {
      // Preserve existing text/retry identities while moving the three old composers into one record.
      const oldKey = context.startsWith('task:') ? `flux:draft:${accountId}:${context}` : `flux.project-composer.${accountId}.${projectId}.${context === 'new' ? 'new' : context.replace(/^conversation:/, '')}`;
      const body = context.startsWith('task:') ? localStorage.getItem(oldKey) : sessionStorage.getItem(oldKey);
      if (body && !context.startsWith('helper:')) {
        draft.body = body;
        const raw = context.startsWith('task:') ? localStorage.getItem(`${oldKey}:pending`) : sessionStorage.getItem(`${oldKey}.pending`);
        if (raw) {
          const saved = JSON.parse(raw) as { body?: string; id?: string; command?: SendMessageCommand; citation?: DraftReference };
          if ((saved.command?.body ?? saved.body) === body.trim() && uuid(saved.command?.clientMessageId ?? saved.id)) {
            draft.commandId = (saved.command?.clientMessageId ?? saved.id)!; draft.unconfirmed = true;
            if (saved.citation) draft.references = [saved.citation];
          }
        }
      }
    }
  } catch { storage = 'visit'; }
  const snapshot: Snapshot = { draft, pending, sent: [], storage, sending: false, error: '' };
  snapshots.set(key, snapshot);
  updateReloadRetention(key, snapshot, storage === 'visit' && (!blank(draft) || pending.length > 0));
  // Read during a render: queued messages are sent after it.
  if (pending.some((item) => item.state !== 'failed')) window.setTimeout(() => kick(key), 0);
  return snapshot;
}
function put(key: string, snapshot: Snapshot) {
  let storage: Snapshot['storage'] = 'device';
  const { draft, pending } = snapshot;
  try { storageFor(places.get(key)?.context ?? '').setItem(key, JSON.stringify(pending.length ? { ...draft, pending } : draft)); } catch { storage = 'visit'; }
  snapshots.set(key, { ...snapshot, storage });
  // A failed write of an empty clear can resurrect the older command/text too.
  updateReloadRetention(key, snapshot, storage === 'visit', true);
  listeners.get(key)?.forEach((listener) => listener());
}
function updateReloadRetention(key: string, snapshot: Snapshot, refused: boolean, invalidate = false) {
  const place = places.get(key);
  if (!place) return;
  const files = [...snapshot.draft.files, ...snapshot.pending.flatMap((item) => item.files)];
  const needsBytes = files.some((file) => file.state !== 'ready' && !!selected.get(key)?.has(file.uploadId));
  setReloadRetention('composer', key, place.accountId, refused || needsBytes, invalidate);
}
function edit(key: string, change: (draft: ComposerDraft) => ComposerDraft) {
  const snapshot = snapshots.get(key)!;
  if (snapshot.sending) return;
  put(key, { ...snapshot, error: '', draft: { ...change(snapshot.draft), commandId: crypto.randomUUID(), unconfirmed: false } });
}
export function composerError(cause: unknown) {
  if (cause instanceof NetworkError) return 'Flux could not be reached. Could not confirm the send. Your text is kept with its files and sources; retry when Flux is reachable.';
  if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) return cause.message;
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return 'Could not send: your access, a file or a source may be unavailable. Your draft, files and sources are kept. Remove and select an expired file again to recover it.';
  if (cause instanceof ApiError && cause.code === 'IDEMPOTENCY_CONFLICT') return 'This send conflicts with an earlier command. Your draft is kept. Edit it to start a new send.';
  return 'Could not confirm the send. Your text is kept with its files and sources; retry or edit it.';
}
/** Why Remove keeps a message: it returns to the field only while the field is empty. */
export const keepHint = 'Send or clear your text first, then remove it to edit it.';
/** What a retry cannot change: the message goes back to the field to be fixed there. */
const lasting = (cause: unknown) => cause instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(cause.status);
/** The reason beside "Not sent" on the message itself. */
function notSentReason(cause: unknown) {
  if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) return cause.message;
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return 'Your access, a file or a source may be unavailable. Remove it to edit it.';
  if (cause instanceof ApiError && cause.code === 'IDEMPOTENCY_CONFLICT') return 'It conflicts with an earlier send. Remove it to edit it.';
  if (lasting(cause)) return 'Flux could not accept it. Remove it to edit it.';
  return '';
}
function uploadError(cause: unknown) {
  if (cause instanceof NetworkError) return 'Flux is unreachable. Retry the upload.';
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return 'Upload unavailable with your current access. Your draft is kept.';
  if (cause instanceof ApiError && cause.code === 'UPLOAD_CONFLICT') return 'Upload conflicts with the earlier bytes. Remove it and select the file again.';
  return cause instanceof ApiError ? cause.message : 'Could not confirm this upload. Retry it.';
}

/** The one operation each composer publishes through; the task operation is shared by every task view. */
async function deliver(projectId: string, context: string, command: SendMessageCommand): Promise<SentMessage> {
  if (context === 'new') {
    const conversation = await startConversation(projectId, command);
    return { id: command.clientMessageId, message: conversation.messages.find((item) => item.sequence === 1) ?? conversation.messages[0]!, conversation };
  }
  if (context.startsWith('conversation:')) return { id: command.clientMessageId, message: await reply(context.slice('conversation:'.length), command) };
  if (context.startsWith('task:')) return { id: command.clientMessageId, message: await contributeToTask(context.slice('task:'.length), { ...command, kind: 'text' }) };
  if (context.startsWith('dm:')) return { id: command.clientMessageId, message: await sendDmMessage(context.slice('dm:'.length), { body: command.body, clientMessageId: command.clientMessageId }) };
  throw new Error('This composer does not publish messages.');
}

function settle(id: string, outcome: SendOutcome) {
  const resolve = waiters.get(id);
  waiters.delete(id);
  resolve?.(outcome);
}
function forgetBytes(key: string, files: DraftFile[]) {
  const bytes = selected.get(key);
  for (const file of files) bytes?.delete(file.uploadId);
}
function changePending(key: string, id: string, change: (item: PendingSend) => PendingSend) {
  const current = snapshots.get(key)!;
  put(key, { ...current, pending: current.pending.map((item) => item.id === id ? change(item) : item) });
}
/** A refused message returns to an empty field with its command, files and source; otherwise it stays, "Not sent". */
function refuse(key: string, queued: PendingSend, cause: unknown, reason: string) {
  const current = snapshots.get(key)!;
  // The queue's own copy: it knows whether a request was made (the server may then hold the command).
  const item = current.pending.find((other) => other.id === queued.id) ?? queued;
  if (blank(current.draft)) {
    put(key, { ...current, error: reason, pending: current.pending.filter((other) => other.id !== item.id),
      draft: { version: 1, body: item.body, files: item.files, references: item.references, commandId: item.id, unconfirmed: !!item.attempted } });
    settle(item.id, { status: 'failed', cause, restored: true });
  } else {
    changePending(key, item.id, (other) => ({ ...other, state: 'failed', error: notSentReason(cause) || reason }));
    settle(item.id, { status: 'failed', cause, restored: false });
  }
}

/**
 * Sends one composer's queue in order, one request at a time. Failed messages wait for Retry or
 * Remove and do not hold back the ones after them; while Flux cannot be reached nothing is sent.
 */
function kick(key: string) {
  if (running.has(key) || !snapshots.has(key)) return;
  const place = places.get(key);
  const snapshot = snapshots.get(key)!;
  const item = snapshot.pending.find((other) => other.state !== 'failed');
  if (!item || !place) return;
  if (connectionState() !== 'online') {
    // A send or an upload under way now waits, and says why (HIG-67).
    const going = (other: PendingSend) => other.state === 'sending' || other.state === 'uploading';
    if (snapshot.pending.some(going)) put(key, { ...snapshot, pending: snapshot.pending.map((other) => going(other) ? { ...other, state: 'waiting', waited: true } : other) });
    return;
  }
  const generation = sessionGeneration;
  const failedFiles = item.files.filter((file) => file.state === 'failed');
  if (failedFiles.length) {
    const bytes = selected.get(key);
    if (failedFiles.every((file) => file.offline && bytes?.has(file.uploadId))) {
      changePending(key, item.id, (other) => ({ ...other, state: 'uploading', files: other.files.map((file) => file.state === 'failed' ? { ...file, state: 'uploading', error: undefined, offline: undefined } : file) }));
      void (async () => { for (const file of failedFiles) await upload(key, place.projectId, file.uploadId, bytes!.get(file.uploadId)!, generation); })();
      return;
    }
    refuse(key, item, null, failedFiles[0]!.error ?? 'A file could not be uploaded. Select it again.');
    kick(key);
    return;
  }
  if (item.files.some((file) => file.state === 'uploading')) {
    if (item.state !== 'uploading') changePending(key, item.id, (other) => ({ ...other, state: 'uploading' }));
    return;
  }
  const ref = item.references[0];
  const command: SendMessageCommand = { body: item.body, clientMessageId: item.id,
    ...(item.files.length ? { attachmentIds: item.files.map((file) => file.staged!.id) } : {}),
    ...(ref ? { source: { materialId: ref.materialId, version: ref.version } } : {}) };
  running.add(key);
  changePending(key, item.id, (other) => ({ ...other, state: 'sending', error: undefined, attempted: true }));
  void deliver(place.projectId, place.context, command).then((sent) => {
    running.delete(key);
    if (!alive(key, generation)) { reportReachable(); return; }
    const current = snapshots.get(key)!;
    forgetBytes(key, item.files);
    // The queued message and the stored one change places in one update: never both, never neither.
    put(key, { ...current, pending: current.pending.filter((other) => other.id !== item.id),
      sent: current.sent.some((other) => other.message.id === sent.message.id) ? current.sent : [...current.sent, sent] });
    sentListeners.forEach((listener) => listener(sent));
    const latest = current.pending.find((other) => other.id === item.id);
    settle(item.id, { status: 'delivered', message: sent.message, conversation: sent.conversation, waited: !!(latest ?? item).waited });
    // Only now, with this message out of the queue: being reachable again sends what waits.
    reportReachable();
    kick(key);
  }, (cause: unknown) => {
    running.delete(key);
    if (!alive(key, generation)) return;
    if (!snapshots.get(key)!.pending.some((other) => other.id === item.id)) { kick(key); return; }
    if (cause instanceof NetworkError) {
      // No answer: it may be stored already. It waits and goes again, with this id, when Flux answers.
      changePending(key, item.id, (other) => ({ ...other, state: 'waiting', waited: true }));
      reportUnreachable();
      kick(key);
      return;
    }
    if (lasting(cause)) refuse(key, item, cause, composerError(cause));
    else {
      changePending(key, item.id, (other) => ({ ...other, state: 'failed', error: notSentReason(cause) }));
      settle(item.id, { status: 'failed', cause, restored: false });
    }
    // Flux answered, so it is reachable; the next queued message goes after this one's outcome.
    reportReachable();
    kick(key);
  });
}
onConnectionChange(() => { for (const key of snapshots.keys()) kick(key); });

/** Stages one file, wherever it is now: still in the draft, or in a message sent before it finished. */
async function upload(key: string, projectId: string, uploadId: string, file: File, generation: number) {
  const holds = () => {
    const current = snapshots.get(key)!;
    return current.draft.files.some((item) => item.uploadId === uploadId) || current.pending.some((item) => item.files.some((other) => other.uploadId === uploadId));
  };
  if (!alive(key, generation) || !holds()) return;
  const changeFile = (change: (item: DraftFile) => DraftFile) => {
    if (!alive(key, generation) || !holds()) return;
    const current = snapshots.get(key)!;
    const map = (files: DraftFile[]) => files.map((item) => item.uploadId === uploadId ? change(item) : item);
    put(key, { ...current, draft: { ...current.draft, files: map(current.draft.files) },
      pending: current.pending.map((item) => item.files.some((other) => other.uploadId === uploadId) ? { ...item, files: map(item.files) } : item) });
    // A message waiting for this file can go on (or fail) now.
    if (snapshots.get(key)!.pending.some((item) => item.files.some((other) => other.uploadId === uploadId))) kick(key);
  };
  changeFile((item) => ({ ...item, state: 'uploading', error: undefined, offline: undefined }));
  try {
    const staged = await stageFile(projectId, uploadId, file);
    reportReachable();
    changeFile((item) => ({ ...item, state: 'ready', staged, error: undefined }));
  } catch (cause) {
    if (cause instanceof NetworkError) reportUnreachable();
    changeFile((item) => ({ ...item, state: 'failed', error: uploadError(cause), offline: cause instanceof NetworkError || undefined }));
  }
}

/** A scope-captured store: late A completions can never write to B, even after A → B → A. */
export function useComposerDraft(accountId: string, projectId: string, context: string) {
  const key = composerKey(accountId, projectId, context);
  const generation = sessionGeneration;
  const active = () => alive(key, generation);
  const read = useCallback(() => load(key, accountId, projectId, context), [key, accountId, projectId, context]);
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
  }, [key]);
  const snapshot = useSyncExternalStore(subscribe, read);
  const { draft } = snapshot;

  function addFiles(files: File[]) {
    if (!active()) return;
    const current = snapshots.get(key)!;
    if (current.sending) return;
    if (current.draft.files.length + files.length > FILE_LIMITS.messageFiles) {
      put(key, { ...current, error: 'Attach at most 10 files. Your existing draft and files are kept.' }); return;
    }
    if (current.draft.files.reduce((total, item) => total + item.size, 0) + files.reduce((total, file) => total + file.size, 0) > FILE_LIMITS.messageBytes) {
      put(key, { ...current, error: 'Files in one message can total at most 20 MiB. Your existing draft and files are kept.' }); return;
    }
    const bytes = selected.get(key) ?? new Map(); selected.set(key, bytes);
    const additions = files.map((file): DraftFile => {
      const uploadId = crypto.randomUUID(); bytes.set(uploadId, file);
      const error = file.size === 0 ? 'Empty files cannot be attached.' : file.size > FILE_LIMITS.fileBytes ? 'A file can be at most 5 MiB.'
        : file.name.length > FILE_LIMITS.nameChars || [...file.name].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127 || character === '/' || character === '\\')
          || ['.', '..'].includes(file.name) ? 'Choose a file with a shorter name without path characters.' : undefined;
      return { uploadId, name: file.name, size: file.size, state: error ? 'failed' : 'uploading', ...(error ? { error } : {}) };
    });
    edit(key, (value) => ({ ...value, files: [...value.files, ...additions] }));
    // Sequential admission keeps quota and ordered selection deterministic.
    void (async () => {
      for (const item of additions) {
        if (!active()) return;
        if (item.state === 'uploading') await upload(key, projectId, item.uploadId, bytes.get(item.uploadId)!, generation);
      }
    })();
  }
  function retryFile(uploadId: string, replacement?: File) {
    if (!active()) return false;
    const item = snapshots.get(key)!.draft.files.find((file) => file.uploadId === uploadId);
    if (!item || snapshots.get(key)!.sending) return;
    const file = replacement ?? selected.get(key)?.get(uploadId);
    if (!file) return false;
    if (file.name !== item.name || file.size !== item.size) {
      const current = snapshots.get(key)!; put(key, { ...current, error: 'Select the same file name and size to recover this upload. Remove it to choose another file.' }); return false;
    }
    if (file.size === 0 || file.size > FILE_LIMITS.fileBytes) return false;
    const bytes = selected.get(key) ?? new Map(); bytes.set(uploadId, file); selected.set(key, bytes);
    void upload(key, projectId, uploadId, file, generation); return true;
  }
  /** The private helper's send: the prompt stays in the field until its run is confirmed. */
  function begin(): SendMessageCommand | null {
    if (!active()) return null;
    const current = snapshots.get(key)!;
    const value = current.draft;
    if (current.sending || value.files.some((file) => file.state !== 'ready') || (!value.body.trim() && !value.files.length)) return null;
    const ref = value.references[0];
    const command: SendMessageCommand = { body: value.body.trim(), clientMessageId: value.commandId,
      ...(value.files.length ? { attachmentIds: value.files.map((file) => file.staged!.id) } : {}),
      ...(ref ? { source: { materialId: ref.materialId, version: ref.version } } : {}) };
    put(key, { ...current, sending: true, error: '', draft: { ...value, unconfirmed: true } });
    return command;
  }
  function finish(commandId: string, cause?: unknown) {
    if (!active()) return;
    const current = snapshots.get(key)!;
    const confirmed = cause === undefined && current.draft.commandId === commandId;
    if (confirmed) selected.delete(key);
    put(key, { ...current, sending: false, error: cause === undefined ? '' : composerError(cause), draft: confirmed ? empty() : current.draft });
  }
  /**
   * Publishes the draft (#264): it joins the queue with its command and the field empties at once.
   * Resolves with the first outcome of that message: stored, refused, or removed by the person.
   * Returns null when there is nothing to send (a second tap after the first).
   */
  function submit(after?: number | string): Promise<SendOutcome> | null {
    if (!active()) return null;
    const current = snapshots.get(key)!;
    const value = current.draft;
    if (current.sending || value.files.some((file) => file.state === 'failed') || (!value.body.trim() && !value.files.length)) return null;
    const item: PendingSend = { id: value.commandId, body: value.body.trim(), files: value.files, references: value.references,
      state: connectionState() !== 'online' ? 'waiting' : value.files.some((file) => file.state === 'uploading') ? 'uploading' : 'sending',
      attempted: value.unconfirmed || undefined, waited: connectionState() !== 'online' || undefined, at: new Date().toISOString(), ...(after === undefined ? {} : { after }) };
    const outcome = new Promise<SendOutcome>((resolve) => { waiters.set(item.id, resolve); });
    put(key, { ...current, error: '', draft: empty(), pending: [...current.pending.filter((other) => other.id !== item.id), item] });
    kick(key);
    return outcome;
  }
  /** Sends a message that was not sent again, with its own command. */
  function retry(id: string) {
    if (!active()) return;
    const current = snapshots.get(key)!;
    const item = current.pending.find((other) => other.id === id);
    if (!item || (item.state !== 'failed' && item.state !== 'waiting')) return;
    const bytes = selected.get(key);
    // A file that could not be staged goes again from this visit's bytes, or back to the field to be selected again.
    const failedFiles = item.files.filter((file) => file.state === 'failed');
    if (failedFiles.some((file) => !bytes?.has(file.uploadId))) {
      // Its bytes are gone (a reload): only the field can select the file again.
      if (blank(current.draft)) remove(id);
      else changePending(key, id, (other) => ({ ...other, error: 'Select the file again: send or clear your current text, then remove this message to edit it.' }));
      return;
    }
    changePending(key, id, (other) => ({ ...other, error: undefined, waited: false, state: connectionState() === 'offline' ? 'waiting' : failedFiles.length ? 'uploading' : 'sending',
      files: other.files.map((file) => file.state === 'failed' ? { ...file, offline: true } : file) }));
    // Asked for now: unless the browser itself is offline, this attempt is the check that Flux answers.
    if (connectionState() === 'unreachable') assumeReachable();
    kick(key);
  }
  /** Takes a waiting or unsent message out; into an empty field it returns as the draft, with its command. */
  function remove(id: string) {
    if (!active()) return;
    const current = snapshots.get(key)!;
    const item = current.pending.find((other) => other.id === id);
    if (!item || item.state === 'sending' || item.state === 'uploading') return;
    if (!blank(current.draft) || current.sending) {
      // The field holds other text: the message stays, never lost, and says what to do first (HIG-70).
      changePending(key, id, (other) => {
        const why = (other.error ?? '').replace(/\s*(Send or clear your text first, then remove it to edit it|Remove it to edit it)\.$/, '');
        return { ...other, error: `${why ? `${why} ` : ''}${keepHint}` };
      });
      return;
    }
    put(key, { ...current, error: '', pending: current.pending.filter((other) => other.id !== id),
      draft: { version: 1, body: item.body, files: item.files, references: item.references, commandId: item.id, unconfirmed: !!item.attempted } });
    settle(id, { status: 'removed' });
  }
  return { ...snapshot, key, canSend: !snapshot.sending && draft.files.every((file) => file.state !== 'failed') && (!!draft.body.trim() || !!draft.files.length),
    setBody: (body: string) => { if (active()) edit(key, (value) => ({ ...value, body })); },
    // A completed command consumes its original record, even if that pane is no longer selected.
    // A newer edit or a retired session keeps its text; commandId changes on every draft edit.
    consumeBody: (submitted: Pick<ComposerDraft, 'body' | 'commandId'>) => {
      if (!active()) return;
      const current = snapshots.get(key)!;
      if (current.draft.body === submitted.body && current.draft.commandId === submitted.commandId)
        edit(key, (value) => ({ ...value, body: '' }));
    },
    setReference: (reference: DraftReference | null) => { if (active()) edit(key, (value) => ({ ...value, references: reference ? [reference] : [] })); },
    removeFile: (uploadId: string) => { if (!active() || snapshots.get(key)!.sending) return; selected.get(key)?.delete(uploadId); edit(key, (value) => ({ ...value, files: value.files.filter((file) => file.uploadId !== uploadId) })); },
    addFiles, retryFile, begin, finish, submit, retry, remove,
  };
}
export type ComposerState = ReturnType<typeof useComposerDraft>;

/** UI callbacks belong to one mount/generation; store completion still updates the original scope. */
export function useComposerScope(key: string) {
  const generation = useMemo(() => Symbol(key), [key]);
  const current = useRef<symbol | null>(null);
  useLayoutEffect(() => { current.current = generation; return () => { current.current = null; }; }, [generation]);
  return () => () => current.current === generation;
}

const filesKey = (names: readonly { name: string }[] | undefined) => (names ?? []).map((file) => file.name).join('\n');
/**
 * What a view shows of its queue (#264): confirmed messages join `messages` (by id), and each one
 * keeps the list key of the queued message it replaces, so the same item stays in place. A queued
 * message still in flight whose stored copy already came with a refresh (same author, text and
 * files, newer than what was shown when it was sent) is hidden rather than shown twice.
 */
export function outboxView<M extends ConversationMessage>(messages: readonly M[], pending: readonly PendingSend[], sent: readonly SentMessage[], meId: string) {
  const keys = new Map<string, string>(sent.map((item) => [item.message.id, item.id]));
  const claimed = new Set(keys.keys());
  const visible = pending.filter((item) => {
    // Only a message that will be sent again on its own: a "Not sent" one waits for the person's Retry.
    if (!item.attempted || item.after === undefined || item.state === 'failed') return true;
    const copy = messages.find((message) => !claimed.has(message.id) && message.authorId === meId && message.body === item.body
      && filesKey(message.files) === filesKey(item.files)
      && (typeof item.after === 'number' ? message.sequence > item.after : message.createdAt > (item.after as string)));
    if (!copy) return true;
    claimed.add(copy.id);
    keys.set(copy.id, item.id);
    return false;
  });
  return { pending: visible, keyOf: (id: string) => keys.has(id) ? `pending-${keys.get(id)}` : id };
}
