import { createHash } from 'node:crypto';
import { FILE_LIMITS, type ConversationWindowQuery, type CreateMaterialCommand, type MaterialSource, type SendMessageCommand, type UpdateMaterialCommand } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requiredText(value: unknown, label: string, maximum: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > maximum) throw new InvalidInputError(`${label} must be 1–${maximum} characters`);
  return trimmed;
}

export function optionalBody(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 100_000) throw new InvalidInputError('Body must be at most 100000 characters');
  return value;
}

export function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidInputError(`${label} must be a UUID`);
  return value;
}

export function positiveVersion(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new InvalidInputError(`${label} must be a positive integer`);
  return value;
}

export function normalizeConversationWindow(query: ConversationWindowQuery = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be 1–100');
  const beforeSequence = query.beforeSequence === undefined ? null : Number(query.beforeSequence);
  if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))
    throw new InvalidInputError('beforeSequence must be a positive integer');
  return { limit, beforeSequence };
}

export function optionalUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new InvalidInputError('URL must be at most 2048 characters');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    return url.href;
  } catch { throw new InvalidInputError('URL must be an HTTP or HTTPS URL'); }
}

/** The files a message carries (#154): at most 10 distinct staged file ids, in the order given. */
export function normalizeAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FILE_LIMITS.messageFiles)
    throw new InvalidInputError(`attachmentIds must list at most ${FILE_LIMITS.messageFiles} files`);
  const ids = value.map((item, index) => uuid(item, `attachmentIds[${index}]`).toLowerCase());
  if (new Set(ids).size !== ids.length) throw new InvalidInputError('attachmentIds must be distinct');
  return ids;
}

/**
 * A message's text, source and attachments. The text may be empty only when files are attached (#154).
 * Without attachments the fingerprint keeps its original shape, so every stored receipt still replays.
 */
export function normalizeMessage(command: SendMessageCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('Message is required');
  const attachmentIds = normalizeAttachmentIds(command.attachmentIds);
  let body: string;
  if (attachmentIds.length) {
    if (typeof command.body !== 'string' || command.body.trim().length > 100_000) throw new InvalidInputError('Message must be at most 100000 characters');
    body = command.body.trim();
  } else body = requiredText(command.body, 'Message', 100_000);
  const clientMessageId = uuid(command.clientMessageId, 'clientMessageId');
  let source: MaterialSource | null = null;
  if (command.source !== undefined) {
    if (!command.source || typeof command.source !== 'object') throw new InvalidInputError('source must identify a material version');
    source = { materialId: uuid(command.source.materialId, 'source.materialId'), version: positiveVersion(command.source.version, 'source.version') };
  }
  return { body, clientMessageId, source, attachmentIds,
    fingerprint: fingerprint(attachmentIds.length ? { body, source, attachmentIds } : { body, source }) };
}

export function normalizeMaterial(command: CreateMaterialCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('Material is required');
  const title = requiredText(command.title, 'Title', 200);
  const body = optionalBody(command.body);
  const url = optionalUrl(command.url);
  if (!body.trim() && !url) throw new InvalidInputError('Material needs text or a link');
  const clientMutationId = uuid(command.clientMutationId, 'clientMutationId');
  const sourceDraftId = command.sourceDraftId === undefined ? null : uuid(command.sourceDraftId, 'sourceDraftId');
  const sourceDraftVersion = command.sourceDraftVersion === undefined ? null : positiveVersion(command.sourceDraftVersion, 'sourceDraftVersion');
  if ((sourceDraftId === null) !== (sourceDraftVersion === null)) throw new InvalidInputError('sourceDraftId and sourceDraftVersion must be given together');
  return { title, body, url, clientMutationId, sourceDraftId, sourceDraftVersion,
    fingerprint: fingerprint({ title, body, url, sourceDraftId, sourceDraftVersion }) };
}

export function normalizeMaterialUpdate(command: UpdateMaterialCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('Material update is required');
  const expectedVersion = positiveVersion(command.expectedVersion, 'expectedVersion');
  const clientMutationId = uuid(command.clientMutationId, 'clientMutationId');
  const title = command.title === undefined ? undefined : requiredText(command.title, 'Title', 200);
  const body = command.body === undefined ? undefined : optionalBody(command.body);
  const url = command.url === undefined ? undefined : optionalUrl(command.url);
  if (title === undefined && body === undefined && url === undefined) throw new InvalidInputError('Nothing to update');
  return { clientMutationId, expectedVersion, title, body, url,
    fingerprint: fingerprint({ expectedVersion, title, body, url }) };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
