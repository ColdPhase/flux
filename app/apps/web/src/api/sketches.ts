import {
  sketchLinkPath,
  sketchLinksPath,
  sketchPath,
  sketchPromotionPath,
  sketchPositionsPath,
  sketchThoughtPath,
  sketchThoughtsPath,
  projectPath,
  workspaceProjectsPath,
  workspaceSketchesPath,
  WORKSPACES_PATH,
  type CreatedThought,
  type CreateLinkCommand,
  type CreateThoughtCommand,
  type MovedThoughts,
  type MoveThoughtsCommand,
  type Page,
  type PromotedSketch,
  type PromotionTarget,
  type SketchPromotionPreview,
  type Project,
  type Sketch,
  type SketchDetail,
  type SketchPage,
  type Thought,
  type ThoughtLink,
  type UpdateThoughtCommand,
  type Workspace,
} from '@flux/contracts';
import { request } from './client';

// Sketch API (issue #69). Every change carries an Idempotency-Key so a retry after a lost
// answer never applies twice; versioned changes send If-Match.

const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

export const listWorkspaces = (signal?: AbortSignal) => request<Workspace[]>(WORKSPACES_PATH, { signal });
export const createWorkspace = (name: string, idempotencyKey: string) =>
  request<Workspace>(WORKSPACES_PATH, { method: 'POST', body: { name }, headers: key(idempotencyKey) });
export const listProjects = (workspaceId: string, offset: number, signal?: AbortSignal) =>
  request<Page<Project>>(`${workspaceProjectsPath(workspaceId)}?limit=100&offset=${offset}`, { signal });
export const listSketches = (workspaceId: string, limit: number, offset: number, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=${limit}&offset=${offset}`, { signal });
/** The person's own sketchbook: private sketches only (#189); shared ones live in their project or DM. */
export const listPrivateSketches = (workspaceId: string, limit: number, offset: number, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=${limit}&offset=${offset}&scope=private`, { signal });
export const createPrivateSketch = (workspaceId: string, title: string, idempotencyKey: string) =>
  request<Sketch>(workspaceSketchesPath(workspaceId), { method: 'POST', body: { title, scope: 'private' }, headers: key(idempotencyKey) });

/** Sketches of one direct message (#96), newest change first. */
export const listDmSketches = (workspaceId: string, dmId: string, limit: number, offset: number, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?dmId=${dmId}&limit=${limit}&offset=${offset}`, { signal });
/** A sketch in a DM, optionally started from selected messages (each becomes a thought with its source). */
export const createDmSketch = (workspaceId: string, dmId: string, title: string, fromMessageIds: string[], idempotencyKey: string) =>
  request<Sketch>(workspaceSketchesPath(workspaceId), {
    method: 'POST', body: { title, scope: 'dm', dmId, ...(fromMessageIds.length ? { fromMessageIds } : {}) }, headers: key(idempotencyKey),
  });
/** Who could open a project copy of a DM sketch, and what goes in; nothing is shared. */
export const previewPromotion = (sketchId: string, target: { kind: 'new' } | { kind: 'existing'; projectId: string } | null, signal?: AbortSignal) =>
  request<SketchPromotionPreview>(`${sketchPromotionPath(sketchId)}${target ? (target.kind === 'new' ? '?target=new' : `?projectId=${target.projectId}`) : ''}`, { signal });
export const promoteSketch = (sketchId: string, target: PromotionTarget, token: string, idempotencyKey: string) =>
  request<PromotedSketch>(sketchPromotionPath(sketchId), { method: 'POST', body: { target, token }, headers: key(idempotencyKey) });

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

export const getProject = (projectId: string, signal?: AbortSignal) => request<Project>(projectPath(projectId), { signal });
