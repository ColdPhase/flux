import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { GithubPullFacts } from '@flux/contracts';
import * as s from '../schema.js';
import type { DbExecutor } from './push.js';
type Binding = typeof s.githubBindings.$inferSelect;
type Link = typeof s.githubTaskLinks.$inferSelect;
type Rule = typeof s.githubTaskRules.$inferSelect;
type RuleChange = typeof s.githubTaskRuleChanges.$inferSelect;
interface Delivery {
  id: string; appId: string; digest: string; event: string; payload: Record<string, unknown>;
  installationId: string | null; repositoryId: string | null; origin: 'webhook' | 'reconcile'; providerObjectId: string | null;
  targetBindingId?: string | null;
}
const bindingView = (row: Binding) => ({ ...row, host: 'github.com' as const });
const ruleView = (row: Rule) => row;
const changeView = (row: RuleChange) => row;
const linkView = (row: Link) => { const { id, workspaceId, projectId, taskId, bindingId, role, facts, verifiedAt, state } = row; return { id, workspaceId, projectId, taskId, bindingId, role, facts, verifiedAt, state }; };
export function githubRows(db: DbExecutor) {
  const b = s.githubBindings; const l = s.githubTaskLinks; const p = s.githubProcessing; const d = s.githubDeliveries;
  const r = s.githubTaskRules; const c = s.githubTaskRuleChanges; const f = s.githubRuleDefaults;
  return {
    async binding(id: string, lock = false) {
      const query = db.select().from(b).where(eq(b.id, id));
      const [row] = lock ? await query.for('update') : await query;
      return row ? bindingView(row) : null;
    },
    async bindings(projectId: string) { return (await db.select().from(b).where(eq(b.projectId, projectId)).orderBy(asc(b.id))).map(bindingView); },
    async bind(input: Binding) {
      const { id, workspaceId, projectId, host, installationId, repositoryId, owner, name, private: privateRepo, url,
        authorUserId, authorGithubUserId, appId, authorizationGeneration, createdAt } = input;
      const [row] = await db.insert(b).values({ id, workspaceId, projectId, host, installationId, repositoryId, owner, name, private: privateRepo, url,
        authorUserId, authorGithubUserId, appId, authorizationGeneration, createdAt, state: 'active' }).onConflictDoUpdate({
        target: [b.projectId, b.host, b.repositoryId], set: { installationId, owner, name, private: privateRepo, url, authorUserId,
          authorGithubUserId, appId, authorizationGeneration, state: 'active' },
      }).returning();
      return bindingView(row!);
    },
    async disconnect(id: string) {
      await db.update(b).set({ state: 'disconnected' }).where(eq(b.id, id));
      await db.update(l).set({ state: 'unavailable' }).where(eq(l.bindingId, id));
    },
    async task(id: string) {
      const [row] = await db.select({ id: s.projectWorkItems.id, workspaceId: s.projectWorkItems.workspaceId, projectId: s.projectWorkItems.projectId })
        .from(s.projectWorkItems).where(eq(s.projectWorkItems.id, id));
      return row ?? null;
    },
    async links(taskId: string) { return (await db.select().from(l).where(eq(l.taskId, taskId)).orderBy(asc(l.id))).map(linkView); },
    async linkedPulls(bindingId: string) { return (await db.select().from(l).where(eq(l.bindingId, bindingId)).orderBy(asc(l.id))).map(linkView); },
    async link(input: Omit<Link, 'pullId'>) {
      const [row] = await db.insert(l).values({ ...input, pullId: input.facts.pullId }).onConflictDoNothing().returning();
      if (row) return linkView(row);
      const [existing] = await db.select().from(l).where(and(eq(l.taskId, input.taskId), eq(l.bindingId, input.bindingId), eq(l.pullId, input.facts.pullId), eq(l.role, input.role)));
      return linkView(existing!);
    },
    async saveFacts(id: string, facts: GithubPullFacts) { await db.update(l).set({ facts, state: 'current', verifiedAt: new Date() }).where(eq(l.id, id)); },
    async admit(input: Delivery): Promise<'created' | 'duplicate' | 'conflict'> {
      const inserted = await db.insert(d).values(input).onConflictDoNothing().returning({ id: d.id });
      if (!inserted.length) {
        const [old] = await db.select({ digest: d.digest, event: d.event }).from(d).where(eq(d.id, input.id));
        return old?.digest === input.digest && old.event === input.event ? 'duplicate' : 'conflict';
      }
      if (input.event === 'github_app_authorization') {
        const userId = input.providerObjectId;
        if (input.payload.action === 'revoked' && userId) {
          await db.update(s.githubCredentials).set({ state: 'revoked', encryptedTokens: null }).where(and(eq(s.githubCredentials.githubUserId, userId), eq(s.githubCredentials.appId, input.appId)));
          await db.update(b).set({ state: 'revoked' }).where(and(eq(b.authorGithubUserId, userId), eq(b.appId, input.appId)));
        }
      }
      if (input.event === 'installation' && ['deleted', 'suspend', 'suspended'].includes(String(input.payload.action)))
        await db.update(b).set({ state: 'revoked' }).where(and(eq(b.installationId, input.installationId ?? ''), eq(b.appId, input.appId)));
      if (input.event === 'installation_repositories' && input.payload.action === 'removed') {
        const removed = Array.isArray(input.payload.repositories_removed) ? input.payload.repositories_removed as { id?: unknown }[] : [];
        const ids = removed.flatMap((repo) => typeof repo.id === 'string' && /^[1-9]\d{0,24}$/.test(repo.id) ? [repo.id]
          : typeof repo.id === 'number' && Number.isSafeInteger(repo.id) && repo.id > 0 ? [String(repo.id)] : []);
        if (ids.length) await db.update(b).set({ state: 'revoked' }).where(and(eq(b.installationId, input.installationId ?? ''), inArray(b.repositoryId, ids), eq(b.appId, input.appId)));
      }
      if (input.repositoryId && input.installationId) {
        const bindings = await db.select({ id: b.id }).from(b).where(and(eq(b.repositoryId, input.repositoryId), eq(b.installationId, input.installationId), eq(b.state, 'active'), eq(b.appId, input.appId),
          input.origin === 'reconcile' && input.targetBindingId ? eq(b.id, input.targetBindingId) : undefined));
        if (bindings.length) await db.insert(p).values(bindings.map((binding) => ({ deliveryId: input.id, bindingId: binding.id }))).onConflictDoNothing();
      }
      return 'created';
    },
    async delivery(id: string) { const [row] = await db.select().from(d).where(eq(d.id, id)); return row ?? null; },
    async processing(deliveryId: string, bindingId: string) {
      const [row] = await db.select().from(p).where(and(eq(p.deliveryId, deliveryId), eq(p.bindingId, bindingId))).for('update');
      return row?.state ?? null;
    },
    async complete(deliveryId: string, bindingId: string, errorCode: string | null = null) {
      await db.update(p).set({ state: 'completed', errorCode }).where(and(eq(p.deliveryId, deliveryId), eq(p.bindingId, bindingId)));
    },
    async reconciliationCandidates(appId: string, window: string, limit: number) {
      return (await db.select().from(b).where(and(eq(b.appId, appId), eq(b.state, 'active'),
        sql`EXISTS (SELECT 1 FROM github_task_links gl WHERE gl.binding_id=${b.id})`,
        sql`NOT EXISTS (SELECT 1 FROM github_deliveries gd WHERE gd.id='gap-' || ${b.id}::text || '-' || ${window})`,
        sql`NOT EXISTS (SELECT 1 FROM github_processing gp JOIN github_deliveries gd ON gd.id=gp.delivery_id
          WHERE gp.binding_id=${b.id} AND gp.state='pending' AND gd.origin='reconcile')`)).orderBy(asc(b.id)).limit(limit)).map(bindingView);
    },
    async pendingReconciliation(bindingId: string) {
      const [row] = await db.select({ id: d.id }).from(d).innerJoin(p, eq(p.deliveryId, d.id))
        .where(and(eq(p.bindingId, bindingId), eq(p.state, 'pending'), eq(d.origin, 'reconcile'))).limit(1);
      return row?.id ?? null;
    },
    /** Run in the restore transaction before restarting any API/worker. Original facts stay internal. */
    async revokeRestored() {
      const credentials = await db.update(s.githubCredentials).set({ state: 'revoked', encryptedTokens: null, updatedAt: new Date() }).returning({ id: s.githubCredentials.userId });
      const bindings = await db.update(b).set({ state: 'revoked' }).returning({ id: b.id });
      await db.update(l).set({ state: 'unavailable' });
      // Restored standing task rules never act on restored authority; a person resumes them after reconnecting.
      await db.update(s.githubTaskRules).set({ state: 'suspended', suspendedReason: 'author_access', updatedAt: new Date() }).where(eq(s.githubTaskRules.state, 'active'));
      await db.update(s.githubOauthFlows).set({ consumedAt: new Date(), encryptedVerifier: null });
      await db.update(p).set({ state: 'completed', errorCode: 'GITHUB_RESTORED_AUTHORIZATION_REVOKED' });
      return { credentials: credentials.length, bindings: bindings.length };
    },
    async bridge(delivery: Delivery, binding: Binding, link: Omit<Link, 'pullId'>, facts: GithubPullFacts) {
      // Technical metadata only. No recipient, client wake or authority is fabricated.
      const comment = delivery.payload.comment as { updated_at?: unknown } | undefined;
      const correlationKey = createHash('sha256').update(JSON.stringify({ event: delivery.event, object: delivery.providerObjectId,
        sourceUpdatedAt: comment?.updated_at ?? null, facts })).digest('hex');
      await db.insert(s.githubBridgeOutbox).values({ id: randomUUID(), deliveryId: delivery.id, bindingId: binding.id, linkId: link.id,
        taskId: link.taskId, workspaceId: binding.workspaceId, projectId: binding.projectId, headSha: facts.headSha,
        event: delivery.event, providerObjectId: delivery.providerObjectId, correlationKey, state: 'pending_audience_adapter' }).onConflictDoNothing();
    },
    async rule(taskId: string, lock = false) {
      const query = db.select().from(r).where(eq(r.taskId, taskId));
      const [row] = lock ? await query.for('update') : await query;
      return row ? ruleView(row) : null;
    },
    /** Rules of these tasks for the native task read model; ids are not authorized here. */
    async taskRules(taskIds: readonly string[]) {
      if (!taskIds.length) return new Map<string, Rule>();
      return new Map((await db.select().from(r).where(inArray(r.taskId, [...taskIds]))).map((row) => [row.taskId, ruleView(row)]));
    },
    async saveRule(rule: Rule) {
      const { taskId, ...rest } = rule;
      await db.insert(r).values(rule).onConflictDoUpdate({ target: r.taskId, set: rest });
    },
    async activeRules(bindingId: string) {
      return (await db.select().from(r).where(and(eq(r.state, 'active'), sql`EXISTS (SELECT 1 FROM github_task_links gl
        WHERE gl.task_id=${r.taskId} AND gl.binding_id=${bindingId} AND gl.role='required_output')`)).orderBy(asc(r.taskId))).map(ruleView);
    },
    async recordRuleChange(change: RuleChange) { await db.insert(c).values(change).onConflictDoNothing(); },
    async ruleChanges(taskId: string, limit: number) {
      return (await db.select().from(c).where(eq(c.taskId, taskId)).orderBy(desc(c.createdAt), desc(c.id)).limit(limit)).map(changeView);
    },
    async ruleDefault(projectId: string) {
      const [row] = await db.select().from(f).where(eq(f.projectId, projectId));
      return row ? { mode: row.mode, setByUserId: row.setByUserId, updatedAt: row.updatedAt } : null;
    },
    async setRuleDefault(scope: { workspaceId: string; projectId: string }, value: { mode: 'complete' | 'ready' | null; setByUserId: string | null } | null) {
      if (!value) { await db.delete(f).where(eq(f.projectId, scope.projectId)); return; }
      await db.insert(f).values({ ...scope, ...value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: f.projectId, set: { mode: value.mode, setByUserId: value.setByUserId, updatedAt: new Date() } });
    },
    async due(limit = 10) {
      return db.select({ deliveryId: p.deliveryId, bindingId: p.bindingId }).from(p)
        .where(and(eq(p.state, 'pending'), lte(p.nextAttemptAt, new Date()))).orderBy(asc(p.nextAttemptAt)).limit(limit);
    },
    async failed(deliveryId: string, bindingId: string, errorCode: string) {
      await db.update(p).set({ attempts: sql`${p.attempts} + 1`, errorCode,
        nextAttemptAt: sql`now() + least(600, 10 * power(2, least(${p.attempts}, 6))) * interval '1 second'` })
        .where(and(eq(p.deliveryId, deliveryId), eq(p.bindingId, bindingId), eq(p.state, 'pending')));
      await db.update(l).set({ state: 'unavailable' }).where(eq(l.bindingId, bindingId));
    },
    async prune() {
      // Pending deliveries survive outages; delete completed/irrelevant raw bodies after seven days.
      await db.execute(sql`DELETE FROM ${d} WHERE ${d.id} IN (SELECT gd.id FROM github_deliveries gd
        WHERE gd.received_at < now() - interval '7 days' AND NOT EXISTS (
          SELECT 1 FROM github_processing gp WHERE gp.delivery_id=gd.id AND gp.state='pending') LIMIT 1000)`);
    },
  };
}
