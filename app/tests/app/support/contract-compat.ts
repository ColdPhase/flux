import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Public extension contracts (O-010, #251, docs/product/extension-contracts.md). A versioned
// snapshot under tests/app/contracts/ pins each contract; these helpers classify every
// difference between that snapshot and the running application as additive or breaking.
//
// Direction decides what "compatible" means:
// - input (MCP tool arguments): the new schema must accept everything the old one accepted;
// - output (export documents): the new output must keep every guarantee of the old one, for a
//   reader that ignores unknown fields and unknown enum values.
// A structural rewrite this classifier cannot prove compatible is reported as breaking.

export type Direction = 'input' | 'output';
export interface ContractChange { path: string; kind: 'additive' | 'breaking'; detail: string }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type SchemaObject = { [key: string]: Json };

const contractsDir = new URL('../contracts/', import.meta.url);
const TEXT = new Set(['title', 'description', '$comment', 'examples']);
const LOWER = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);
const UPPER = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);
const SCHEMA_MAPS = new Set(['properties', 'definitions', '$defs', 'patternProperties']);
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const isObject = (value: unknown): value is SchemaObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const typeSet = (value: Json | undefined) => new Set(value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]);

/** A schema with `description` keywords removed (never a property that happens to be named so) and `required` sorted. */
export function structural(schema: Json): Json {
  if (!isObject(schema)) return schema;
  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, structural(item)]));
    else if (SCHEMA_VALUES.has(key)) out[key] = structural(value);
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map(structural);
    else if (key === 'required' && Array.isArray(value)) out[key] = [...value].map(String).sort();
    else out[key] = value;
  }
  return out;
}

/** Narrower: accepts or promises less. Input breaks when it narrows; output breaks when it widens. */
function narrowed(dir: Direction) { return dir === 'input' ? 'breaking' : 'additive'; }
function widened(dir: Direction) { return dir === 'input' ? 'additive' : 'breaking'; }

