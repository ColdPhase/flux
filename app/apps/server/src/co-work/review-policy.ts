import type { CoWorkReviewPolicy, SetCoWorkReviewPolicyCommand } from '@flux/contracts';
import { coworkReviewPolicyRows, accessReader, type Database } from '@flux/db';
import { enforce, evaluateProject, ForbiddenError, isUuid, normalizeCoWorkReviewRule, NotFoundError, recordEvent, type Principal } from '@flux/core';
import { eventPorts } from '../events.js';

// A project's explicit review rule (#153 AC-4): how separate a reviewer must be from the author. Everyone who can read the
// project sees it; only a project manager changes it. It narrows who may be given a review unit or request and never
// grants an agent anything; agents cannot read or set it through any tool, they only meet it as a refusal.

const projectOf = (value: string) => {
  if (!isUuid(value)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  return value.toLowerCase();
};

export async function readReviewPolicy(db: Database, principal: Principal, requested: string): Promise<CoWorkReviewPolicy> {
  const projectId = projectOf(requested);
  enforce(await evaluateProject(principal, 'project.read', projectId, accessReader(db)), 'project');
  const stored = await coworkReviewPolicyRows(db).get(projectId);
  return { projectId, reviewSeparation: stored?.reviewSeparation ?? 'distinct_connection', updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null };
}

export async function setReviewPolicy(db: Database, principal: Principal, requested: string, body: SetCoWorkReviewPolicyCommand): Promise<CoWorkReviewPolicy> {
  const projectId = projectOf(requested);
  const reviewSeparation = normalizeCoWorkReviewRule(body);
  if (principal.kind !== 'human') throw new ForbiddenError('Only a person sets the review rule', 'COWORK_POLICY_NEEDS_PERSON');
  await db.transaction(async (tx) => {
    // 404 for someone who cannot read the project, 403 unless a manager; the access rows are locked against a concurrent removal.
    const checked = enforce(await evaluateProject(principal, 'project.manage', projectId, accessReader(tx), { lock: true }), 'project');
    const rows = coworkReviewPolicyRows(tx);
    if ((await rows.current(projectId)) === reviewSeparation && await rows.get(projectId)) return;
    await rows.set(projectId, reviewSeparation, principal.id);
    await recordEvent(eventPorts(tx), principal, checked.project!.workspaceId, 'project.cowork_review_policy_changed.v1', projectId, { projectId });
  });
  return readReviewPolicy(db, principal, projectId);
}
