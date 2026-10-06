import { fileRows } from './files.js';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Read rows of one project for the export (issue #123), already in the wire shape of
 * `packages/contracts/src/export.ts`. They satisfy the `ProjectExportRows` port of
 * `packages/core/src/export/ports.ts` structurally and make no access decisions: the core use
 * case asks the policy for `project.manage` first. Every query is scoped to the project, and the
 * selections leave out what an export never contains: private sketches, note placements, the
 * private source note of a material, client mutation ids and fingerprints.
 */

type Actor = { kind: 'human' | 'agent'; id: string };
const human = (id: string): Actor => ({ kind: 'human', id });
const iso = (value: Date) => value.toISOString();

const c = schema.projectConversations;
const msg = schema.projectMessages;
const m = schema.projectMaterials;
const v = schema.projectMaterialVersions;
const s = schema.sketches;
const t = schema.sketchThoughts;
const sl = schema.sketchLinks;
const w = schema.projectWorkItems;
const d = schema.projectDecisions;
const r = schema.projectResults;
const l = schema.projectObjectLinks;

function groupBy<T, K>(rows: T[], keyOf: (row: T) => K) {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return groups;
}

function creator(userId: string | null, agentId: string | null): Actor {
  return userId ? human(userId) : { kind: 'agent', id: agentId! };
}

export function projectExportRows(db: DbExecutor) {
  async function versioned(projectId: string, kind: 'material' | 'doc') {
    const materials = await db.select().from(m).where(and(eq(m.projectId, projectId), eq(m.kind, kind))).orderBy(asc(m.createdAt), asc(m.id));
    if (!materials.length) return [];
    const versions = groupBy(await db.select({
      materialId: v.materialId, version: v.version, title: v.title, body: v.body, url: v.url, state: v.state, reason: v.reason,
      authorId: v.authorId, authorAgentId: v.authorAgentId, createdAt: v.createdAt,
    }).from(v).where(and(eq(v.projectId, projectId), inArray(v.materialId, materials.map((row) => row.id)))).orderBy(asc(v.materialId), asc(v.version)), (row) => row.materialId);
    return materials.map((row) => ({ row, versions: versions.get(row.id) ?? [] }));
  }

  return {
    async files(projectId: string) {
      const rows = await db.select({ file: schema.projectFiles, conversationId: msg.conversationId }).from(schema.projectFiles)
        .innerJoin(msg, eq(msg.id, schema.projectFiles.messageId))
        .where(and(eq(schema.projectFiles.projectId, projectId), sql`${schema.projectFiles.messageId} IS NOT NULL`))
        .orderBy(asc(schema.projectFiles.id));
      return rows.map(({ file, conversationId }) => ({ id: file.id, name: file.name, size: file.size!, sha256: file.sha256!,
        messageId: file.messageId!, conversationId, position: file.position!, path: `files/${file.id}` }));
    },
    async project(projectId: string) {
      const [row] = await db.select({ project: schema.projects, workspaceName: schema.workspaces.name }).from(schema.projects)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.projects.workspaceId)).where(eq(schema.projects.id, projectId));
      if (!row) return null;
      const { project } = row;
      return { id: project.id, name: project.name, visibility: project.visibility, createdAt: iso(project.createdAt), workspace: { id: project.workspaceId, name: row.workspaceName } };
    },

    async grants(projectId: string) {
      const rows = await db.select().from(schema.projectGrants).where(eq(schema.projectGrants.projectId, projectId)).orderBy(asc(schema.projectGrants.createdAt), asc(schema.projectGrants.id));
      return rows.map((row) => ({ principal: creator(row.userId, row.agentId), role: row.role, createdAt: iso(row.createdAt) }));
    },

    async workspaceRoles(workspaceId: string) {
      return db.select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role }).from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    },

    async conversations(projectId: string) {
      const conversations = await db.select().from(c).where(eq(c.projectId, projectId)).orderBy(asc(c.createdAt), asc(c.id));
      const messages = groupBy(await db.select().from(msg).where(eq(msg.projectId, projectId)).orderBy(asc(msg.conversationId), asc(msg.sequence)), (row) => row.conversationId);
      const files = await fileRows(db).projectMessageFiles(projectId);
      return conversations.map((row) => ({
        id: row.id, createdBy: creator(row.createdBy, row.createdByAgentId), createdAt: iso(row.createdAt),
        messages: (messages.get(row.id) ?? []).map((message) => ({
          ...(files.get(message.id)?.length ? { files: files.get(message.id) } : {}),
          id: message.id, sequence: message.sequence, author: creator(message.authorId, message.authorAgentId), body: message.body,
          source: message.sourceMaterialId && message.sourceMaterialVersion ? { materialId: message.sourceMaterialId, version: message.sourceMaterialVersion } : null,
          // Only an explicit native effect carries a marker, so every ordinary message exports exactly as before.
          ...(message.contributionKind === 'result' ? { contribution: { kind: 'result' as const, resultId: message.resultId! } }
            : message.contributionKind !== 'text' ? { contribution: { kind: message.contributionKind } } : {}),
          createdAt: iso(message.createdAt),
        })),
      }));
    },

    async materials(projectId: string) {
      return (await versioned(projectId, 'material')).map(({ row, versions }) => ({
        id: row.id, createdBy: creator(row.createdBy, row.createdByAgentId), createdAt: iso(row.createdAt), currentVersion: row.currentVersion,
        versions: versions.map((version) => ({ version: version.version, title: version.title, body: version.body, url: version.url,
          author: creator(version.authorId, version.authorAgentId), createdAt: iso(version.createdAt) })),
      }));
    },

    async docs(projectId: string) {
      return (await versioned(projectId, 'doc')).map(({ row, versions }) => ({
        // A doc and its versions may be agent-written under a standing grant (#152, migration 0043).
        id: row.id, createdBy: creator(row.createdBy, row.createdByAgentId), createdAt: iso(row.createdAt), currentVersion: row.currentVersion,
        versions: versions.map((version) => ({
          version: version.version, title: version.title, body: version.body, state: version.state ?? 'published' as const, reason: version.reason,
          author: creator(version.authorId, version.authorAgentId), createdAt: iso(version.createdAt),
        })),
      }));
    },

    /** Project sketches only; a private sketch is never selected, and placements are left out. */
    async sketches(projectId: string) {
      const sketches = await db.select().from(s).where(and(eq(s.projectId, projectId), eq(s.scope, 'project'))).orderBy(asc(s.createdAt), asc(s.id));
      if (!sketches.length) return [];
      const ids = sketches.map((row) => row.id);
      const thoughts = groupBy(await db.select({
        id: t.id, sketchId: t.sketchId, text: t.text, x: t.x, y: t.y, width: t.width, height: t.height, shape: t.shape,
        createdByUserId: t.createdByUserId, createdByAgentId: t.createdByAgentId, version: t.version, createdAt: t.createdAt,
      }).from(t).where(inArray(t.sketchId, ids)).orderBy(asc(t.createdAt), asc(t.id)), (row) => row.sketchId);
      const links = groupBy(await db.select().from(sl).where(inArray(sl.sketchId, ids)).orderBy(asc(sl.createdAt), asc(sl.id)), (row) => row.sketchId);
      return sketches.map((row) => ({
        id: row.id, title: row.title, createdBy: creator(row.createdByUserId, row.createdByAgentId), version: row.version,
        createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
        thoughts: (thoughts.get(row.id) ?? []).map((thought) => ({
          id: thought.id, text: thought.text, x: thought.x, y: thought.y, width: thought.width, height: thought.height, shape: thought.shape,
          createdBy: creator(thought.createdByUserId, thought.createdByAgentId), version: thought.version, createdAt: iso(thought.createdAt),
        })),
        links: (links.get(row.id) ?? []).map((link) => ({ id: link.id, fromId: link.fromId, toId: link.toId, label: link.label, createdAt: iso(link.createdAt) })),
      }));
    },

    async work(projectId: string) {
      const rows = await db.select().from(w).where(eq(w.projectId, projectId)).orderBy(asc(w.createdAt), asc(w.id));
      const notices = rows.length ? await db.select().from(schema.projectTaskNotices).where(eq(schema.projectTaskNotices.projectId, projectId))
        .orderBy(asc(schema.projectTaskNotices.createdAt), asc(schema.projectTaskNotices.id)) : [];
      return rows.map((row) => ({
        lifecycle: row.creationRevertedAt && row.creationRevertedByKind && row.creationRevertedById && row.creationReversionNoticeId
          ? { state: 'creation_reverted' as const, noticeId: row.creationReversionNoticeId, revertedAt: iso(row.creationRevertedAt), revertedBy: { kind: row.creationRevertedByKind, id: row.creationRevertedById } }
          : { state: 'active' as const },
        creationHistory: { origin: row.creationOrigin, baselineVersion: row.creationBaselineVersion, baseline: row.creationBaseline,
          proposalId: row.creationProposalId, firstPersistedUseAt: row.firstPersistedUseAt ? iso(row.firstPersistedUseAt) : null,
          notices: notices.filter((notice) => notice.workId === row.id).map((notice) => ({ id: notice.id, kind: notice.kind,
            createdBy: { kind: notice.createdByKind, id: notice.createdById }, sources: notice.sources, createdAt: iso(notice.createdAt) })) },
        id: row.id, title: row.title, outcome: row.outcome, status: row.status, blocker: row.blocker,
        owner: row.ownerUserId ? human(row.ownerUserId) : row.ownerAgentId ? { kind: 'agent' as const, id: row.ownerAgentId } : null,
        parked: row.parkedByDecisionId && row.parkedAt ? { decisionId: row.parkedByDecisionId, at: iso(row.parkedAt) } : null,
        createdBy: { kind: row.createdByKind, id: row.createdById }, version: row.version, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      }));
    },

    async decisions(projectId: string) {
      const rows = await db.select().from(d).where(eq(d.projectId, projectId)).orderBy(asc(d.createdAt), asc(d.id));
      return rows.map((row) => ({
        id: row.id, title: row.title, rationale: row.rationale, status: row.status, proposedBy: { kind: row.proposedByKind, id: row.proposedById },
        decidedBy: row.decidedBy ? human(row.decidedBy) : null, decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
        supersedesId: row.supersedesId, supersededById: row.supersededById, version: row.version, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      }));
    },

    async results(projectId: string) {
      const rows = await db.select().from(r).where(eq(r.projectId, projectId)).orderBy(asc(r.createdAt), asc(r.id));
      return rows.map((row) => ({ id: row.id, title: row.title, finding: row.finding, evidence: row.evidence, createdBy: { kind: row.createdByKind, id: row.createdById }, createdAt: iso(row.createdAt) }));
    },

    async links(projectId: string) {
      const rows = await db.select().from(l).where(eq(l.projectId, projectId)).orderBy(asc(l.createdAt), asc(l.id));
      return rows.map((row) => ({
        id: row.id, role: row.role, from: { type: row.fromType, id: row.fromId },
        to: row.toType === 'material' ? { type: 'material' as const, id: row.toId, version: row.toVersion ?? 1 } : { type: row.toType, id: row.toId },
        createdBy: { kind: row.createdByKind, id: row.createdById }, createdAt: iso(row.createdAt),
      }));
    },

    async names(actors: Actor[]) {
      const names = new Map<string, string>();
      const users = [...new Set(actors.filter((actor) => actor.kind === 'human').map((actor) => actor.id))];
      const agents = [...new Set(actors.filter((actor) => actor.kind === 'agent').map((actor) => actor.id))];
      if (users.length) {
        for (const row of await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, users)))
          names.set(`human:${row.id}`, row.name);
      }
      if (agents.length) {
        for (const row of await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents)))
          names.set(`agent:${row.id}`, row.name);
      }
      return names;
    },
  };
}

/**
 * Operator lookups for `./flux export` (issue #123): which project a command-line argument names
 * and which account the export acts as. The export itself still runs through the core use case,
 * so the policy decides whether that account may manage the project.
 */
export function exportOperatorRows(db: DbExecutor) {
  return {
    /** Projects whose id or exact name is `value`. */
    async findProjects(value: string) {
      const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? eq(schema.projects.id, value) : undefined;
      return db.select({ id: schema.projects.id, name: schema.projects.name, workspaceId: schema.projects.workspaceId }).from(schema.projects)
        .where(byId ? or(byId, eq(schema.projects.name, value)) : eq(schema.projects.name, value));
    },
    async findUserByEmail(email: string) {
      const [row] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers).where(sql`lower(${schema.authUsers.email}) = lower(${email})`);
      return row?.id ?? null;
    },
    /** The earliest owner of the workspace. */
    async workspaceOwner(workspaceId: string) {
      const [row] = await db.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, 'owner')))
        .orderBy(asc(schema.workspaceMembers.createdAt)).limit(1);
      return row?.userId ?? null;
    },
  };
}
