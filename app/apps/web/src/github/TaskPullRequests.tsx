import { useEffect, useId, useState } from 'react';
import {
  githubTaskRulePath, githubTaskRuleResumePath, type GithubCapabilities, type GithubRuleChange, type GithubRuleMode, type GithubTaskLink,
  type GithubTaskRuleView, type Project, type WorkItem,
} from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { Button, Icon } from '../ui';
import { STATUS_LABEL, shortDate } from '../work/format';
import './task-pull-requests.css';

// "Let linked PRs move this task" in task Details (#74 G-1a). The rule's state and its automatic changes are part of
// the task: everyone who can read the task sees them. The linked PRs themselves (titles, links) stay behind each
// reader's own GitHub access, so a reader without it sees PR numbers only.

const EXECUTION: Record<GithubTaskLink['facts']['execution'], string> = {
  draft: 'draft', checks_pending: 'checks running', checks_failed: 'checks failed', ready_for_review: 'checks pass', merged: 'merged', closed_unmerged: 'closed without merge',
};

function reason(change: GithubRuleChange) {
  const pr = change.pullNumber ? `PR #${change.pullNumber}` : 'a PR';
  switch (change.code) {
    case 'pull_open': return `${pr} is open`;
    case 'pull_reopened': return `${pr} is open again`;
    case 'check_failed': return `Check “${change.checkName ?? ''}” failed on ${pr}`;
    case 'checks_passed': return `Checks pass on ${pr}`;
    case 'pull_closed': return `${pr} closed without merge`;
    case 'merged_done': return 'Every required PR is merged';
    case 'merged_ready': return 'Every required PR is merged · ready to close';
    case 'suspended_manual': return 'Paused: the status was changed by hand';
    case 'suspended_access': return `Paused: ${change.setUpBy?.name ?? 'the person who set it up'} can no longer use it`;
  }
}

function failure(cause: unknown) {
  if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') return 'Someone changed this task a moment ago. The latest version is shown; try again.';
  if (cause instanceof ApiError && cause.code === 'GITHUB_RULE_NEEDS_REQUIRED_PR') return 'Link a required pull request first.';
  if (cause instanceof ApiError && cause.status === 403) return 'You can read this task but not change it.';
  if (cause instanceof ApiError && (cause.status === 404 || cause.status === 503)) return 'Your GitHub access to a linked repository could not be confirmed. Reconnect GitHub in the project’s GitHub settings.';
  return 'Could not save. Try again.';
}