export function compareSchema(before: Json | undefined, after: Json | undefined, dir: Direction, path = '$'): ContractChange[] {
  const changes: ContractChange[] = [];
  const add = (kind: ContractChange['kind'], at: string, detail: string) => changes.push({ path: at, kind, detail });
  if (isDeepStrictEqual(before, after)) return changes;
  if (before === undefined) { add(narrowed(dir), path, 'schema added'); return changes; }
  if (after === undefined) { add(widened(dir), path, 'schema removed'); return changes; }
  if (!isObject(before) || !isObject(after)) { add('breaking', path, 'schema replaced'); return changes; }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    const at = `${path}.${key}`;
    if (isDeepStrictEqual(a, b)) continue;
    if (TEXT.has(key)) add('additive', at, 'text changed');
    else if (key === 'default') {
      // An input default is what an omitted argument means: changing or dropping it changes existing calls.
      if (dir === 'output' || a === undefined) add('additive', at, a === undefined ? 'default added' : 'default changed');
      else add('breaking', at, b === undefined ? 'default removed' : `default ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    } else if (key === 'not') add('breaking', at, 'not changed: an inverted schema cannot be shown compatible');
    else if (SCHEMA_MAPS.has(key)) {
      const left = isObject(a) ? a : {};
      const right = isObject(b) ? b : {};
      for (const name of Object.keys(left)) {
        if (!(name in right)) add('breaking', `${at}.${name}`, key === 'properties' ? 'property removed' : 'definition removed');
        else changes.push(...compareSchema(left[name], right[name], dir, `${at}.${name}`));
      }
      for (const name of Object.keys(right)) if (!(name in left)) add('additive', `${at}.${name}`, key === 'properties' ? 'property added' : 'definition added');
    } else if (key === 'required') {
      const left = new Set(Array.isArray(a) ? a.map(String) : []);
      const right = new Set(Array.isArray(b) ? b.map(String) : []);
      for (const name of right) if (!left.has(name)) add(narrowed(dir), `${path}.properties.${name}`, 'now required');
      for (const name of left) if (!right.has(name)) add(widened(dir), `${path}.properties.${name}`, 'no longer required');
    } else if (key === 'additionalProperties') {
      // A reader ignores unknown fields, so output never depends on it.
      if (dir === 'output') add('additive', at, 'additional properties changed');
      else if (a === false && (b === undefined || b === true)) add('additive', at, 'additional properties allowed');
      else if (isObject(a) && isObject(b)) changes.push(...compareSchema(a, b, dir, at));
      else add('breaking', at, 'additional properties restricted');
    } else if (key === 'type' && a !== undefined && b !== undefined) {
      const left = typeSet(a);
      const right = typeSet(b);
      const wider = [...left].every((type) => right.has(type));
      const narrower = [...right].every((type) => left.has(type));
      add(wider ? widened(dir) : narrower ? narrowed(dir) : 'breaking', at, `type ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    } else if (key === 'enum' && Array.isArray(a) && Array.isArray(b)) {
      // A new value is additive in both directions: input accepts more, and readers treat an unknown value as unknown.
      const removed = a.filter((value) => !b.some((other) => isDeepStrictEqual(value, other)));
      const added = b.filter((value) => !a.some((other) => isDeepStrictEqual(value, other)));
      if (removed.length) add('breaking', at, `enum values removed: ${JSON.stringify(removed)}`);
      if (added.length) add('additive', at, `enum values added: ${JSON.stringify(added)}`);
      if (!removed.length && !added.length) add('additive', at, 'enum order changed');
    } else if ((LOWER.has(key) || UPPER.has(key)) && typeof a === 'number' && typeof b === 'number') {
      const looser = LOWER.has(key) ? b < a : b > a;
      add(looser ? widened(dir) : narrowed(dir), at, `${key} ${a} → ${b}`);
    } else if (SCHEMA_VALUES.has(key) && isObject(a) && isObject(b)) changes.push(...compareSchema(a, b, dir, at));
    else if (SCHEMA_LISTS.has(key) && Array.isArray(a) && Array.isArray(b)) {
      if (a.length === b.length) a.forEach((item, index) => changes.push(...compareSchema(item, b[index], dir, `${at}[${index}]`)));
      else if (key === 'allOf') add('breaking', at, 'allOf changed');
      else {
        const [short, long] = a.length < b.length ? [a, b] : [b, a];
        const prefix = short.every((item, index) => isDeepStrictEqual(item, long[index]));
        // More anyOf/oneOf branches accept more (wider); more prefixItems constrain more positions (narrower).
        const longer = key === 'prefixItems' ? narrowed(dir) : widened(dir);
        const shorter = key === 'prefixItems' ? widened(dir) : narrowed(dir);
        if (!prefix) add('breaking', at, `${key} branches changed`);
        else add(b.length > a.length ? longer : shorter, at, `${key} branches ${a.length} → ${b.length}`);
      }
    } else if (a === undefined) add(narrowed(dir), at, `${key} constraint added`);
    else if (b === undefined) add(widened(dir), at, `${key} constraint removed`);
    else add('breaking', at, `${key} ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return changes;
}

/** Items of two keyed lists: removed entries break, new ones are additive, shared ones are compared. */
export function compareKeyed<T extends Json>(before: T[], after: T[], key: (item: T) => string, path: string,
  compareItem: (a: T, b: T, at: string) => ContractChange[]): ContractChange[] {
  const left = new Map(before.map((item) => [key(item), item]));
  const right = new Map(after.map((item) => [key(item), item]));
  const changes: ContractChange[] = [];
  for (const [name, item] of left) {
    const other = right.get(name);
    if (other === undefined) changes.push({ path: `${path}.${name}`, kind: 'breaking', detail: 'removed' });
    else changes.push(...compareItem(item, other, `${path}.${name}`));
  }
  for (const name of right.keys()) if (!left.has(name)) changes.push({ path: `${path}.${name}`, kind: 'additive', detail: 'added' });
  return changes;
}

/** Plain string sets (scopes, error codes, envelope keys): removal breaks, addition is additive. */
export function compareSet(before: Json | undefined, after: Json | undefined, path: string): ContractChange[] {
  const left = new Set(Array.isArray(before) ? before.map(String) : []);
  const right = new Set(Array.isArray(after) ? after.map(String) : []);
  return [...[...left].filter((item) => !right.has(item)).map((item) => ({ path: `${path}.${item}`, kind: 'breaking' as const, detail: 'removed' })),
    ...[...right].filter((item) => !left.has(item)).map((item) => ({ path: `${path}.${item}`, kind: 'additive' as const, detail: 'added' }))];
}

/** Any change of an exact value (identification, scope, annotation) is breaking. */
export function compareExact(before: Json | undefined, after: Json | undefined, path: string): ContractChange[] {
  return isDeepStrictEqual(before, after) ? [] : [{ path, kind: 'breaking', detail: `${JSON.stringify(before)} → ${JSON.stringify(after)}` }];
}

export const snapshotFile = (name: string, version: number) => new URL(`${name}.v${version}.json`, contractsDir);

/** The message for a contract difference; `null` when the running contract equals the snapshot. */
export function contractReport(name: string, version: number, snapshot: Json | null, live: Json, changes: ContractChange[]): string | null {
  const file = `tests/app/contracts/${name}.v${version}.json`;
  const json = JSON.stringify(live);
  if (snapshot === null) {
    return `No snapshot ${file} for ${name} version ${version}. After a deliberate version bump, add it with this content `
      + `(and keep every older snapshot):\nCONTRACT-SNAPSHOT ${name}.v${version}.json ${json}`;
  }
  if (isDeepStrictEqual(snapshot, live)) return null;
  const breaking = changes.filter((change) => change.kind === 'breaking');
  const lines = changes.map((change) => `  ${change.kind.padEnd(8)} ${change.path}: ${change.detail}`);
  const advice = breaking.length
    ? `BREAKING change to ${name} version ${version}. Do not edit ${file}: bump the version to ${version + 1}, add `
      + `${name}.v${version + 1}.json, record the change in the decision and the changelog, and keep version ${version}'s snapshot.`
    : changes.length
      ? `Additive change to ${name} version ${version}. Replace ${file} in the same PR with the content below.`
      : `The running ${name} contract differs from ${file} in a way the classifier does not name; review it and replace the snapshot.`;
  return [advice, ...lines, `CONTRACT-SNAPSHOT ${name}.v${version}.json ${json}`].join('\n');
}

/** Pins `live` to the snapshot of `version` and requires every older version's snapshot to remain. */
export function assertPinned(name: string, version: number, live: Json, compare: (snapshot: Json, live: Json) => ContractChange[]) {
  assert.ok(Number.isInteger(version) && version >= 1, `${name}: the contract version must be a positive integer`);
  for (let older = 1; older < version; older++)
    assert.ok(existsSync(snapshotFile(name, older)), `${name}: the snapshot of version ${older} must stay in tests/app/contracts/`);
  const path = snapshotFile(name, version);
  const snapshot = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Json : null;
  const report = contractReport(name, version, snapshot, live, snapshot === null ? [] : compare(snapshot, live));
  if (report) assert.fail(report);
}
