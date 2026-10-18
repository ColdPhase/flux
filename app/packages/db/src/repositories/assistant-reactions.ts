import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AssistantReaction, AssistantReactionAction, AssistantReplyDraft, AssistantReactionRecent, SaveAssistantReaction } from '@flux/contracts';
import type { DbExecutor } from './push.js';

type Rule = Omit<AssistantReaction, 'last'> & { ownerUserId: string };
type Event = { id: string; reactionId: string; ownerUserId: string; objectId: string; sourceId: string; action: AssistantReactionAction; state: 'queued' | 'proof' | 'running' | 'done' | 'skipped' | 'failed'; runId: string | null; createdAt: Date; data: Record<string, unknown> | null };
const ruleColumns = sql`r.id,r.workspace_id AS "workspaceId",r.project_id AS "projectId",p.name AS "projectName",r.owner_user_id AS "ownerUserId",r.event,r.action,r.enabled,r.daily_limit AS "dailyLimit",r.version`;
const eventColumns = sql`e.id,e.reaction_id AS "reactionId",e.owner_user_id AS "ownerUserId",e.object_id AS "objectId",e.source_id AS "sourceId",e.action,e.state,e.run_id AS "runId",e.created_at AS "createdAt",e.data`;

/** Persistence only: core authorizes the owner, project and switched-on area before reading event data. */
export function assistantReactionRows(db: DbExecutor) {
  const query = async <T>(statement: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(statement)).rows as T[];
  const one = async <T>(statement: ReturnType<typeof sql>): Promise<T | null> => (await query<T>(statement))[0] ?? null;
  async function find(id: string, lock = false): Promise<Rule | null> {
    return one<Rule>(sql`SELECT ${ruleColumns} FROM assistant_reactions r JOIN projects p ON p.id=r.project_id WHERE r.id=${id} ${lock ? sql`FOR UPDATE OF r` : sql``}`);
  }
  return {
    async list(owner: string, workspace: string): Promise<AssistantReaction[]> {
      return query<AssistantReaction>(sql`SELECT ${ruleColumns},(SELECT jsonb_build_object('line',e.line,'at',e.created_at) FROM assistant_reaction_events e
        WHERE e.reaction_id=r.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS last
        FROM assistant_reactions r JOIN projects p ON p.id=r.project_id WHERE r.owner_user_id=${owner} AND r.workspace_id=${workspace} ORDER BY r.created_at,r.id`);
    },
    find,
    async save(owner: string, workspace: string, id: string | null, command: SaveAssistantReaction): Promise<Rule> {
      if (id) await db.execute(sql`UPDATE assistant_reactions SET project_id=${command.projectId},event=${command.event},action=${command.action},enabled=${command.enabled},daily_limit=${command.dailyLimit ?? 10},version=version+1,updated_at=now() WHERE id=${id} AND owner_user_id=${owner}`);
      else {
        id = randomUUID();
        await db.execute(sql`INSERT INTO assistant_reactions(id,workspace_id,project_id,owner_user_id,event,action,enabled,daily_limit) VALUES
          (${id},${workspace},${command.projectId},${owner},${command.event},${command.action},${command.enabled},${command.dailyLimit ?? 10})`);
      }
      return (await find(id))!;
    },
    async linked(project: string): Promise<boolean> { return !!await one(sql`SELECT id FROM github_bindings WHERE project_id=${project} AND state='active' LIMIT 1`); },
    async lockQueued(now: Date): Promise<Event | null> { return one<Event>(sql`SELECT ${eventColumns} FROM assistant_reaction_events e WHERE state='queued' AND created_at<=${now} ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`); },
    async running(reaction: string): Promise<boolean> { return !!await one(sql`SELECT id FROM assistant_reaction_events WHERE reaction_id=${reaction} AND state='running' LIMIT 1`); },
    async debounced(owner: string, object: string, since: Date): Promise<boolean> {
      return !!await one(sql`SELECT id FROM assistant_reaction_events WHERE owner_user_id=${owner} AND object_id=${object} AND run_id IS NOT NULL AND started_at>${since} LIMIT 1`);
    },
    async countToday(reaction: string, zone: string): Promise<number> {
      return Number((await one<{ count: number }>(sql`SELECT count(*)::int AS count FROM assistant_reaction_events WHERE reaction_id=${reaction} AND run_id IS NOT NULL
        AND started_at>=(date_trunc('day',now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`))?.count ?? 0);
    },
    async facts(event: Event, rule: Rule) {
      if (rule.event === 'mentioned') {
        const note = await one<{ userId: string; projectId: string; url: string; body: string }>(sql`SELECT user_id AS "userId",source_id AS "projectId",url,body FROM notifications
          WHERE id=${event.objectId} AND user_id=${rule.ownerUserId} AND source_type='project' AND source_id=${rule.projectId} AND reason IN ('mention','question')`);
        const ids = note?.url.match(/\/conversations\/([0-9a-f-]+)#message-([0-9a-f-]+)/);
        if (!note || !ids) return null;
        const message = await one<{ body: string; ownerName: string }>(sql`SELECT m.body,u.name AS "ownerName" FROM project_messages m JOIN auth_users u ON u.id=${rule.ownerUserId} WHERE m.id=${ids[2]} AND m.conversation_id=${ids[1]} AND m.project_id=${rule.projectId}`);
        if (!message) return null;
        return { ownerUserId: note.userId, projectId: note.projectId, conversationId: ids[1]!, notificationId: event.objectId,
          data: { notificationId: event.objectId, conversationId: ids[1], message: message.body.slice(0, 8000), ownerName: message.ownerName } };
      }
      const task = await one<{ ownerUserId: string; projectId: string; title: string; outcome: string; blocker: string | null; criteria: string[]; version: number }>(sql`
        SELECT owner_user_id AS "ownerUserId",project_id AS "projectId",title,outcome,blocker,criteria,version FROM project_work_items WHERE id=${event.objectId} AND project_id=${rule.projectId} AND owner_user_id=${rule.ownerUserId} AND creation_reverted_at IS NULL`);
      if (!task) return null;
      let extra: Record<string, unknown> = {};
      if (rule.event === 'failed_result') {
        const result = await one<{ title: string; evidence: string }>(sql`SELECT title,evidence FROM project_results WHERE id=${event.sourceId} AND project_id=${rule.projectId} AND finding='negative'`);
        if (!result) return null;
        extra = { result: { title: result.title, evidence: result.evidence.slice(0, 8000) } };
      }
      if (rule.event === 'pr_ready') {
        // Server's existing G-1 reader supplied a current per-human proof, not just project membership.
        if (!event.data) return null;
        const proof = event.data.proof as { generation?: string; owner?: string; bindings?: { id: string; generation: string }[] } | undefined;
        if (!proof || proof.owner !== rule.ownerUserId || !await one(sql`SELECT user_id FROM github_credentials WHERE user_id=${rule.ownerUserId} AND state='active' AND generation=${proof.generation}`)) return null;
        for (const binding of proof.bindings ?? []) if (!await one(sql`SELECT id FROM github_bindings WHERE id=${binding.id} AND authorization_generation=${binding.generation} AND state='active' AND project_id=${rule.projectId}`)) return null;
        extra = { pullRequests: event.data.pullRequests };
      }
      return { ownerUserId: task.ownerUserId, projectId: task.projectId, conversationId: null, notificationId: null,
        data: { task: { id: event.objectId, version: task.version, title: task.title, outcome: task.outcome.slice(0, 4000), blocker: task.blocker, criteria: task.criteria }, ...extra } };
    },
    async updateEvent(id: string, value: { state: Event['state']; runId?: string; line?: string; startedAt?: Date; finishedAt?: Date }) {
      await db.execute(sql`UPDATE assistant_reaction_events SET state=${value.state},run_id=COALESCE(${value.runId ?? null},run_id),line=COALESCE(${value.line ?? null},line),
        started_at=COALESCE(${value.startedAt ?? null},started_at),finished_at=COALESCE(${value.finishedAt ?? null},finished_at) WHERE id=${id}`);
    },
    async open(): Promise<Event[]> { return query<Event>(sql`SELECT ${eventColumns} FROM assistant_reaction_events e WHERE state='running' ORDER BY created_at,id LIMIT 50`); },
    async deliver(event: Event, rule: Rule, answer: string) {
      if (!answer.trim()) return;
      const draft = event.action === 'draft_reply' ? answer.slice(0, 8000) : null;
      let notification = rule.event === 'mentioned' ? event.objectId : null;
      const url = rule.event === 'mentioned' ? null : `/projects/${rule.projectId}/tasks/${event.objectId}`;
      if (!notification && rule.event !== 'blocked') {
        notification = (await one<{ id: string }>(sql`SELECT id FROM notifications WHERE user_id=${rule.ownerUserId} AND source_type='project' AND source_id=${rule.projectId} AND url=${url} AND read_at IS NULL ORDER BY created_at DESC LIMIT 1`))?.id ?? null;
        if (!notification) {
          notification = randomUUID();
          await db.execute(sql`INSERT INTO notifications(id,user_id,workspace_id,source_type,source_id,title,body,url,reason) VALUES
            (${notification},${rule.ownerUserId},${rule.workspaceId},'project',${rule.projectId},'Your assistant has a note for your task',${answer.slice(0, 1000)},${url},'question')`);
        }
      }
      // No enqueue/send here. A note folds into the existing item and creates no second push.
      await db.execute(sql`INSERT INTO assistant_reaction_notes(owner_user_id,project_id,object_id,notification_id,event_id,note,draft)
        VALUES(${rule.ownerUserId},${rule.projectId},${event.objectId},${notification},${event.id},${draft ? '' : answer.slice(0, 2000)},${draft})
        ON CONFLICT(owner_user_id,object_id) DO UPDATE SET notification_id=EXCLUDED.notification_id,event_id=EXCLUDED.event_id,note=EXCLUDED.note,draft=EXCLUDED.draft`);
    },
    async notes(owner: string) { return query<{ objectId: string; notificationId: string | null; note: string; draft: boolean; projectId: string }>(sql`
      SELECT object_id AS "objectId",notification_id AS "notificationId",note,(draft IS NOT NULL) AS draft,project_id AS "projectId" FROM assistant_reaction_notes WHERE owner_user_id=${owner}`); },
    async draft(owner: string, notification: string): Promise<AssistantReplyDraft | null> {
      const row = await one<{ body: string; projectId: string; url: string }>(sql`SELECT a.draft AS body,a.project_id AS "projectId",n.url FROM assistant_reaction_notes a
        JOIN notifications n ON n.id=a.notification_id AND n.user_id=a.owner_user_id WHERE a.owner_user_id=${owner} AND a.notification_id=${notification} AND a.draft IS NOT NULL`);
      const match = row?.url.match(/\/conversations\/([0-9a-f-]+)/);
      return row && match ? { ...row, ownerUserId: owner, conversationId: match[1]! } : null;
    },
    async history(owner: string, workspace: string): Promise<AssistantReactionRecent[]> {
      return query<AssistantReactionRecent>(sql`SELECT e.id,e.created_at AS at,e.line,r.event AS name FROM assistant_reaction_events e JOIN assistant_reactions r ON r.id=e.reaction_id
        WHERE e.owner_user_id=${owner} AND r.workspace_id=${workspace} AND e.state NOT IN ('queued','proof') ORDER BY e.created_at DESC,e.id DESC LIMIT 20`);
    },
    async proofEvents() { return query<Event & { projectId: string }>(sql`SELECT ${eventColumns},r.project_id AS "projectId" FROM assistant_reaction_events e JOIN assistant_reactions r ON r.id=e.reaction_id WHERE e.state='proof' AND r.enabled ORDER BY e.created_at LIMIT 20`); },
    async saveProof(id: string, data: Record<string, unknown>) { await db.execute(sql`UPDATE assistant_reaction_events SET data=${JSON.stringify(data)}::jsonb,state='queued' WHERE id=${id} AND state='proof'`); },
    async credential(owner: string) { return one<{ generation: string }>(sql`SELECT generation FROM github_credentials WHERE user_id=${owner} AND state='active' ORDER BY updated_at DESC LIMIT 1`); },
  };
}
