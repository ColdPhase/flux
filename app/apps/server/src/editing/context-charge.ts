import { Refusal } from './codec/codec.mjs';

/** Conservative UTF-16/object accounting for the complete bounded context retained by an admission continuation. */
function charge(value: unknown, visitLimit: number, byteLimit: number, binary=false): number {
  let bytes = 0; let visits = 0; const seen = new Set<object>();
  function visit(child: unknown, depth: number) {
    if (++visits > visitLimit || depth > 8) throw new Refusal('ADMISSION_METADATA_LIMIT');
    if (typeof child === 'string') bytes += 2 * child.length;
    else if (child === null || child === undefined || typeof child === 'number' || typeof child === 'boolean') bytes += 16;
    else if (child instanceof Date) bytes += 64;
    else if (binary && child instanceof Uint8Array) bytes += (child.buffer as ArrayBuffer & {maxByteLength?:number}).maxByteLength ?? child.buffer.byteLength;
    else if (typeof child === 'object') {
      if (seen.has(child)) throw new Refusal('ADMISSION_METADATA_LIMIT'); seen.add(child);
      const prototype=Object.getPrototypeOf(child);
      // Pinned Fastify/find-my-way params and query records use an empty NullObject
      // prototype whose parent is null. It has no inherited data/code to retain.
      const plain=prototype===Object.prototype||prototype===null||prototype&&Object.getPrototypeOf(prototype)===null&&Reflect.ownKeys(prototype).length===0;
      if (!plain && !(Array.isArray(child)&&prototype===Array.prototype)) throw new Refusal('ADMISSION_METADATA_LIMIT');
      bytes += 256;
      for (const key of Reflect.ownKeys(child)) {
        if(typeof key!=='string')throw new Refusal('ADMISSION_METADATA_LIMIT');
        const property=Object.getOwnPropertyDescriptor(child,key)!;
        if(!('value' in property))throw new Refusal('ADMISSION_METADATA_LIMIT');
        if(!property.enumerable){if(Array.isArray(child)&&key==='length')continue;throw new Refusal('ADMISSION_METADATA_LIMIT');}
        bytes += 128 + 2 * key.length; visit(property.value, depth + 1);
      }
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

/** Wiki protected SQL results may contain one bounded public update backing. */
export const editingWikiResultCharge = (value: unknown) => charge(value, 60_000, 24*1024*1024, true);
