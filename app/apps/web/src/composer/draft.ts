import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { FILE_LIMITS, type SendMessageCommand, type StagedFile } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { stageFile } from './api';

export interface DraftReference { materialId: string; version: number; title: string }
export interface DraftFile {
  uploadId: string; name: string; size: number;
  state: 'uploading' | 'failed' | 'ready';
  staged?: StagedFile; error?: string;
}
export interface ComposerDraft {
  version: 1; body: string; files: DraftFile[]; references: DraftReference[];
  commandId: string; unconfirmed: boolean;
}
interface Snapshot { draft: ComposerDraft; storage: 'device' | 'visit'; sending: boolean; error: string }
const snapshots = new Map<string, Snapshot>();
const listeners = new Map<string, Set<() => void>>();
// The selected bytes live only in this visit. After reload, failed uploads ask for the same file.
const selected = new Map<string, Map<string, File>>();
const PREFIX = 'flux:composer:';
let sessionGeneration = 0;
let retiredStorage = false;
export const composerKey = (accountId: string, projectId: string, context: string) => `${PREFIX}${accountId}:${projectId}:${context}`;
const empty = (): ComposerDraft => ({ version: 1, body: '', files: [], references: [], commandId: crypto.randomUUID(), unconfirmed: false });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Called only after confirmed sign-out. Old acknowledgements belong to a retired session. */
export function forgetComposerDrafts() {
  sessionGeneration++;
  retiredStorage = true;
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const target = storage();
      for (const key of Object.keys(target)) {
        if (key.startsWith(PREFIX) || key.startsWith('flux:draft:') || key.startsWith('flux.project-composer.')) target.removeItem(key);
      }
    } catch { /* Memory still clears; this visit never reimports a retired session's records. */ }
  }
  snapshots.clear();
  selected.clear();
  // Keep subscriptions valid until the signed-in tree unmounts; any remaining view reads empty.
  listeners.forEach((set) => set.forEach((listener) => listener()));
}

function load(key: string, accountId: string, projectId: string, context: string): Snapshot {
  if (snapshots.has(key)) return snapshots.get(key)!;
  let draft = empty();
  let storage: Snapshot['storage'] = 'device';
  try {
    const stored = retiredStorage ? null : localStorage.getItem(key);
    if (stored) {
      const value = JSON.parse(stored) as ComposerDraft;
      if (value.version === 1 && typeof value.body === 'string' && value.body.length <= 100000 && uuid(value.commandId)
        && Array.isArray(value.files) && value.files.length <= FILE_LIMITS.messageFiles && value.files.every((file) => uuid(file.uploadId)
          && typeof file.name === 'string' && typeof file.size === 'number' && ['uploading', 'failed', 'ready'].includes(file.state)
          && (file.state !== 'ready' || (file.staged && uuid(file.staged.id) && file.staged.projectId === projectId)))
        && Array.isArray(value.references) && value.references.length <= 1 && value.references.every((ref) => uuid(ref.materialId) && Number.isInteger(ref.version) && typeof ref.title === 'string')) {
        draft = { ...value, files: value.files.map((file) => file.state === 'uploading'
          ? { ...file, state: 'failed', error: 'Upload was interrupted. Select the same file to retry.' } : file) };
      }
    } else if (!retiredStorage) {
      // Preserve existing text/retry identities while moving the three old composers into one record.
      const oldKey = context.startsWith('task:') ? `flux:draft:${accountId}:${context}` : `flux.project-composer.${accountId}.${projectId}.${context === 'new' ? 'new' : context.replace(/^conversation:/, '')}`;
      const body = context.startsWith('task:') ? localStorage.getItem(oldKey) : sessionStorage.getItem(oldKey);
      if (body && !context.startsWith('helper:')) {
        draft.body = body;
        const raw = context.startsWith('task:') ? localStorage.getItem(`${oldKey}:pending`) : sessionStorage.getItem(`${oldKey}.pending`);
        if (raw) {
          const pending = JSON.parse(raw) as { body?: string; id?: string; command?: SendMessageCommand; citation?: DraftReference };
          if ((pending.command?.body ?? pending.body) === body.trim() && uuid(pending.command?.clientMessageId ?? pending.id)) {
            draft.commandId = (pending.command?.clientMessageId ?? pending.id)!; draft.unconfirmed = true;
            if (pending.citation) draft.references = [pending.citation];
          }
        }
      }
    }
  } catch { storage = 'visit'; }
  const snapshot = { draft, storage, sending: false, error: '' };
  snapshots.set(key, snapshot);
  return snapshot;
}
function put(key: string, snapshot: Snapshot) {
  let storage: Snapshot['storage'] = 'device';
  try { localStorage.setItem(key, JSON.stringify(snapshot.draft)); } catch { storage = 'visit'; }
  snapshots.set(key, { ...snapshot, storage });
  listeners.get(key)?.forEach((listener) => listener());
}
function edit(key: string, change: (draft: ComposerDraft) => ComposerDraft) {
  const snapshot = snapshots.get(key)!;
  if (snapshot.sending) return;
  put(key, { ...snapshot, error: '', draft: { ...change(snapshot.draft), commandId: crypto.randomUUID(), unconfirmed: false } });
}
export function composerError(cause: unknown) {
  if (cause instanceof NetworkError) return 'Flux could not be reached. Could not confirm the send. Your text is kept with its files and sources; retry when Flux is reachable.';
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return 'Could not send: your access, a file or a source may be unavailable. Your draft, files and sources are kept. Remove and select an expired file again to recover it.';
  if (cause instanceof ApiError && cause.code === 'IDEMPOTENCY_CONFLICT') return 'This send conflicts with an earlier command. Your draft is kept. Edit it to start a new send.';
  return 'Could not confirm the send. Your text is kept with its files and sources; retry or edit it.';
}
function uploadError(cause: unknown) {
  if (cause instanceof NetworkError) return 'Flux is unreachable. Retry the upload.';
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return 'Upload unavailable with your current access. Your draft is kept.';
  if (cause instanceof ApiError && cause.code === 'UPLOAD_CONFLICT') return 'Upload conflicts with the earlier bytes. Remove it and select the file again.';
  return cause instanceof ApiError ? cause.message : 'Could not confirm this upload. Retry it.';
}

