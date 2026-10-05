import type { GithubRuleChangeCode, GithubRuleMode, GithubTaskRule, WorkStatus } from '@flux/contracts';

/**
 * "Let linked PRs move this task" (#74 G-1a): the deterministic rule, a pure function of the current task, the rule's
 * own state and the current provider facts of the task's required PR links. No model, no clock and no webhook payload
 * takes part, so a duplicate or late delivery that re-reads the same facts reaches the same answer.
 *
 * | GitHub fact (current)                        | Effect                                                            |
 * | A required PR is open (also a draft)         | open -> in_progress                                               |
 * | A check fails on an open required PR's head  | open/in_progress -> blocked, "Check “ci” failed on PR #42"        |
 * | Every check passes again                     | blocked by this rule -> in_progress                               |
 * | Every required PR is merged                  | done (mode complete, no written criteria) or Ready to close       |
 * | A required PR is closed without merge        | blocked, "PR #42 closed without merge"; never done                |
 *
 * It never touches parked, done or not-pursued work, never clears a blocker a person wrote, never reassigns and never
 * changes the audience. Related links are not inputs. A manual change of status or blocker since the rule last acted
 * suspends it; other edits (title, owner, criteria) only move the version it expects.
 */

export type GithubRuleBlock = 'check' | 'closed';

export interface GithubRuleRecord {
  taskId: string;
  workspaceId: string;
  projectId: string;
  mode: GithubRuleMode;
  state: GithubTaskRule['state'];
  suspendedReason: GithubTaskRule['suspendedReason'];
  authorUserId: string | null;
  authorGithubUserId: string;
  authorGeneration: string;
  appId: string;
  expectedVersion: number;
  expectedStatus: WorkStatus;
  expectedBlocker: string | null;
  /** Set only while the task is blocked by this rule. */
  blockedBy: GithubRuleBlock | null;
  readyToClose: boolean;
  updatedAt: Date;
}

export interface GithubRuleTask {
  status: WorkStatus;
  blocker: string | null;
  parked: boolean;
  version: number;
  criteria: readonly string[];
  /** Every direct prerequisite is done and unparked: starting or finishing is allowed. */
  prerequisitesMet: boolean;
}

/** One required link's current facts. `available` is false when its binding or link cannot be read now. */
export interface GithubRulePull {
  linkId: string;
  number: number;
  available: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  checks: readonly { name: string; state: 'pending' | 'success' | 'failure' | 'neutral' }[];
  truncated: boolean;
}

export interface GithubRuleEffect {
  code: GithubRuleChangeCode;
  status: WorkStatus;
  blocker: string | null;
  blockedBy: GithubRuleBlock | null;
  readyToClose: boolean;
  pull: GithubRulePull | null;
  checkName: string | null;
}

export type GithubRuleOutcome =
  /** Nothing to do. `repin`: the task changed in ways the rule ignores; it now expects the current version. */
  | { kind: 'none'; repin: boolean }
  | { kind: 'suspend'; reason: 'manual_change' }
  /** `task`: the native status or blocker changes; otherwise only Ready to close or the rule's block changes. */
  | { kind: 'apply'; effect: GithubRuleEffect; task: boolean };

const FINISHED: ReadonlySet<WorkStatus> = new Set(['done', 'not_pursued']);
export const GITHUB_CHECK_NAME_LIMIT = 200;

/** Ready to close for tasks with written criteria (Flux never checks them off), Complete for the others. */
export function defaultGithubRuleMode(criteria: readonly string[]): GithubRuleMode {
  return criteria.length ? 'ready' : 'complete';
}

/** A person changed the status or blocker since the rule last acted. Finished or parked work is never the rule's. */
export function manuallyChanged(rule: Pick<GithubRuleRecord, 'expectedVersion' | 'expectedStatus' | 'expectedBlocker'>, task: Pick<GithubRuleTask, 'version' | 'status' | 'blocker' | 'parked'>) {
  if (task.parked || FINISHED.has(task.status) || task.version === rule.expectedVersion) return false;
  return task.status !== rule.expectedStatus || task.blocker !== rule.expectedBlocker;
}

/** The rule as its readers see it: a manual change shows as suspended before the next delivery persists it. */
export function presentGithubRule(rule: GithubRuleRecord, task: Pick<GithubRuleTask, 'version' | 'status' | 'blocker' | 'parked'>): Omit<GithubTaskRule, 'setUpBy'> {
  const manual = rule.state === 'active' && manuallyChanged(rule, task);
  return {
    mode: rule.mode, state: manual ? 'suspended' : rule.state, suspendedReason: manual ? 'manual_change' : rule.suspendedReason,
    expectedVersion: rule.expectedVersion, updatedAt: rule.updatedAt.toISOString(),
    readyToClose: rule.state !== 'off' && rule.readyToClose && !task.parked && !FINISHED.has(task.status),
  };
}

