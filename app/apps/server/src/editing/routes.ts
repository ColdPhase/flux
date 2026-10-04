import type { FastifyInstance, FastifyReply } from 'fastify';
import { liveDocPath, liveDocEnrollPath, liveDocSavePath, liveDocReceiptPath, liveMapPath, liveMapGesturePath, liveMapUndoPath,
  type EnrollLiveDoc, type SaveSharedDoc } from '@flux/contracts';
import { DomainError, InvalidInputError, ServiceUnavailableError } from '@flux/core';
import { EditingTransactionError } from '@flux/db';
import type { SessionResolver } from '../identity/session.js';
import { expectedVersion } from '../http/commands.js';
import type { WikiAuthority } from './authority.js';
import { EditingHTTPAdmission } from './http-admission.js';
import { editingContextCharge } from './context-charge.js';
import { EditingOutputBudget, EditingOutputError } from './output.js';

interface Options { sessions: SessionResolver; authority: WikiAuthority | null; outputBudget: EditingOutputBudget }
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const uuid = { type: 'string', pattern: UUID } as const;
const enrollment = { type: 'object', additionalProperties: false, required: ['generation','replicaId'], properties: {
  generation: uuid, replicaId: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, instanceId: uuid } } as const;
const snapshot = { type: 'object', additionalProperties: false, required: ['clientCommandId','expectedVersion','generation','headSequence','headHash'], properties: {
  clientCommandId: uuid, expectedVersion: { type: 'integer', minimum: 1 }, generation: uuid,
  headSequence: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, headHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  title: { type: 'string', minLength: 1, maxLength: 200 }, state: { type: 'string', enum: ['draft','published'] }, reason: { type: 'string', maxLength: 1000 } } } as const;

function closed(body: unknown, allowed: string[]) {
  if (body && typeof body === 'object' && Object.keys(body).some((key) => !allowed.includes(key))) throw new InvalidInputError('Unknown immutable command parameter');
}

/** Explicit current-rights synchronous HTTP handoff, with a bounded response retained until finish/close. */
function send(reply: FastifyReply, body: unknown, release: () => void) {
  const text = JSON.stringify(body); const bytes = Buffer.byteLength(text);
  if (bytes > 8 * 1024 * 1024) throw new ServiceUnavailableError('The protected response reached its bounded capacity', 'EDITING_OUTPUT_CAPACITY');
  const owned = Buffer.allocUnsafeSlow(bytes); owned.write(text);
  reply.hijack(); reply.raw.once('finish', release); reply.raw.once('close', release);
  reply.raw.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes, 'cache-control': 'no-store' });
  reply.raw.end(owned);
}
/** Ordinary routes return one truthful disabled capability until development composition is explicitly selected. */
export async function editingRoutes(app: FastifyInstance, { sessions, authority, outputBudget }: Options) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EditingTransactionError) return reply.code(503).send({ code: 'EDITING_OUTCOME_UNKNOWN', error: error.message, outcome: 'unknown', retryable: true });
    if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, error: error.message, outcome: 'refused' });
    if (error.statusCode === 401) return reply.code(401).send({ code: 'UNAUTHENTICATED', error: 'Authentication required', outcome: 'refused' });
    if (error instanceof EditingOutputError || 'code' in error && ['EXTERNAL_BUFFER_LIMIT','WORK_QUEUE_LIMIT','ROOM_CACHE_LIMIT','ADMISSION_TIMEOUT','ADMISSION_METADATA_LIMIT','EDITING_PRESENCE_CAPACITY'].includes(String(error.code))) return reply.code(503).send({ code: error.code, error: 'The finite live capacity is busy', outcome: 'refused', retryable: true });
    throw error;
  });
  app.addHook('preValidation', async () => { if (!authority) throw new ServiceUnavailableError('Live editing is disabled until all four accepted gates pass', 'LIVE_EDITING_DISABLED'); });
  const admission = new EditingHTTPAdmission(outputBudget);
  app.addHook('onClose', async () => admission.close());
  async function response(reply: FastifyReply, context: unknown, action: (release: () => void) => Promise<void>) {
    // Covers the exact bounded native/live response, its serialization and owned wire copy before the first SQL await.
    const release = await admission.admit(editingContextCharge(context));
    try { await action(release); } catch (error) { release(); throw error; }
  }
  app.get<{ Params: { docId: string } }>(liveDocPath(':docId'), async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request);
    const head = await authority!.bootstrap(session, request.params.docId);
    await authority!.handoff(session, request.params.docId, () => send(reply, head, release));
  }));
  app.post<{ Params: { docId: string }; Body: EnrollLiveDoc }>(liveDocEnrollPath(':docId'), { bodyLimit: 4096, preValidation: async (request) => closed(request.body, ['generation','replicaId','instanceId']), schema: { body: enrollment } }, async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request); const result = await authority!.enroll(session, request.params.docId, request.body);
    await authority!.handoff(session, request.params.docId, () => send(reply, result, release));
  }));
  app.post<{ Params: { docId: string }; Body: SaveSharedDoc }>(liveDocSavePath(':docId'), { bodyLimit: 8192, preValidation: async (request) => closed(request.body, ['clientCommandId','expectedVersion','generation','headSequence','headHash','title','state','reason']), schema: { body: snapshot } }, async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request);
    if (expectedVersion(request) !== request.body.expectedVersion || request.headers['idempotency-key'] !== undefined && request.headers['idempotency-key'] !== request.body.clientCommandId) throw new InvalidInputError('Snapshot headers and immutable parameters disagree');
    await authority!.save(session, request.params.docId, request.body);
    await authority!.deliverReceipt(session, request.params.docId, request.body.clientCommandId, (receipt) => send(reply, receipt, release));
  }));
  app.get<{ Params: { docId: string; commandId: string } }>(liveDocReceiptPath(':docId', ':commandId'), async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request);
    await authority!.deliverReceipt(session, request.params.docId, request.params.commandId, (receipt) => send(reply, receipt, release));
  }));
  // Map composition follows the native journal/lease/atomic undo slice. These cannot masquerade as a usable live map yet.
  const pendingMap = async () => { throw new ServiceUnavailableError('The live map adapter is not composed yet', 'EDITING_MAP_UNAVAILABLE'); };
  app.get(liveMapPath(':sketchId'), pendingMap); app.post(liveMapGesturePath(':sketchId'), pendingMap); app.post(liveMapUndoPath(':sketchId'), pendingMap);
}