/** A scope-captured store: late A completions can never write to B, even after A → B → A. */
export function useComposerDraft(accountId: string, projectId: string, context: string) {
  const key = composerKey(accountId, projectId, context);
  const generation = sessionGeneration;
  const active = () => generation === sessionGeneration && snapshots.has(key);
  const read = useCallback(() => load(key, accountId, projectId, context), [key, accountId, projectId, context]);
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
  }, [key]);
  const snapshot = useSyncExternalStore(subscribe, read);
  const { draft } = snapshot;

  async function upload(uploadId: string, file: File) {
    if (!active() || !snapshots.get(key)!.draft.files.some((item) => item.uploadId === uploadId)) return;
    const changeFile = (change: (item: DraftFile) => DraftFile) => {
      if (!active()) return;
      const current = snapshots.get(key)!;
      if (!current.draft.files.some((item) => item.uploadId === uploadId)) return;
      put(key, { ...current, draft: { ...current.draft, files: current.draft.files.map((item) => item.uploadId === uploadId ? change(item) : item) } });
    };
    changeFile((item) => ({ ...item, state: 'uploading', error: undefined }));
    try {
      const staged = await stageFile(projectId, uploadId, file);
      changeFile((item) => ({ ...item, state: 'ready', staged, error: undefined }));
    } catch (cause) { changeFile((item) => ({ ...item, state: 'failed', error: uploadError(cause) })); }
  }
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
        if (item.state === 'uploading') await upload(item.uploadId, bytes.get(item.uploadId)!);
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
    void upload(uploadId, file); return true;
  }
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
  return { ...snapshot, key, canSend: !snapshot.sending && draft.files.every((file) => file.state === 'ready') && (!!draft.body.trim() || !!draft.files.length),
    setBody: (body: string) => { if (active()) edit(key, (value) => ({ ...value, body })); },
    setReference: (reference: DraftReference | null) => { if (active()) edit(key, (value) => ({ ...value, references: reference ? [reference] : [] })); },
    removeFile: (uploadId: string) => { if (!active() || snapshots.get(key)!.sending) return; selected.get(key)?.delete(uploadId); edit(key, (value) => ({ ...value, files: value.files.filter((file) => file.uploadId !== uploadId) })); },
    addFiles, retryFile, begin, finish,
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