const clip = (name: string) => name.length > GITHUB_CHECK_NAME_LIMIT ? `${name.slice(0, GITHUB_CHECK_NAME_LIMIT - 1)}…` : name;
const byNumber = (a: GithubRulePull, b: GithubRulePull) => a.number - b.number;
const passed = (pull: GithubRulePull) => !pull.truncated && pull.checks.length > 0
  && pull.checks.every((check) => check.state === 'success' || check.state === 'neutral');

/** The text the rule writes as the task's blocker; it never includes PR titles or repository names. */
export function githubRuleBlocker(code: 'check_failed' | 'pull_closed', pull: number, check?: string) {
  return code === 'pull_closed' ? `PR #${pull} closed without merge` : `Check “${clip(check ?? '')}” failed on PR #${pull}`;
}

export function evaluateGithubRule(rule: Pick<GithubRuleRecord, 'state' | 'mode' | 'expectedVersion' | 'expectedStatus' | 'expectedBlocker' | 'blockedBy' | 'readyToClose'>,
  task: GithubRuleTask, required: readonly GithubRulePull[]): GithubRuleOutcome {
  if (rule.state !== 'active' || task.parked || FINISHED.has(task.status)) return { kind: 'none', repin: false };
  if (manuallyChanged(rule, task)) return { kind: 'suspend', reason: 'manual_change' };
  const repin = task.version !== rule.expectedVersion;
  // Every required link counts: one that cannot be read now leaves the task as it is (fail closed).
  if (!required.length || required.some((pull) => !pull.available)) return { kind: 'none', repin };
  const pulls = [...required].sort(byNumber);
  const ownsBlock = task.status === 'blocked' && rule.blockedBy !== null;
  const movable = task.status === 'open' || task.status === 'in_progress' || ownsBlock;
  const keep = (code: GithubRuleChangeCode, readyToClose: boolean, pull: GithubRulePull | null): GithubRuleEffect =>
    ({ code, status: task.status, blocker: task.blocker, blockedBy: ownsBlock ? rule.blockedBy : null, readyToClose, pull, checkName: null });
  const start = (code: GithubRuleChangeCode, pull: GithubRulePull | null, readyToClose = false): GithubRuleEffect =>
    // Starting needs every prerequisite done and unparked, as for a person.
    task.status === 'open' && !task.prerequisitesMet ? keep(code, readyToClose, pull)
      : { code, status: 'in_progress', blocker: null, blockedBy: null, readyToClose, pull, checkName: null };
  let effect: GithubRuleEffect;
  const closed = pulls.find((pull) => pull.state === 'closed' && !pull.merged);
  if (closed) {
    effect = movable ? { code: 'pull_closed', status: 'blocked', blocker: githubRuleBlocker('pull_closed', closed.number), blockedBy: 'closed',
      readyToClose: false, pull: closed, checkName: null } : keep('pull_closed', false, closed);
  } else if (pulls.every((pull) => pull.merged)) {
    const last = pulls.at(-1)!;
    const finish = rule.mode === 'complete' && task.criteria.length === 0 && task.prerequisitesMet && movable;
    effect = finish ? { code: 'merged_done', status: 'done', blocker: null, blockedBy: null, readyToClose: false, pull: last, checkName: null }
      : movable ? start('merged_ready', last, true) : keep('merged_ready', true, last);
  } else {
    const open = pulls.filter((pull) => pull.state === 'open');
    const failing = open.flatMap((pull) => pull.checks.filter((check) => check.state === 'failure').map((check) => ({ pull, check })))[0];
    if (failing) {
      effect = movable ? { code: 'check_failed', status: 'blocked', blocker: githubRuleBlocker('check_failed', failing.pull.number, failing.check.name),
        blockedBy: 'check', readyToClose: false, pull: failing.pull, checkName: clip(failing.check.name) } : keep('check_failed', false, failing.pull);
    } else if (ownsBlock) {
      // A failed check unblocks only once every check on each open PR's current head has passed; a reopened PR at once.
      effect = rule.blockedBy === 'closed' ? start('pull_reopened', open[0] ?? null)
        : open.every(passed) ? start('checks_passed', open[0] ?? null) : keep('checks_passed', false, open[0] ?? null);
    } else if (task.status === 'open') effect = start('pull_open', open[0] ?? null);
    else effect = keep('pull_open', false, open[0] ?? null);
  }
  const taskChanged = effect.status !== task.status || effect.blocker !== task.blocker;
  if (!taskChanged && effect.blockedBy === (ownsBlock ? rule.blockedBy : null) && effect.readyToClose === rule.readyToClose) return { kind: 'none', repin };
  return { kind: 'apply', effect, task: taskChanged };
}
