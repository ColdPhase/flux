import { Refusal } from './codec/codec.mjs';

/** Conservative UTF-16/object accounting for the complete bounded context retained by an admission continuation. */
function charge(value: unknown, visitLimit: number, byteLimit: number): number {
  let bytes = 0; let visits = 0; const seen = new Set<object>();
  function visit(child: unknown, depth: number) {
    if (++visits > visitLimit || depth > 8) throw new Refusal('ADMISSION_METADATA_LIMIT');
    if (typeof child === 'string') bytes += 2 * child.length;
    else if (child === null || child === undefined || typeof child === 'number' || typeof child === 'boolean') bytes += 16;
    else if (child instanceof Date) bytes += 64;
    else if (typeof child === 'object') {
      if (seen.has(child)) throw new Refusal('ADMISSION_METADATA_LIMIT'); seen.add(child);
      if (Object.getPrototypeOf(child) !== Object.prototype && !Array.isArray(child)) throw new Refusal('ADMISSION_METADATA_LIMIT');
      bytes += 256;
      for (const [key, nested] of Object.entries(child)) { bytes += 128 + 2 * key.length; visit(nested, depth + 1); }
    } else throw new Refusal('ADMISSION_METADATA_LIMIT');
    if (bytes > byteLimit) throw new Refusal('ADMISSION_METADATA_LIMIT');
  }
  visit(value, 0); return bytes;
}

export const editingContextCharge = (value: unknown) => charge(value, 512, 65_536);
/** 200 closed thought-position records fit this conservative parsed-object bound. Raw wire bytes are charged separately. */
export const editingMapContextCharge = (value: unknown) => charge(value, 4096, 262_144);

/** Bounded postimages/bootstrap objects retained during synchronous protected serialization, charged before SQL with a worst reservation. */
export const editingMapResultCharge = (value: unknown) => charge(value, 60_000, 24*1024*1024);
