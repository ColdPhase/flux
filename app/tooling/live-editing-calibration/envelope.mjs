import { Buffer } from 'node:buffer';
import { CAPS } from './caps.mjs';
import { canonical, Refusal } from './codec.mjs';

const FIELDS = ['workspace', 'kind', 'room', 'generation', 'actor', 'operation', 'uuid', 'replica', 'parameters'];
export function persistentEnvelope(value, chunked = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('INVALID_ENVELOPE');
  const allowed = new Set(chunked ? [...FIELDS, 'index', 'count'] : FIELDS);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Refusal('UNKNOWN_ENVELOPE_FIELD');
  for (const field of FIELDS.filter((key) => key !== 'replica' && key !== 'parameters')) {
    if (typeof value[field] !== 'string' || value[field].length < 1 || value[field].length > 256) throw new Refusal('INVALID_ENVELOPE');
  }
  if (!Number.isSafeInteger(value.replica) || value.replica < 0) throw new Refusal('INVALID_REPLICA');
  const parameters = value.parameters ?? null;
  let visited = 0;
  function validate(entry, depth) {
    if (++visited > 4096 || depth > 16) throw new Refusal('ENVELOPE_PARAMETER_LIMIT');
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'string') { if (entry.length > 4092) throw new Refusal('ENVELOPE_PARAMETER_LIMIT'); return; }
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) throw new Refusal('INVALID_PARAMETER'); return; }
    if (typeof entry !== 'object') throw new Refusal('INVALID_PARAMETER');
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) validate(child, depth + 1);
  }
  validate(parameters, 0);
  const result = Object.fromEntries(FIELDS.map((field) => [field, field === 'parameters' ? parameters : value[field]]));
  if (Buffer.byteLength(canonical(result)) > CAPS.frameBytes - CAPS.chunkBytes - 4) throw new Refusal('ENVELOPE_BYTE_LIMIT');
  const copy = JSON.parse(JSON.stringify(result));
  function freeze(entry) {
    if (entry && typeof entry === 'object') { for (const child of Object.values(entry)) freeze(child); Object.freeze(entry); }
  }
  freeze(copy); return copy;
}
