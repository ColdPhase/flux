import {
  sketchLinkPath,
  sketchLinksPath,
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
  type Project,
  type Sketch,
  type SketchDetail,
  type SketchPage,
  type Thought,
  type ThoughtLink,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import { request } from './client';

// Sketch API (issue #69). Every change carries an Idempotency-Key so a retry after a lost
// answer never applies twice; versioned changes send If-Match.

const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

/**
 * My map (#866): the person's oldest private map, made the first time it is asked for. The API lists their private maps newest change
 * first, and a map nobody put anything on is listed too, so My map is found again before it has a thought. A retry after a lost answer
 * reuses `idempotencyKey`, so it never makes two.
 */
export async function openMyMap(workspaceId: string, idempotencyKey: string, signal?: AbortSignal): Promise<Sketch> {
  const listed = await request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=100&offset=0&scope=private`, { signal });
  const mine = [...listed.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return mine ?? request<Sketch>(workspaceSketchesPath(workspaceId), { method: 'POST', body: { title: 'My map', scope: 'private' }, headers: key(idempotencyKey), signal });
}

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
export const addLink = (sketchId: string, command: CreateLinkCommand, idempotencyKey: string) =>
  request<ThoughtLink>(sketchLinksPath(sketchId), { method: 'POST', body: command, headers: key(idempotencyKey) });
export const removeLink = (sketchId: string, linkId: string, idempotencyKey: string) =>
  request<null>(sketchLinkPath(sketchId, linkId), { method: 'DELETE', headers: key(idempotencyKey) });
export const updateLinkLabel = (sketchId: string, linkId: string, label: string | null, expectedLabel: string | null, idempotencyKey: string) =>
  request<ThoughtLink>(sketchLinkPath(sketchId, linkId), { method: 'PATCH', body: { label, expectedLabel }, headers: key(idempotencyKey) });

export const getProject = (projectId: string, signal?: AbortSignal) => request<Project>(projectPath(projectId), { signal });
