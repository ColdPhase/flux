import {
  sketchLinkPath,
  sketchLinksPath,
  sketchMoveToMapPath,
  sketchPath,
  sketchPositionsPath,
  sketchThoughtPath,
  sketchThoughtsPath,
  projectPath,
  workspaceSketchesPath,
  type CreatedThought,
  type CreateLinkCommand,
  type CreateThoughtCommand,
  type MovedThoughts,
  type MoveThoughtsCommand,
  type MoveToMapCommand,
  type MovedToMap,
  type Project,
  type Sketch,
  type SketchDetail,
  type SketchPage,
  type Thought,
  type ThoughtLink,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import { ApiError, request } from './client';

// Sketch API (issue #69). Every change carries an Idempotency-Key so a retry after a lost
// answer never applies twice; versioned changes send If-Match.

const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

/**
 * My map (#866): the person's oldest private map, made the first time it is asked for. The API lists their private maps newest change
 * first, and a map nobody put anything on is listed too, so My map is found again before it has a thought. The map is made with one key
 * for the person and company, so two tabs (or a retry after a lost answer) that ask at the same moment get one map, not two.
 */
export const myMapKey = (workspaceId: string) => `my-map:${workspaceId}`;
export async function openMyMap(workspaceId: string, signal?: AbortSignal): Promise<Sketch> {
  const find = async () => {
    const listed = await request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=100&offset=0&scope=private`, { signal });
    return [...listed.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  };
  const mine = await find();
  if (mine) return mine;
  // The server holds one private map for each person: if another tab made it first, that is the one to open.
  try {
    return await request<Sketch>(workspaceSketchesPath(workspaceId), { method: 'POST', body: { title: 'My map', scope: 'private' }, headers: key(myMapKey(workspaceId)), signal });
  } catch (error) {
    const existing = error instanceof ApiError && error.code === 'MY_MAP_EXISTS' ? await find() : undefined;
    if (existing) return existing;
    throw error;
  }
}

/** The maps of a space, empty ones too (a space's map nobody has put anything on yet is still where a thought can go), newest change first. */
export const listSpaceMaps = (workspaceId: string, projectId: string, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=50&offset=0&projectId=${encodeURIComponent(projectId)}`, { signal });

export const getSketch = (sketchId: string, signal?: AbortSignal) => request<SketchDetail>(sketchPath(sketchId), { signal });
export const renameSketch = (sketchId: string, title: string, version: number, idempotencyKey: string) =>
  request<Sketch>(sketchPath(sketchId), { method: 'PATCH', body: { title }, headers: { ...ifMatch(version), ...key(idempotencyKey) } });

export const addThought = (sketchId: string, command: CreateThoughtCommand, idempotencyKey: string) =>
  request<CreatedThought>(sketchThoughtsPath(sketchId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const updateThought = (sketchId: string, thoughtId: string, changes: Omit<UpdateThoughtCommand, 'expectedVersion'>, version: number, idempotencyKey: string) =>
  request<Thought>(sketchThoughtPath(sketchId, thoughtId), { method: 'PATCH', body: changes, headers: { ...ifMatch(version), ...key(idempotencyKey) } });
export const removeThought = (sketchId: string, thoughtId: string, version: number, idempotencyKey: string) =>
  request<null>(sketchThoughtPath(sketchId, thoughtId), { method: 'DELETE', headers: { ...ifMatch(version), ...key(idempotencyKey) } });
export const moveThoughts = (sketchId: string, command: MoveThoughtsCommand, idempotencyKey: string) =>
  request<MovedThoughts>(sketchPositionsPath(sketchId), { method: 'PATCH', body: command, headers: key(idempotencyKey) });
/** Moves thoughts to another map the caller can change (#948): My map's "Move to a space map", and its Undo, which is the same move back. */
export const moveThoughtsToMap = (sketchId: string, command: MoveToMapCommand, idempotencyKey: string) =>
  request<MovedToMap>(sketchMoveToMapPath(sketchId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const addLink = (sketchId: string, command: CreateLinkCommand, idempotencyKey: string) =>
  request<ThoughtLink>(sketchLinksPath(sketchId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const removeLink = (sketchId: string, linkId: string, idempotencyKey: string) =>
  request<null>(sketchLinkPath(sketchId, linkId), { method: 'DELETE', headers: key(idempotencyKey) });
export const updateLinkLabel = (sketchId: string, linkId: string, label: string | null, expectedLabel: string | null, idempotencyKey: string) =>
  request<ThoughtLink>(sketchLinkPath(sketchId, linkId), { method: 'PATCH', body: { label, expectedLabel }, headers: key(idempotencyKey) });

export const getProject = (projectId: string, signal?: AbortSignal) => request<Project>(projectPath(projectId), { signal });