export function TaskPullRequests({ item, project, writable, reload }: { item: WorkItem; project: Project; writable: boolean; reload: () => void }) {
  const [links, setLinks] = useState<GithubTaskLink[]>([]);
  const [view, setView] = useState<GithubTaskRuleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const modeId = useId();
  const hasRule = !!item.githubRule;
  // A rule change (Ready to close, a pause) keeps the task version; its own timestamp reloads the history.
  const ruleStamp = item.githubRule?.updatedAt ?? '';
  // The private PR projection needs this reader's own GitHub authorization; without it the rule still shows.
  useEffect(() => {
    const controller = new AbortController(); const { signal } = controller;
    (async () => {
      const [capabilities, rule] = await Promise.all([
        request<GithubCapabilities>(`/api/v1/projects/${project.id}/github/capabilities`, { signal }).catch(() => null),
        hasRule ? request<GithubTaskRuleView>(githubTaskRulePath(item.id), { signal }).catch(() => null) : Promise.resolve(null),
      ]);
      const pulls = capabilities?.status === 'configured' && capabilities.authorization === 'connected'
        ? await request<GithubTaskLink[]>(`/api/v1/work/${item.id}/github-links`, { signal }).catch(() => []) : [];
      if (!signal.aborted) { setLinks(pulls); setView(rule); }
    })().catch(() => undefined);
    return () => controller.abort();
  }, [project.id, item.id, item.version, ruleStamp, hasRule]);

  const rule = item.githubRule;
  const required = links.filter((link) => link.role === 'required_output');
  if (!rule && !links.length) return null;
  const on = !!rule && rule.state !== 'off';
  const mode: GithubRuleMode = rule?.mode ?? (item.criteria.length ? 'ready' : 'complete');
  const pullUrl = new Map(links.map((link) => [link.id, link.facts.url]));

  async function send(path: string, method: 'PUT' | 'POST', body: Record<string, unknown>) {
    setBusy(true); setError('');
    try { await request(path, { method, body: { ...body, expectedVersion: item.version } }); reload(); }
    catch (cause) { setError(failure(cause)); if (cause instanceof ApiError && cause.status === 409) reload(); }
    finally { setBusy(false); }
  }

  return (
    <section className="details__sec wd-gh" aria-labelledby={`wd-gh-${item.id}`}>
      <h4 id={`wd-gh-${item.id}`}>Pull requests</h4>
      {links.length ? (
        <ul className="wd-links">
          {links.map((link) => (
            <li key={link.id}>
              <a className="wd-link" href={link.facts.url} target="_blank" rel="noreferrer">
                <span>#{link.facts.number} · {link.facts.title}</span>
                <small>{link.role === 'required_output' ? 'Required' : 'Related'} · {EXECUTION[link.facts.execution]}</small>
                <Icon name="link" size={14} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {rule?.state === 'suspended' ? (
        <div className="wd-gh-note" role="status">
          <p>{rule.suspendedReason === 'manual_change' ? 'Paused because the status or blocker was changed by hand.' : `Paused because ${rule.setUpBy?.name ?? 'the person who set it up'} can no longer use it.`} Linked PRs do not move this task until someone resumes it.</p>
          {writable ? <Button variant="secondary" busy={busy} onClick={() => void send(githubTaskRuleResumePath(item.id), 'POST', {})}>Resume</Button> : null}
        </div>
      ) : null}
      {writable && (required.length || on) ? (
        <div className="wd-gh-rule">
          <label className="wd-gh-toggle">
            <input type="checkbox" role="switch" checked={on} disabled={busy || (!on && !required.length)}
              onChange={(event) => void send(githubTaskRulePath(item.id), 'PUT', { enabled: event.target.checked })} />
            <span>Let linked PRs move this task</span>
          </label>
          <p className="wd-muted">A required PR that opens starts it, a failing check blocks it and merging {mode === 'complete' ? 'finishes it' : 'makes it ready to close'}. Everyone who can see this task sees these changes.</p>
          {on ? (
            <div className="wd-gh-mode">
              <label htmlFor={modeId}>When every required PR is merged</label>
              <select id={modeId} value={mode} disabled={busy} onChange={(event) => void send(githubTaskRulePath(item.id), 'PUT', { enabled: true, mode: event.target.value })}>
                <option value="ready">Show Ready to close</option>
                <option value="complete">Mark it done</option>
              </select>
            </div>
          ) : null}
          {on && rule?.setUpBy ? <p className="wd-muted">Set up by {rule.setUpBy.name}. Written criteria are never checked off by a merge.</p> : null}
        </div>
      ) : on ? <p className="wd-muted">Linked PRs move this task{rule?.setUpBy ? ` · set up by ${rule.setUpBy.name}` : ''}.</p> : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      {view?.changes.length ? (
        <ol className="wd-gh-history" aria-label="Changes by GitHub rule">
          {view.changes.map((change) => (
            <li key={change.id}>
              <span className="wd-gh-history__what">
                {change.from !== change.to ? <b>{STATUS_LABEL[change.to]}</b> : null}
                {change.pullNumber && pullUrl.has(change.linkId ?? '') ? <a href={pullUrl.get(change.linkId!)} target="_blank" rel="noreferrer">{reason(change)}</a> : reason(change)}
              </span>
              <small>by GitHub rule · set up by {change.setUpBy?.name ?? 'a former member'} · {shortDate(change.at)}{change.headSha ? ` · ${change.headSha.slice(0, 7)}` : ''}</small>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** One tap finishes a task whose required PRs are all merged; it is an ordinary, versioned status change by this person. */
export function ReadyToClose({ item, writable, busy, done }: { item: WorkItem; writable: boolean; busy: boolean; done: () => void }) {
  if (!item.githubRule?.readyToClose) return null;
  return (
    <div className="wd-gh-ready" role="status">
      <Icon name="check" size={14} />
      <p><b>Ready to close.</b> Every required PR is merged.</p>
      {writable ? <Button variant="primary" busy={busy} onClick={done}>Mark done</Button> : null}
    </div>
  );
}
