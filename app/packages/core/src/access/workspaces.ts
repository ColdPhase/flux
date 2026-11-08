import { randomUUID } from 'node:crypto';
import type { CreateWorkspaceCommand, RenameWorkspaceCommand, Workspace, WorkspaceEncryption, WorkspaceRole } from '@flux/contracts';
import { MISSING_ENCRYPTION_VIEW, presentEncryption } from '../encryption/view.js';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ForbiddenError, NotFoundError } from './errors.js';
import { enforce, evaluateWorkspace, isUuid } from './policy.js';
import { insertSpace } from './projects.js';
import type { AccessPorts } from './repositories.js';
import type { WorkspaceRecord } from './records.js';
import { name } from './validation.js';

// Workspaces: the company, list and read (issues #46, #91). Membership is in ./members.ts; a space's AI switch is in ./space-ai.ts.
//
// F-037 (#874): one Flux is one company. The first account sets it up (`joinCompany`) as its owner, with the
// Everyone space; with single sign-on every later account joins it on its first sign-in, and without single sign-on a
// company admin invites people with links (./invites.ts). Nobody creates another workspace: `createWorkspace` serves
// test deployments only, which keep isolated workspaces of their own.

type WorkspacePorts = Pick<AccessPorts, 'workspaces' | 'access' | 'events' | 'encryption'>;

function toWorkspace(row: WorkspaceRecord, role: WorkspaceRole | null, encryption: WorkspaceEncryption | null = null): Workspace {
  return { id: row.id, name: row.name, company: row.company, role, version: row.version, createdAt: row.createdAt.toISOString(), encryption, spaceOf: row.companyWorkspaceId };
}

/** The name setup gives the company; an owner or admin changes it in Settings › Company. */
export const COMPANY_NAME = 'Company';
/** The default space that holds the whole company (F-037). */
export const EVERYONE_SPACE_NAME = 'Everyone';

/**
 * F-037 setup and joining. The identity layer calls it for a new account, and again after each provider sign-in. The first
 * account makes the company, as its owner, with the Everyone space. Later, whoever signs in with the provider joins as a
 * member on their first sign-in, however the account came to exist; a password account joins only through an invite link.
 * Someone who left or was removed stays out until an admin restores them. Returns what happened. Setup takes one lock, so
 * two first sign-ups make one company.
 */
export async function joinCompany(userId: string, options: { sso: boolean }, db: Database,
  ports: Pick<AccessPorts, 'workspaces' | 'projects' | 'access' | 'events'>): Promise<'created' | 'joined' | null> {
  return db.transaction(async (tx) => {
    const workspaces = ports.workspaces(tx);
    await workspaces.lockCompanySetup();
    const company = await workspaces.company();
    const principal: Principal = { kind: 'human', id: userId };
    if (!company) {
      const id = randomUUID();
      await workspaces.createWithOwner({ id, name: COMPANY_NAME, createdBy: userId, company: true });
      await recordEvent(eventPorts(ports, tx), principal, id, 'workspace.created.v1', id, {});
      const everyone = await insertSpace(tx, ports, { workspaceId: id, name: EVERYONE_SPACE_NAME, visibility: 'workspace', createdBy: userId });
      await recordEvent(eventPorts(ports, tx), principal, id, 'project.created.v1', everyone.id, { visibility: 'workspace' });
      return 'created';
    }
    if (!options.sso || await workspaces.isMember(company.id, userId) || await workspaces.isRemoved(company.id, userId)) return null;
    await workspaces.lock(company.id);
    const member = await workspaces.insertMember({ workspaceId: company.id, userId, role: 'member', createdBy: userId });
    if (!member) return null;
    await recordEvent(eventPorts(ports, tx), principal, company.id, 'workspace.member_added.v1', company.id, { userId, role: 'member' });
    return 'joined';
  });
}

/** The company's name for the sign-in page and for email: nothing before setup, or while it still has the name setup gave it. */
export async function companyDisplayName(db: Database, ports: Pick<AccessPorts, 'workspaces'>): Promise<string | null> {
  const company = await ports.workspaces(db).company();
  return company && company.name !== COMPANY_NAME ? company.name : null;
}

/** An owner or admin renames the company (Settings › Company). */
export async function renameWorkspace(principal: Principal, workspaceId: string, command: RenameWorkspaceCommand, db: Database, ports: WorkspacePorts,
  options: WorkspaceReadOptions = {}): Promise<Workspace> {
  const workspaceName = name(command?.name);
  return db.transaction(async (tx) => {
    await ports.workspaces(tx).lock(workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.rename', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const row = await ports.workspaces(tx).rename(workspaceId, workspaceName);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'workspace.renamed.v1', workspaceId, {});
    return toWorkspace(row, actor.role, (await encryptionViews(tx, ports, principal, [{ row, role: actor.role }], options)).get(workspaceId) ?? null);
  });
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

/** Test deployments only (F-037): an isolated workspace whose owner is the creating person. Agents cannot create workspaces. */
export async function createWorkspace(principal: Principal, command: CreateWorkspaceCommand, db: Database, ports: WorkspacePorts): Promise<Workspace> {
  if (principal.kind !== 'human') throw new ForbiddenError('Only people can create workspaces');
  const workspaceName = name(command?.name);
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const row = await ports.workspaces(tx).createWithOwner({ id, name: workspaceName, createdBy: principal.id });
    await recordEvent(eventPorts(ports, tx), principal, id, 'workspace.created.v1', id, {});
    return toWorkspace(row, 'owner');
  });
}

/** Workspaces where the principal is currently active. */
export async function listWorkspaces(principal: Principal, db: Database, ports: WorkspacePorts, options: WorkspaceReadOptions = {}): Promise<Workspace[]> {
  const workspaces = ports.workspaces(db);
  if (principal.kind === 'human') {
    const rows = await workspaces.forMember(principal.id);
    const encryption = await encryptionViews(db, ports, principal, rows.map((row) => ({ row: row.workspace, role: row.role })), options);
    return rows.map((row) => toWorkspace(row.workspace, row.role, encryption.get(row.workspace.id) ?? null));
  }
  if (principal.kind === 'agent' && isUuid(principal.id)) {
    const workspaceId = await workspaces.workspaceOfAgent(principal.id);
    if (!workspaceId) return [];
    const { visible } = await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db));
    if (!visible) return [];
    const row = await workspaces.get(workspaceId);
    return row ? [toWorkspace(row, null, (await encryptionViews(db, ports, principal, [{ row, role: null }], options)).get(row.id) ?? null)] : [];
  }
  return [];
}

export async function getWorkspace(principal: Principal, workspaceId: string, db: Database, ports: WorkspacePorts, options: WorkspaceReadOptions = {}): Promise<Workspace> {
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db)), 'workspace');
  const row = await ports.workspaces(db).get(workspaceId);
  if (!row) throw new NotFoundError('Company', 'WORKSPACE_NOT_FOUND');
  return toWorkspace(row, actor.role, (await encryptionViews(db, ports, principal, [{ row, role: actor.role }], options)).get(row.id) ?? null);
}
