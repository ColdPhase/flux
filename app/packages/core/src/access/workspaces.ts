import { randomUUID } from 'node:crypto';
import type { CreateWorkspaceCommand, Workspace, WorkspaceAiPolicy, WorkspaceEncryption, WorkspaceRole } from '@flux/contracts';
import { MISSING_ENCRYPTION_VIEW, presentEncryption } from '../encryption/view.js';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ForbiddenError, NotFoundError } from './errors.js';
import { enforce, evaluateWorkspace, isUuid } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { WorkspaceRecord } from './records.js';
import { name } from './validation.js';
import { workspaceAiViews } from './workspace-ai.js';

// Workspaces: create, list and read (issues #46, #91). Membership is in ./members.ts, the AI switch in ./workspace-ai.ts.

type WorkspacePorts = Pick<AccessPorts, 'workspaces' | 'access' | 'events' | 'encryption'>;

function toWorkspace(row: WorkspaceRecord, role: WorkspaceRole | null, ai: WorkspaceAiPolicy, encryption: WorkspaceEncryption | null = null): Workspace {
  return { id: row.id, name: row.name, role, version: row.version, createdAt: row.createdAt.toISOString(), ai: { ...ai, fixed: row.encrypted ? 'encrypted' : null }, encryption };
}

/** F-030 (#655): how a workspace is read; `bootId` is the boot under which the reading API can open keys (missing or null: locked). */
export interface WorkspaceReadOptions { bootId?: string | null }

/** The `encryption` field of each sealed workspace for one reader (plain workspaces get null). */
async function encryptionViews(db: Executor, ports: Pick<AccessPorts, 'encryption'>, principal: Principal, readers: { row: WorkspaceRecord; role: WorkspaceRole | null }[],
  options: WorkspaceReadOptions): Promise<Map<string, WorkspaceEncryption>> {
  const sealed = readers.filter((reader) => reader.row.encrypted);
  if (!sealed.length) return new Map();
  const rows = await ports.encryption(db).views(sealed.map((reader) => reader.row.id), principal.kind === 'human' ? principal.id : null);
  return new Map(sealed.map(({ row, role }) => [row.id, presentEncryption(rows.get(row.id) ?? MISSING_ENCRYPTION_VIEW, role, options.bootId ?? null)]));
}

/** Creates a workspace; the creating person becomes its owner. Agents cannot create workspaces. */
export async function createWorkspace(principal: Principal, command: CreateWorkspaceCommand, db: Database, ports: WorkspacePorts): Promise<Workspace> {
  if (principal.kind !== 'human') throw new ForbiddenError('Only people can create workspaces');
  const workspaceName = name(command?.name);
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const row = await ports.workspaces(tx).createWithOwner({ id, name: workspaceName, createdBy: principal.id });
    await recordEvent(eventPorts(ports, tx), principal, id, 'workspace.created.v1', id, {});
    return toWorkspace(row, 'owner', (await workspaceAiViews(tx, ports, [{ workspaceId: id, role: 'owner' }])).get(id)!);
  });
}

/** Workspaces where the principal is currently active. */
export async function listWorkspaces(principal: Principal, db: Database, ports: WorkspacePorts, options: WorkspaceReadOptions = {}): Promise<Workspace[]> {
  const workspaces = ports.workspaces(db);
  if (principal.kind === 'human') {
    const rows = await workspaces.forMember(principal.id);
    const ai = await workspaceAiViews(db, ports, rows.map((row) => ({ workspaceId: row.workspace.id, role: row.role })));
    const encryption = await encryptionViews(db, ports, principal, rows.map((row) => ({ row: row.workspace, role: row.role })), options);
    return rows.map((row) => toWorkspace(row.workspace, row.role, ai.get(row.workspace.id)!, encryption.get(row.workspace.id) ?? null));
  }
  if (principal.kind === 'agent' && isUuid(principal.id)) {
    const workspaceId = await workspaces.workspaceOfAgent(principal.id);
    if (!workspaceId) return [];
    const { visible } = await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db));
    if (!visible) return [];
    const row = await workspaces.get(workspaceId);
    return row ? [toWorkspace(row, null, (await workspaceAiViews(db, ports, [{ workspaceId: row.id, role: null }])).get(row.id)!,
      (await encryptionViews(db, ports, principal, [{ row, role: null }], options)).get(row.id) ?? null)] : [];
  }
  return [];
}

export async function getWorkspace(principal: Principal, workspaceId: string, db: Database, ports: WorkspacePorts, options: WorkspaceReadOptions = {}): Promise<Workspace> {
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db)), 'workspace');
  const row = await ports.workspaces(db).get(workspaceId);
  if (!row) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
  return toWorkspace(row, actor.role, (await workspaceAiViews(db, ports, [{ workspaceId: row.id, role: actor.role }])).get(row.id)!,
    (await encryptionViews(db, ports, principal, [{ row, role: actor.role }], options)).get(row.id) ?? null);
}
