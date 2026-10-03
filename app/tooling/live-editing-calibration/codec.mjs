import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { hasContent } from 'lib0/decoding';
import { CAPS } from './caps.mjs';

export class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = (code) => { throw new Refusal(code); };
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const id = (value) => value === null ? null : { client: value.client, clock: value.clock };
const sameId = (a, b) => a === null ? b === null : b !== null && a.client === b.client && a.clock === b.clock;

/** Stable canonical representation; callers choose the complete immutable intent. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function fingerprint(envelope, bytes) {
  const intent = { workspace: envelope.workspace, kind: envelope.kind,
    room: envelope.room, generation: envelope.generation, actor: envelope.actor,
    operation: envelope.operation, uuid: envelope.uuid, replica: envelope.replica,
    parameters: envelope.parameters ?? null };
  return createHash('sha256').update(canonical(intent)).update('\0').update(bytes).digest('hex');
}

/** Conservative charged storage, including retained original text and receipt metadata. */
export function stateCharge(state) {
  return 2 * JSON.stringify(state).length + 512 * state.nodes.length
    + 128 * state.deleted.length + 256 * Object.keys(state.receipts).length
    + 128 * Object.keys(state.enrollments).length;
}

function rangeLookup(nodes, client, clock) {
  let low = 0; let high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const node = nodes[middle];
    if (node.client < client || (node.client === client && node.clock + node.length <= clock)) low = middle + 1;
    else high = middle;
  }
  const node = nodes[low];
  return node && node.client === client && node.clock <= clock && clock < node.clock + node.length ? node : null;
}
const sortNodes = (nodes) => nodes.sort((a, b) => a.client - b.client || a.clock - b.clock);
function covered(nodes, client, clock, length, visit) {
  const end = clock + length;
  for (let position = clock; position < end;) {
    const node = rangeLookup(nodes, client, position);
    if (!node) refuse('UNRESOLVED_RANGE');
    const count = Math.min(end, node.clock + node.length) - position;
    visit?.(node, position, count);
    position += count;
  }
}
function deleted(state, client, clock, length) {
  const end = clock + length;
  let position = clock;
  for (const range of state.deleted.filter((x) => x.client === client).sort((a, b) => a.clock - b.clock)) {
    if (range.clock > position) break;
    position = Math.max(position, range.clock + range.length);
    if (position >= end) return true;
  }
  return false;
}
function uncovered(ranges, client, clock, length) {
  const result = []; const end = clock + length; let position = clock;
  for (const range of ranges.filter((entry) => entry.client === client).sort((a, b) => a.clock - b.clock)) {
    if (range.clock >= end) break;
    if (range.clock > position) result.push({ client, clock: position, length: range.clock - position });
    position = Math.max(position, range.clock + range.length);
    if (position >= end) break;
  }
  if (position < end) result.push({ client, clock: position, length: end - position });
  return result;
}
function vector(nodes) {
  const result = new Map();
  for (const node of nodes) {
    const expected = result.get(node.client) ?? 0;
    if (node.clock !== expected) refuse('CLOCK_GAP_OR_OVERLAP');
    result.set(node.client, node.clock + node.length);
  }
  return result;
}

