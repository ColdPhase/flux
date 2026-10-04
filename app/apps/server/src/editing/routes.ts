import type { FastifyInstance, FastifyReply } from 'fastify';
import { liveDocPath, liveDocEnrollPath, liveDocSavePath, liveDocReceiptPath, liveMapPath, liveMapGesturePath, liveMapUndoPath,
  type EnrollLiveDoc, type SaveSharedDoc,type LiveMapGesture,type UndoLiveMap } from '@flux/contracts';
import { DomainError, InvalidInputError, ServiceUnavailableError } from '@flux/core';
import { EditingTransactionError } from '@flux/db';
import type { SessionResolver } from '../identity/session.js';
import { expectedVersion } from '../http/commands.js';
import type { WikiAuthority } from './authority.js';
import type { MapAuthority } from './map-authority.js';
import { editingJSONSize } from './json-size.js';
import { EditingHTTPAdmission, type EditingPreparation } from './http-admission.js';
import { editingContextCharge } from './context-charge.js';
import { EditingOutputBudget, EditingOutputError } from './output.js';

interface Options { sessions: SessionResolver; authority: WikiAuthority | null; outputBudget: EditingOutputBudget;maps?:MapAuthority|null }
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
export async function editingRoutes(app: FastifyInstance, { sessions, authority, outputBudget,maps=null }: Options) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EditingTransactionError) return reply.code(503).send({ code: 'EDITING_OUTCOME_UNKNOWN', error: error.message, outcome: 'unknown', retryable: true });
    if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, error: error.message, outcome: 'refused' });
    if (error.statusCode === 401) return reply.code(401).send({ code: 'UNAUTHENTICATED', error: 'Authentication required', outcome: 'refused' });
    if (error instanceof EditingOutputError || 'code' in error && ['EXTERNAL_BUFFER_LIMIT','WORK_QUEUE_LIMIT','ROOM_CACHE_LIMIT','ADMISSION_TIMEOUT','ADMISSION_METADATA_LIMIT','EDITING_PRESENCE_CAPACITY','EDITING_MAP_CAPACITY'].includes(String(error.code))) return reply.code(503).send({ code: error.code, error: 'The finite live capacity is busy', outcome: 'refused', retryable: true });
    throw error;
  });
  app.addHook('preValidation', async () => { if (!authority&&!maps) throw new ServiceUnavailableError('Live editing is disabled until all four accepted gates pass', 'LIVE_EDITING_DISABLED'); });
  const wiki=()=>{if(!authority)throw new ServiceUnavailableError('Live wiki is disabled','LIVE_EDITING_DISABLED');return authority;};
  const admission = new EditingHTTPAdmission(outputBudget);
  app.addHook('onClose', async () => admission.close());
  async function response(reply: FastifyReply, context: unknown, action: (release: () => void, preparation: EditingPreparation) => Promise<void>) {
    // Covers the exact bounded native/live response, its serialization and owned wire copy before the first SQL await.
    const preparation = await admission.admitOwned(editingContextCharge(context));
    let actionSettled = false; let responseSettled = reply.raw.destroyed || reply.raw.writableFinished;
    const release = () => { responseSettled = true; if (actionSettled) preparation.release(); };
    reply.raw.once('finish', release); reply.raw.once('close', release);
    try { await action(release, preparation); }
    catch (error) { responseSettled = true; throw error; }
    finally { actionSettled = true; if (responseSettled) preparation.release(); }
  }
  app.get<{ Params: { docId: string } }>(liveDocPath(':docId'), async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request);
    const head = await wiki().bootstrap(session, request.params.docId);
    await wiki().handoff(session, request.params.docId, () => send(reply, head, release));
  }));
  app.post<{ Params: { docId: string }; Body: EnrollLiveDoc }>(liveDocEnrollPath(':docId'), { bodyLimit: 4096, preValidation: async (request) => closed(request.body, ['generation','replicaId','instanceId']), schema: { body: enrollment } }, async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request); const result = await wiki().enroll(session, request.params.docId, request.body);
    await wiki().handoff(session, request.params.docId, () => send(reply, result, release));
  }));
  app.post<{ Params: { docId: string }; Body: SaveSharedDoc }>(liveDocSavePath(':docId'), { bodyLimit: 8192, preValidation: async (request) => closed(request.body, ['clientCommandId','expectedVersion','generation','headSequence','headHash','title','state','reason']), schema: { body: snapshot } }, async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release, preparation) => {
    const session = await sessions.requirePrincipal(request);
    if (expectedVersion(request) !== request.body.expectedVersion || request.headers['idempotency-key'] !== undefined && request.headers['idempotency-key'] !== request.body.clientCommandId) throw new InvalidInputError('Snapshot headers and immutable parameters disagree');
    await wiki().save(session, request.params.docId, request.body, preparation);
    await wiki().deliverReceipt(session, request.params.docId, request.body.clientCommandId, (receipt) => send(reply, receipt, release));
  }));
  app.get<{ Params: { docId: string; commandId: string } }>(liveDocReceiptPath(':docId', ':commandId'), async (request, reply) => response(reply, { params: request.params, headers: request.headers, body: request.body }, async (release) => {
    const session = await sessions.requirePrincipal(request);
    await wiki().deliverReceipt(session, request.params.docId, request.params.commandId, (receipt) => send(reply, receipt, release));
  }));
  function mapSend(reply:FastifyReply,text:string) {
    const bytes=Buffer.byteLength(text);const release=outputBudget.reserve(bytes);
    try {
      const wire=Buffer.allocUnsafeSlow(bytes);wire.write(text);
      reply.hijack();reply.raw.once('finish',release);reply.raw.once('close',release);
      reply.raw.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':bytes});reply.raw.end(wire);
    } catch(error){release();throw error;}
  }
  const map=()=>{if(!maps)throw new ServiceUnavailableError('Live maps are disabled until all four gates pass','LIVE_EDITING_DISABLED');return maps;};
  app.get<{Params:{sketchId:string}}>(liveMapPath(':sketchId'),async(request,reply)=>{
    const session=await sessions.requirePrincipal(request);
    await map().bootstrap(session,request.params.sketchId,(head,preparation)=>mapSend(reply,preparation.encode(head)));
  });
  app.post<{Params:{sketchId:string};Body:LiveMapGesture}>(liveMapGesturePath(':sketchId'),{bodyLimit:65_536,preValidation:async request=>{closed(request.body,['gestureId','thoughts']);if(Array.isArray(request.body.thoughts))for(const thought of request.body.thoughts)closed(thought,['id','expectedVersion']);},schema:{body:{type:'object',additionalProperties:false,required:['gestureId','thoughts'],properties:{gestureId:uuid,
    thoughts:{type:'array',minItems:1,maxItems:200,items:{type:'object',additionalProperties:false,required:['id','expectedVersion'],properties:{id:uuid,expectedVersion:{type:'integer',minimum:1}}}}}}}},async(request,reply)=>{
    const session=await sessions.requirePrincipal(request);const result=await map().acquire(session,request.params.sketchId,request.body);
    await map().authorize(session,request.params.sketchId,()=>{
      const size=editingJSONSize(result);const text=JSON.stringify(result);if(size.bytes!==Buffer.byteLength(text))throw new InvalidInputError('Invalid lease receipt');mapSend(reply,text);
    });
  });
  app.post<{Params:{sketchId:string};Body:UndoLiveMap}>(liveMapUndoPath(':sketchId'),{bodyLimit:16_384,preValidation:async request=>closed(request.body,['clientCommandId','originalCommandIds']),schema:{body:{type:'object',additionalProperties:false,required:['clientCommandId','originalCommandIds'],properties:{clientCommandId:uuid,
    originalCommandIds:{type:'array',minItems:1,maxItems:200,uniqueItems:true,items:uuid}}}}},async(request,reply)=>{
    if(request.headers['idempotency-key']!==undefined&&request.headers['idempotency-key']!==request.body.clientCommandId)throw new InvalidInputError('Undo headers disagree with the immutable UUID');
    const session=await sessions.requirePrincipal(request);const commandId=await map().undo(session,request.params.sketchId,request.body);
    await map().deliverUndo(session,request.params.sketchId,commandId,(receipt,preparation)=>mapSend(reply,preparation.encode(receipt)));
  });
}
