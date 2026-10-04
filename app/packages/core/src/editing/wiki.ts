import { createHash, randomUUID } from 'node:crypto';
import type { EnrollLiveDoc, EnrolledLiveDoc, LiveDocBootstrap, LiveCursor, LiveReceipt, SaveSharedDoc, WikiTextEnvelope } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError } from '../access/errors.js';
import { createDocUseCases, prepareDocBodyTaskUse } from '../docs/service.js';
import { isId } from '../work/validation.js';
import type { WikiCodecState, WikiHead, WikiIdentity, WikiIntent, WikiPorts } from './wiki-ports.js';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const conflict = () => new ConflictError('This command UUID has another immutable intent', 'EDITING_IDEMPOTENCY_CONFLICT');
const generationChanged = () => new ConflictError('The shared generation changed; keep earlier pending text private', 'EDITING_GENERATION_CHANGED');
function id(value: unknown) { if (!isId(value)) throw new InvalidInputError('A UUID is required'); return value.toLowerCase(); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function originalReceipt(value: unknown): LiveReceipt {
  const r = value as Partial<LiveReceipt> | null;
  if (!r || typeof r !== 'object' || typeof r.workspaceId !== 'string' || typeof r.resourceId !== 'string'
    || typeof r.generation !== 'string' || !Number.isSafeInteger(r.sequence) || typeof r.hash !== 'string'
    || typeof r.commandId !== 'string' || (r.operation !== 'text' && r.operation !== 'save')
    || typeof r.fingerprint !== 'string' || typeof r.changed !== 'boolean') throw new Error('Invalid stored wiki receipt');
  return r as LiveReceipt;
}
/** Domain orchestration only: server public codec and database rows implement these ports. */
export function liveWiki<State extends WikiCodecState, Lease>(ports: WikiPorts<State, Lease>) {
  const docs = createDocUseCases({ run: (action) => action(ports.native) });
  async function authorized(identity: WikiIdentity, docId: string, action: 'read' | 'write', commandId?: string) {
    const actor = await ports.session.lock(identity);
    const principal = { kind: 'human' as const, id: actor.id };
    const located = await ports.native.docs.locate(id(docId));
    if (!located) throw new NotFoundError('Doc', 'DOC_NOT_FOUND');
    await ports.native.access.requireProject(principal, action, located.projectId, { lock: true });
    if (commandId) await ports.rows.lockIntent(actor.id, id(commandId));
    const doc = await ports.native.docs.find(docId, { lock: true });
    if (!doc) throw new NotFoundError('Doc', 'DOC_NOT_FOUND');
    return { actor, principal, doc };
  }
  async function head(docId: string, generation?: string) {
    const current = await ports.rows.lockHead(docId);
    if (!current?.codecState) throw generationChanged();
    if (generation && current.generation !== generation) throw generationChanged();
    return current;
  }
  function receipt(head: WikiHead<State>, commandId: string, operation: LiveReceipt['operation'], fingerprint: string, changed: boolean): LiveReceipt {
    return { workspaceId: head.workspaceId, resourceId: head.resourceId, generation: head.generation,
      sequence: head.sequence, hash: head.hash, commandId, operation, fingerprint, changed };
  }
  async function replay(identity: WikiIdentity, commandId: string, current: WikiHead<State>, operation: string, fingerprint: string, bytes: number) {
    const old = await ports.rows.intent(identity.actorId, commandId);
    if (!old) return null;
    if (old.kind !== 'wiki' || old.workspaceId !== current.workspaceId || old.resourceId !== current.resourceId
      || old.operation !== operation || old.fingerprint !== fingerprint || old.byteLength !== bytes) throw conflict();
    // Original generation is fingerprinted; returning this result never applies it to a new generation.
    await ports.session.assertCurrent(identity);
    return originalReceipt(old.receipt);
  }
  async function record(identity: WikiIdentity, current: WikiHead<State>, result: LiveReceipt, byteLength: number) {
    const intent: Omit<WikiIntent, 'receipt'> & { receipt: LiveReceipt } = { actorId: identity.actorId, commandId: result.commandId, workspaceId: current.workspaceId,
      kind: 'wiki', resourceId: current.resourceId, generation: result.generation, operation: result.operation,
      fingerprint: result.fingerprint, byteLength, receipt: result };
    await ports.rows.insertIntent(intent);
    await ports.session.assertCurrent(identity);
    await ports.rows.notify(current.resourceId);
    return result;
  }
  return {
    async authorizeHandoff(identity: WikiIdentity, docId: string) {
      const result = await authorized(identity, docId, 'read');
      await ports.session.assertCurrent(identity); return result.actor;
    },
    async bootstrap(identity: WikiIdentity, docId: string, lease: Lease): Promise<LiveDocBootstrap> {
      const { actor, principal, doc } = await authorized(identity, docId, 'read');
      let current = await ports.rows.lockHead(docId);
      if (!current?.codecState) {
        const generation = current?.generation ?? randomUUID();
        const baseline = await ports.codec.initialize(doc.doc.workspaceId, docId, generation, current?.body ?? doc.current.body, lease);
        if (current) { await ports.rows.replaceState(current, baseline.state, hash(baseline.state.body)); current = { ...current, codecState: baseline.state }; }
        else current = await ports.rows.insertHead(doc, generation, baseline.state);
        await ports.rows.insertReplica(docId, generation, baseline.replicaId, null, randomUUID(), 'server');
      } else ports.codec.prepareRead(current.codecState, lease);
      let canWrite = false;
      try { await ports.native.access.requireProject(principal, 'write', doc.doc.projectId, { lock: true }); canWrite = true; }
      catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
      const preview = await docs.previewShared(principal, docId, current.body);
      await ports.session.assertCurrent(identity);
      return { kind: 'wiki', workspaceId: current.workspaceId, resourceId: docId, generation: current.generation,
        sequence: current.sequence, hash: current.hash, savedVersion: current.savedVersion, savedSequence: current.savedSequence,
        body: current.body, ...preview, checkpoint: current.codecState!.checkpoint,
        stateVector: ports.codec.stateVector(current.codecState!), canWrite, actor };
    },
    async enroll(identity: WikiIdentity, docId: string, command: EnrollLiveDoc): Promise<EnrolledLiveDoc> {
      if (!command || Object.keys(command).some((key) => !['generation','replicaId','instanceId'].includes(key)) || !isId(command.generation) || !Number.isSafeInteger(command.replicaId) || command.replicaId < 0
        || command.instanceId !== undefined && !isId(command.instanceId)) throw new InvalidInputError('A fresh generated replica is required');
      await authorized(identity, docId, 'write');
      const current = await head(docId, command.generation);
      const existing = await ports.rows.replica(docId, command.generation, command.replicaId);
      if (existing) {
        if (existing.ownerKind !== 'human' || existing.actorId !== identity.actorId || !command.instanceId || existing.instanceId !== command.instanceId) {
          throw new ConflictError('Create another unused Y.Doc before writing', 'EDITING_REPLICA_COLLISION');
        }
        const renewed = await ports.rows.renewReplica(docId, command.generation, command.replicaId, command.instanceId);
        await ports.session.assertCurrent(identity); return renewed;
      }
      if (command.instanceId) throw new ConflictError('The instance is not enrolled', 'EDITING_REPLICA_COLLISION');
      const state = ports.codec.enroll(current.codecState!, identity.actorId, command.replicaId, true);
      await ports.rows.replaceState(current, state, current.hash);
      const enrolled = await ports.rows.insertReplica(docId, command.generation, command.replicaId, identity.actorId, randomUUID(), 'human');
      await ports.session.assertCurrent(identity); return enrolled;
    },
    async submit(identity: WikiIdentity, docId: string, envelope: WikiTextEnvelope, bytes: Uint8Array, lease: Lease): Promise<LiveReceipt> {
      if (envelope.kind !== 'wiki' || envelope.operation !== 'text' || envelope.parameters !== null
        || envelope.room !== docId || envelope.actor !== identity.actorId || !isId(envelope.generation)) throw new InvalidInputError('The text intent has another scope', 'EDITING_SCOPE_MISMATCH');
      const { doc } = await authorized(identity, docId, 'write', envelope.uuid);
      const current = await ports.rows.peekHead(docId);
      if (!current) throw generationChanged();
      if (envelope.workspace !== doc.doc.workspaceId) throw new InvalidInputError('The text intent has another scope', 'EDITING_SCOPE_MISMATCH');
      const fingerprint = ports.codec.fingerprint(envelope, bytes);
      const original = await replay(identity, envelope.uuid, current, 'text', fingerprint, bytes.byteLength);
      if (original) return original;
      if (current.generation !== envelope.generation || !current.codecState) throw generationChanged();
      const owner = await ports.rows.peekReplica(docId, current.generation, envelope.replica);
      // A new session may first-admit exact old pending bytes owned by its actor. It cannot claim they were already confirmed.
      if (!owner || owner.ownerKind !== 'human' || owner.actorId !== identity.actorId) throw new ConflictError('The replica is not enrolled for this person and generation', 'EDITING_REPLICA_REQUIRED');
      const validated = await ports.codec.validate(current.codecState!, envelope, bytes, lease);
      if (!validated.ok) throw new RuleViolationError('The candidate text was refused before sharing', validated.code);
      const next = { ...current, codecState: validated.state, sequence: validated.state.sequence, body: validated.state.body, hash: hash(validated.state.body) };
      const changed = !validated.receipt.semanticNoop;
      const taskFence = changed ? await prepareDocBodyTaskUse(ports.native, doc, [current.body, next.body]) : null;
      const retained = await ports.rows.lockHead(docId);
      if (!retained || retained.generation !== current.generation || retained.sequence !== current.sequence
        || retained.hash !== current.hash || retained.body !== current.body) throw generationChanged();
      const retainedOwner = await ports.rows.replica(docId, current.generation, envelope.replica);
      if (!retainedOwner || retainedOwner.ownerKind !== owner.ownerKind || retainedOwner.actorId !== owner.actorId
        || retainedOwner.instanceId !== owner.instanceId) throw new ConflictError('The replica changed before commit', 'EDITING_REPLICA_REQUIRED');
      await ports.rows.replaceState(current, validated.state, next.hash);
      if (changed) { await ports.rows.appendUpdate(next, envelope, bytes, fingerprint); await taskFence!.mark(); }
      return record(identity, next, receipt(next, envelope.uuid, 'text', fingerprint, changed), bytes.byteLength);
    },
    async cursor(identity: WikiIdentity, docId: string, generation: string, connectionId: string, cursor: LiveCursor | null) {
      await authorized(identity, docId, 'write');
      const current = await head(docId, generation);
      if (cursor) ports.codec.validateCursor(current.codecState!, cursor);
      await ports.rows.setPresence(docId, generation, identity, connectionId, cursor);
      await ports.session.assertCurrent(identity); await ports.rows.notify(docId);
    },
    async save(identity: WikiIdentity, docId: string, command: SaveSharedDoc): Promise<LiveReceipt> {
      if (!command || Object.keys(command).some((key) => !['clientCommandId','expectedVersion','generation','headSequence','headHash','title','state','reason'].includes(key))) throw new InvalidInputError('Unknown snapshot parameter');
      const { principal } = await authorized(identity, docId, 'write', command.clientCommandId);
      const current = await ports.rows.peekHead(docId);
      if (!current) throw generationChanged();
      const parameters = { expectedVersion: command.expectedVersion, generation: command.generation, headSequence: command.headSequence,
        headHash: command.headHash, title: command.title ?? null, state: command.state ?? null, reason: command.reason ?? null };
      const fingerprint = createHash('sha256').update(canonical({ workspace: current.workspaceId, kind: 'wiki', room: docId,
        generation: command.generation, actor: identity.actorId, operation: 'save', uuid: command.clientCommandId, parameters })).digest('hex');
      const original = await replay(identity, command.clientCommandId, current, 'save', fingerprint, 0);
      if (original) return original;
      const savedDoc = await docs.saveLiveVersion(principal, docId, command, command.expectedVersion);
      return record(identity, current, { ...receipt(current, command.clientCommandId, 'save', fingerprint, savedDoc.version !== current.savedVersion), savedDoc }, 0);
    },
    async receipt(identity: WikiIdentity, docId: string, commandId: string): Promise<LiveReceipt | null> {
      await authorized(identity, docId, 'read', commandId);
      const current = await ports.rows.lockHead(docId); // Original serialization boundary, including an uncertain older COMMIT.
      const found = await ports.rows.intent(identity.actorId, commandId);
      if (found && (found.kind !== 'wiki' || found.resourceId !== docId || found.workspaceId !== current?.workspaceId)) throw conflict();
      await ports.session.assertCurrent(identity); return found ? originalReceipt(found.receipt) : null;
    },
    /** Caller hands off synchronously inside this authority transaction; a returned buffer alone is not a delivery fence. */
    async readConfirmed(identity: WikiIdentity, docId: string, generation: string, afterSequence: number, view: { previewAfterSequence?: number; includeContent?: boolean } = {}) {
      const { actor, principal, doc } = await authorized(identity, docId, 'read');
      const current = await head(docId, generation);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > current.sequence) throw new InvalidInputError('Invalid confirmed sequence');
      const updates = view.includeContent === false ? [] : await ports.rows.updates(docId, generation, afterSequence, 1);
      if (view.includeContent !== false && afterSequence < current.sequence && updates[0]?.sequence !== afterSequence + 1) throw generationChanged();
      let canWrite = false;
      try { await ports.native.access.requireProject(principal, 'write', doc.doc.projectId, { lock: true }); canWrite = true; }
      catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
      const preview = view.includeContent !== false && !updates.length && current.sequence > (view.previewAfterSequence ?? -1)
        ? await docs.previewShared(principal, docId, current.body) : null;
      const presence = [];
      for (const peer of await ports.rows.presence(docId, generation)) {
        try { await ports.native.access.requireProject({ kind: 'human', id: peer.actor.id }, 'write', doc.doc.projectId); presence.push(peer); }
        catch (error) { if (!(error instanceof ForbiddenError || error instanceof NotFoundError)) throw error; }
      }
      await ports.session.assertCurrent(identity);
      return { current, updates, actor, canWrite, preview, presence };
    },
  };
}