/** Independent plain-text graph ledger. No Doc.store/share or underscore/private fields. */
function graph(state, decoded, envelope) {
  if (decoded.structs.length > CAPS.structs || state.nodes.length + decoded.structs.length > CAPS.structs) refuse('STRUCT_LIMIT');
  const incoming = decoded.structs.map((struct) => {
    if (!(struct instanceof Y.Item)) refuse('UNPROVEN_GC_OR_SKIP');
    if (!integer(struct.id.client) || !integer(struct.id.clock) || !integer(struct.length) || struct.length < 1
      || !integer(struct.id.clock + struct.length)) refuse('INVALID_INTERVAL');
    if (struct.parentSub !== null) refuse('MAP_OR_ATTRIBUTE');
    const string = struct.content instanceof Y.ContentString;
    const tombstone = struct.content instanceof Y.ContentDeleted;
    if (!string && !tombstone) refuse('NON_TEXT_CONTENT');
    if (string && struct.content.str.length !== struct.length) refuse('INVALID_STRING_LENGTH');
    if (struct.parent !== null && typeof struct.parent !== 'string') refuse('NESTED_PARENT');
    if (typeof struct.parent === 'string' && struct.parent !== 'body') refuse('EXTRA_ROOT');
    return { client: struct.id.client, clock: struct.id.clock, length: struct.length,
      text: string ? struct.content.str : null, tombstone, origin: id(struct.origin),
      rightOrigin: id(struct.rightOrigin), declaredRoot: struct.parent, root: null };
  });
  // Duplicate intervals are resolved against confirmed state, not an ambiguous merged lookup.
  const find = (reference) => {
    if (!reference || !integer(reference.client) || !integer(reference.clock)) refuse('INVALID_REFERENCE');
    return rangeLookup(state.nodes, reference.client, reference.clock)
      ?? incoming.find((node) => node.client === reference.client && node.clock <= reference.clock
        && reference.clock < node.clock + node.length)
      ?? refuse('UNRESOLVED_REFERENCE');
  };
  const visiting = new Set();
  function root(node) {
    if (node.root) return node.root;
    if (visiting.has(node)) refuse('DEPENDENCY_CYCLE');
    visiting.add(node);
    const roots = [];
    for (const reference of [node.origin, node.rightOrigin]) {
      if (reference) {
        if (reference.client === node.client && reference.clock >= node.clock) refuse('FUTURE_OWN_REFERENCE');
        roots.push(root(find(reference)));
      }
    }
    if (node.declaredRoot) roots.push(node.declaredRoot);
    if (!roots.length || roots.some((name) => name !== 'body')) refuse('UNPROVEN_PARENT');
    node.root = 'body'; visiting.delete(node); return node.root;
  }
  for (const node of incoming) root(node);
  const next = [...state.nodes];
  for (const node of incoming) {
    let position = node.clock;
    const end = node.clock + node.length;
    while (position < end) {
      const known = rangeLookup(state.nodes, node.client, position);
      if (!known) break;
      const count = Math.min(end, known.clock + known.length) - position;
      const a = position - node.clock; const b = position - known.clock;
      const originA = a ? { client: node.client, clock: position - 1 } : node.origin;
      const originB = b ? { client: known.client, clock: position - 1 } : known.origin;
      if (!sameId(originA, originB) || !sameId(node.rightOrigin, known.rightOrigin) || known.root !== node.root) refuse('ALTERED_DUPLICATE_GRAPH');
      if (node.tombstone) {
        if (!deleted(state, node.client, position, count)) refuse('UNPROVEN_TOMBSTONE');
      } else if (node.text.slice(a, a + count) !== known.text.slice(b, b + count)) refuse('ALTERED_DUPLICATE_CONTENT');
      position += count;
    }
    if (position === end) continue;
    if (node.tombstone) refuse('UNPROVEN_NEW_TOMBSTONE');
    if (state.enrollments[String(node.client)]?.actor !== envelope.actor || node.client !== envelope.replica) refuse('REPLICA_OWNERSHIP');
    const offset = position - node.clock;
    next.push({ client: node.client, clock: position, length: end - position, text: node.text.slice(offset),
      origin: offset ? { client: node.client, clock: position - 1 } : node.origin,
      rightOrigin: node.rightOrigin, declaredRoot: 'body', root: 'body',
      actor: envelope.actor, admittedSequence: state.sequence + 1 });
  }
  sortNodes(next); vector(next);
  let deleteCount = 0;
  const deletions = [...state.deleted];
  for (const [client, ranges] of decoded.ds.clients) {
    if (!integer(client)) refuse('INVALID_DELETE_CLIENT');
    for (const range of ranges) {
      if (++deleteCount > CAPS.deleteRanges || !integer(range.clock) || !integer(range.len) || range.len < 1
        || !integer(range.clock + range.len)) refuse('DELETE_LIMIT_OR_RANGE');
      covered(next, client, range.clock, range.len, (node) => { if (node.root !== 'body') refuse('DELETE_OTHER_ROOT'); });
      for (const novel of uncovered(deletions, client, range.clock, range.len)) {
        deletions.push({ ...novel, actor: envelope.actor, admittedSequence: state.sequence + 1 });
      }
    }
  }
  if (deletions.length > CAPS.deleteRanges) refuse('DELETE_LIMIT_OR_RANGE');
  return { nodes: next, deleted: deletions,
    changed: next.length !== state.nodes.length || deletions.length !== state.deleted.length };
}

/** Public decoder constructor hook lets us reject trailing bytes without private fields. */
function decodeComplete(bytes) {
  let input;
  class CompleteDecoder extends Y.UpdateDecoderV1 {
    constructor(decoder) { super(decoder); input = decoder; }
  }
  const decoded = Y.decodeUpdateV2(bytes, CompleteDecoder);
  if (hasContent(input)) refuse('TRAILING_UPDATE_BYTES');
  return decoded;
}

