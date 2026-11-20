import { instantsInZone } from '@flux/core';
import { personTimeZones, type Database } from '@flux/db';
import type { FluxMcpClaims } from './context.js';

// The model reads every time in its owner's own zone, with the offset (decision C-57; round 15: given UTC, a model told "15:34 Warsaw time"
// for 14:34). One place does it for every tool, so a tool a person adds later is told the same way without knowing of it.

type ToolOutput = { content?: unknown; isError?: boolean };

/** The owner's zone, read once for the request that is being served (its dispatch is one request's). */
const zones = new WeakMap<object, Promise<string>>();
function ownerZone(db: Database, claims: FluxMcpClaims): Promise<string> {
  const request = claims.dispatch;
  const read = () => personTimeZones(db).get(claims.ownerUserId);
  if (!request) return read();
  let zone = zones.get(request);
  if (!zone) { zone = read(); zones.set(request, zone); }
  return zone;
}

/** A tool's JSON answer with the instants it names in UTC written in the owner's zone. Errors and plain words pass as they are. */
export async function inOwnersZone<T extends ToolOutput>(db: Database, claims: FluxMcpClaims, result: T): Promise<T> {
  const content = result?.content;
  if (result?.isError || !Array.isArray(content)) return result;
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string' || !/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z"/.test(first.text)) return result;
  const text = instantsInZone(first.text, await ownerZone(db, claims));
  return text === first.text ? result : { ...result, content: [{ ...first, text }, ...content.slice(1)] };
}
