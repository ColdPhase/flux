import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Public extension contracts (O-010, #251, docs/product/extension-contracts.md). One snapshot of each
// contract lives under tests/app/contracts/ and is edited in place in the PR that changes the contract:
// nothing is kept compatible before the first public release, so there is no old version to keep and no
// difference to classify. The test fails on any difference between the snapshot and the running
// application, names each changed path, and prints the running contract for the new snapshot.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type SchemaObject = { [key: string]: Json };

const contractsDir = new URL('../contracts/', import.meta.url);
const SCHEMA_MAPS = new Set(['properties', 'definitions', '$defs', 'patternProperties']);
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const MAX_LISTED = 60;

const isObject = (value: unknown): value is SchemaObject => typeof value === 'object' && value !== null && !Array.isArray(value);

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

/** An item of a list that names itself (a tool, a prompt, a resource) is addressed by its name, any other by its place. */
const label = (item: Json, index: number) => isObject(item) && typeof item.name === 'string' ? item.name : String(index);

/** Every path at which the snapshot and the running contract differ, with the two values. */
export function differences(snapshot: Json | undefined, live: Json | undefined, path = '$'): string[] {
  if (isDeepStrictEqual(snapshot, live)) return [];
  if (Array.isArray(snapshot) && Array.isArray(live)) {
    const named = (list: Json[]) => new Map(list.map((item, index) => [label(item, index), item]));
    const left = named(snapshot);
    const right = named(live);
    return [...new Set([...left.keys(), ...right.keys()])].flatMap((name) => differences(left.get(name), right.get(name), `${path}[${name}]`));
  }
  if (isObject(snapshot) && isObject(live))
    return [...new Set([...Object.keys(snapshot), ...Object.keys(live)])].flatMap((key) => differences(snapshot[key], live[key], `${path}.${key}`));
  const show = (value: Json | undefined) => value === undefined ? 'missing' : JSON.stringify(value);
  return [`${path}: ${show(snapshot)} → ${show(live)}`];
}

export const snapshotFile = (name: string) => new URL(`${name}.json`, contractsDir);

/** The message for a contract difference; `null` when the running contract equals the snapshot. */
export function contractReport(name: string, snapshot: Json | null, live: Json): string | null {
  const file = `tests/app/contracts/${name}.json`;
  const json = JSON.stringify(live);
  if (snapshot === null) return `No snapshot ${file} for ${name}. Add it with this content:\nCONTRACT-SNAPSHOT ${name}.json ${json}`;
  const changed = differences(snapshot, live);
  if (!changed.length) return null;
  const listed = changed.slice(0, MAX_LISTED).map((line) => `  ${line}`);
  if (changed.length > MAX_LISTED) listed.push(`  … and ${changed.length - MAX_LISTED} more`);
  return [`The running ${name} contract differs from ${file}. Replace the snapshot in the same PR with the content below.`,
    ...listed, `CONTRACT-SNAPSHOT ${name}.json ${json}`].join('\n');
}

/** Pins `live` to the one current snapshot of the contract. */
export function assertPinned(name: string, live: Json) {
  const path = snapshotFile(name);
  const snapshot = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Json : null;
  const report = contractReport(name, snapshot, live);
  if (report) assert.fail(report);
}