export function admit(state, envelope, bytes, canWrite) {
  if (!canWrite) refuse('CURRENT_WRITE_REQUIRED');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > CAPS.assemblyBytes) refuse('BYTE_LIMIT');
  if (stateCharge(state) > CAPS.roomCacheBytes) refuse('ROOM_CACHE_LIMIT');
  if (typeof envelope.actor !== 'string' || typeof envelope.uuid !== 'string' || envelope.operation !== 'text') refuse('INVALID_ENVELOPE');
  const namespace = { workspace: envelope.workspace, kind: envelope.kind, room: envelope.room,
    generation: envelope.generation, actor: envelope.actor, operation: envelope.operation, uuid: envelope.uuid };
  const key = canonical(namespace);
  const digest = fingerprint(envelope, bytes);
  const receipt = state.receipts[key];
  if (receipt) {
    if (receipt.fingerprint !== digest) refuse('EDITING_IDEMPOTENCY_CONFLICT');
    return { state, receipt, replay: true };
  }
  if (envelope.workspace !== state.workspace || envelope.kind !== state.kind
    || envelope.room !== state.room || envelope.generation !== state.generation) refuse('ROOM_GENERATION');
  if (!integer(envelope.replica) || state.enrollments[String(envelope.replica)]?.actor !== envelope.actor) refuse('REPLICA_OWNERSHIP');
  let decoded;
  try { decoded = decodeComplete(bytes); } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('MALFORMED_UPDATE');
  }
  const candidate = graph(state, decoded, envelope);
  const sequence = state.sequence + (candidate.changed ? 1 : 0);
  const admitted = { fingerprint: digest, bytes: bytes.byteLength, sequence,
    workspace: state.workspace, kind: state.kind, room: state.room,
    generation: state.generation, actor: envelope.actor, uuid: envelope.uuid, replica: envelope.replica,
    semanticNoop: !candidate.changed,
    provenance: candidate.changed ? { actor: envelope.actor, sequence } : null };
  if (!candidate.changed) {
    const next = { ...state, receipts: { ...state.receipts, [key]: admitted } };
    if (stateCharge(next) > CAPS.roomCacheBytes) refuse('ROOM_CACHE_LIMIT');
    return { replay: false, receipt: admitted, state: next, receiptOnly: true };
  }
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(state.checkpoint, 'base64')), 'checkpoint');
    Y.applyUpdate(doc, bytes, 'candidate');
    const body = doc.getText('body');
    if (body.length > CAPS.bodyUnits) refuse('BODY_LIMIT');
    if (body.toDelta().some((part) => typeof part.insert !== 'string' || part.attributes)) refuse('FORMATTED_BODY');
    const actual = Y.decodeStateVector(Y.encodeStateVector(doc));
    const expected = vector(candidate.nodes);
    if (canonical([...actual].sort()) !== canonical([...expected].sort())) refuse('UNINTEGRATED_CANDIDATE');
    const checkpoint = Y.encodeStateAsUpdate(doc);
    if (checkpoint.byteLength > CAPS.assemblyBytes) refuse('CHECKPOINT_LIMIT');
    const next = { ...state, nodes: candidate.nodes, deleted: candidate.deleted, sequence,
      checkpoint: Buffer.from(checkpoint).toString('base64'), body: body.toString(),
      receipts: { ...state.receipts, [key]: admitted },
      journal: [...state.journal, { sequence, actor: envelope.actor, fingerprint: digest }] };
    if (stateCharge(next) > CAPS.roomCacheBytes) refuse('ROOM_CACHE_LIMIT');
    return { replay: false, receipt: admitted, state: next, receiptOnly: false };
  } finally { doc.destroy(); }
}

export function emptyRoom(room = 'wiki-a', generation = 'generation-a', workspace = 'workspace-a') {
  const doc = new Y.Doc();
  try { return { workspace, kind: 'wiki', room, generation, body: '', sequence: 0, nodes: [], deleted: [], enrollments: {},
    receipts: {}, journal: [], checkpoint: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }; }
  finally { doc.destroy(); }
}
export function enroll(state, actor, clientId, canWrite) {
  if (!canWrite) refuse('CURRENT_WRITE_REQUIRED');
  if (!integer(clientId)) refuse('INVALID_REPLICA');
  if (Object.hasOwn(state.enrollments, String(clientId))) refuse('REPLICA_COLLISION');
  const next = { ...state, enrollments: { ...state.enrollments, [clientId]: { actor,
    workspace: state.workspace, kind: state.kind, room: state.room, generation: state.generation } } };
  if (stateCharge(next) > CAPS.roomCacheBytes) refuse('ROOM_CACHE_LIMIT');
  return next;
}
