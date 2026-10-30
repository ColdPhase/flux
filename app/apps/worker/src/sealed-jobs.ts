import type { PgBoss } from 'pg-boss';
import { redactedError, SealedJobError } from '@flux/core';
import { sealedWorkScope, sql, type Database } from '@flux/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idsIn(value: unknown, into: Set<string>, depth = 0): Set<string> {
  if (depth > 4 || value === null || value === undefined) return into;
  if (typeof value === 'string') { if (UUID.test(value)) into.add(value.toLowerCase()); return into; }
  if (Array.isArray(value)) { for (const item of value.slice(0, 100)) idsIn(item, into, depth + 1); return into; }
  if (typeof value === 'object') for (const item of Object.values(value).slice(0, 100)) idsIn(item, into, depth + 1);
  return into;
}

/** Whether a job payload names an encrypted workspace (any id in it is one). */
async function namesSealedWorkspace(db: Database, payloads: unknown[]) {
  const ids = [...payloads.reduce<Set<string>>((into, data) => idsIn(data, into), new Set())];
  if (!ids.length) return false;
  // A workspace, or an object of one (#721 review P3-1: a payload may name only a project, conversation or DM).
  const list = `{${ids.join(',')}}`;
  const result = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.encrypted AND (w.id = ANY(${list}::uuid[])
    OR EXISTS (SELECT 1 FROM projects o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM project_conversations o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM dms o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM project_work_items o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM drafts o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM events o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
    OR EXISTS (SELECT 1 FROM notifications o WHERE o.workspace_id = w.id AND o.id = ANY(${list}::uuid[]))
  )) AS sealed`);
  return (result.rows[0] as { sealed: boolean }).sealed;
}

type Handler = (jobs: { id: string; data: unknown }[]) => Promise<unknown>;

/**
 * F-030 Error paths: every worker handler runs in `sealedWorkScope`. When the job touched an encrypted workspace's seal, or
 * its payload names one, its error is logged only as `redactedError` and pg-boss stores a `SealedJobError(code)`, so
 * neither the job's `output` nor the Docker log can quote content. `injectFailures` (test deployment only): a payload's
 * `fluxTestFailure` text fails the job with an error that quotes it.
 */
export function guardSealedJobs(boss: PgBoss, db: Database, options: { injectFailures: boolean }) {
  const work = boss.work.bind(boss) as (...args: unknown[]) => Promise<string>;
  (boss as { work: unknown }).work = (name: string, ...rest: unknown[]) => {
    const handler = rest.pop() as Handler;
    const guarded: Handler = (jobs) => sealedWorkScope.run({ sealed: false }, async () => {
      try {
        if (options.injectFailures) {
          const text = jobs.map((job) => (job.data as { fluxTestFailure?: unknown } | null)?.fluxTestFailure).find((value) => typeof value === 'string');
          if (text) throw Object.assign(new Error(`Injected job failure: ${text}`), { detail: text });
        }
        return await handler(jobs);
      } catch (error) {
        if (!(sealedWorkScope.getStore()?.sealed || await namesSealedWorkspace(db, jobs.map((job) => job.data)).catch(() => true))) throw error;
        const redacted = redactedError(error, jobs.map((job) => job.id));
        console.error(JSON.stringify({ job: name, error: redacted.message }));
        throw new SealedJobError(redacted.code ?? 'SEALED_JOB_FAILED');
      }
    });
    return work(name, ...rest, guarded);
  };
}
