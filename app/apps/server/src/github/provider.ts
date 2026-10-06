import type { GithubCheck, GithubPullFacts, GithubRepository, GithubReview } from '@flux/contracts';
import { githubId, NotFoundError, ServiceUnavailableError, type Database, type GithubProvider, type Principal } from '@flux/core';
import type { GithubCredentials } from './credentials.js';
import type { GithubConfig } from './config.js';
import { apiHeaders, providerDate, providerText, type GithubTransport, type ProviderJson } from './http.js';
const object = (value: unknown): ProviderJson => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceUnavailableError('GitHub returned invalid facts', 'GITHUB_INVALID_RESPONSE');
  return value as ProviderJson;
};
function list(value: unknown): ProviderJson[] {
  if (!Array.isArray(value) || value.length > 100) throw new ServiceUnavailableError('GitHub returned invalid facts', 'GITHUB_INVALID_RESPONSE');
  return value.map(object);
}
function slug(value: unknown) {
  const text = providerText(value, 100);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw new ServiceUnavailableError('GitHub returned an invalid repository name', 'GITHUB_INVALID_RESPONSE');
  return text;
}
function sha(value: unknown) {
  const text = providerText(value, 64);
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(text)) throw new ServiceUnavailableError('GitHub returned an invalid commit', 'GITHUB_INVALID_RESPONSE');
  return text;
}
export function githubProvider(credentials: Pick<GithubCredentials, 'token'> & Partial<Pick<GithubCredentials, 'forTransaction'>>, config: GithubConfig, transport: GithubTransport): GithubProvider & {
  inTransaction(tx: Database): GithubProvider;
  installations(principal: Principal): Promise<{ id: string; account: string }[]>;
  repositories(principal: Principal, installationId: string, page?: number): Promise<{ items: GithubRepository[]; more: boolean }>;
} {
  async function identity(principal: Principal) {
    const auth = await credentials.token(principal.id);
    const { data } = await transport.json('https://api.github.com/user', { headers: apiHeaders(auth.token) });
    if (githubId(data.id) !== auth.githubUserId || auth.appId !== config.appId) throw new NotFoundError('GitHub identity', 'GITHUB_ACCESS_UNAVAILABLE');
    return auth;
  }
  async function installations(principal: Principal) {
    const auth = await identity(principal); const items: { id: string; account: string }[] = []; const started = Date.now();
    for (let page = 1; page <= 20; page++) {
      if (Date.now() - started > 15_000) throw new ServiceUnavailableError('GitHub request window expired', 'GITHUB_WINDOW_EXCEEDED');
      const { data, truncated } = await transport.json(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: apiHeaders(auth.token) });
      for (const raw of list(data.installations)) {
        if (githubId(raw.app_id) === config.appId && !raw.suspended_at) {
          const permissions = object(raw.permissions);
          if (Object.values(permissions).some((value) => value === 'write') || ['pull_requests', 'checks', 'statuses'].some((key) => permissions[key] !== 'read'))
            throw new ServiceUnavailableError('Configure the read-only GitHub App permission profile', 'GITHUB_PERMISSION_PROFILE_INVALID');
          items.push({ id: githubId(raw.id), account: slug(object(raw.account).login) });
        }
      }
      if (!truncated) return items;
    }
    throw new ServiceUnavailableError('GitHub installation list exceeds the bounded request window', 'GITHUB_WINDOW_EXCEEDED');
  }
  async function repositories(principal: Principal, installationId: string, page = 1) {
    const selected = githubId(installationId);
    if (!Number.isSafeInteger(page) || page < 1 || page > 50) throw new ServiceUnavailableError('Invalid repository page', 'GITHUB_WINDOW_EXCEEDED');
    if (!(await installations(principal)).some((installation) => installation.id === selected)) throw new NotFoundError('Installation', 'GITHUB_ACCESS_UNAVAILABLE');
    const auth = await identity(principal);
    const { data, truncated } = await transport.json(`https://api.github.com/user/installations/${selected}/repositories?per_page=100&page=${page}`, { headers: apiHeaders(auth.token) });
    const items = list(data.repositories).map((raw): GithubRepository => {
      const permissions = object(raw.permissions); if (permissions.pull !== true) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
      const owner = slug(object(raw.owner).login); const name = slug(raw.name);
      return { host: 'github.com', installationId: selected, repositoryId: githubId(raw.id), owner, name,
        private: raw.private === true, url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` };
    });
    return { items, more: truncated };
  }
  return {
    inTransaction: (tx) => githubProvider(credentials.forTransaction?.(tx) ?? credentials, config, transport),
    installations, repositories,
    async repository(principal, installationId, repositoryId) {
      const selected = githubId(repositoryId);
      const installation = githubId(installationId);
      if (!(await installations(principal)).some((row) => row.id === installation)) throw new NotFoundError('Installation', 'GITHUB_ACCESS_UNAVAILABLE');
      const auth = await identity(principal); const started = Date.now();
      for (let page = 1; page <= 50; page++) {
        if (Date.now() - started > 15_000) throw new ServiceUnavailableError('GitHub request window expired', 'GITHUB_WINDOW_EXCEEDED');
        const { data, truncated } = await transport.json(`https://api.github.com/user/installations/${installation}/repositories?per_page=100&page=${page}`, { headers: apiHeaders(auth.token) });
        const raw = list(data.repositories).find((row) => githubId(row.id) === selected);
        if (raw) {
          if (object(raw.permissions).pull !== true) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
          const owner = slug(object(raw.owner).login); const name = slug(raw.name);
          return { host: 'github.com', installationId: installation, repositoryId: selected, owner, name, private: raw.private === true,
            url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, githubUserId: auth.githubUserId, appId: auth.appId, authorizationGeneration: auth.authorizationGeneration };
        }
        if (!truncated) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
      }
      throw new ServiceUnavailableError('GitHub repository list exceeds the bounded request window', 'GITHUB_WINDOW_EXCEEDED');
    },
    async pull(principal, repository, number): Promise<GithubPullFacts> {
      const auth = await identity(principal);
      const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
      const { data: raw } = await transport.json(`${base}/pulls/${number}`, { headers: apiHeaders(auth.token) });
      const baseRepo = object(object(raw.base).repo);
      if (githubId(baseRepo.id) !== repository.repositoryId || raw.number !== number) throw new NotFoundError('Pull request', 'GITHUB_PULL_NOT_FOUND');
      const headSha = sha(object(raw.head).sha); const author = object(raw.user);
      const [checkReply, statusReply, reviewReply] = await Promise.all([
        transport.json(`${base}/commits/${headSha}/check-runs?per_page=100&filter=latest`, { headers: apiHeaders(auth.token) }),
        transport.json(`${base}/commits/${headSha}/status?per_page=100`, { headers: apiHeaders(auth.token) }),
        transport.json(`${base}/pulls/${number}/reviews?per_page=100`, { headers: apiHeaders(auth.token) }),
      ]);
      const checkRuns = list(checkReply.data.check_runs);
      if (checkRuns.some((row) => row.head_sha !== headSha) || statusReply.data.sha !== headSha) throw new ServiceUnavailableError('GitHub checks do not describe the current commit', 'GITHUB_INVALID_RESPONSE');
      const checks: GithubCheck[] = checkRuns.map((row) => ({ id: githubId(row.id), name: providerText(row.name),
        appId: row.app ? githubId(object(row.app).id) : null,
        // A stale run must be re-run before it means anything: it never counts as passing (#74 G-1a).
        state: row.status !== 'completed' || row.conclusion === 'stale' ? 'pending' : row.conclusion === 'success' ? 'success' : ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(String(row.conclusion)) ? 'failure' : 'neutral',
        sourceUpdatedAt: providerDate(row.completed_at ?? row.started_at ?? row.created_at) }));
      for (const row of list(statusReply.data.statuses)) checks.push({ id: githubId(row.id), name: providerText(row.context), appId: null,
        state: row.state === 'success' ? 'success' : row.state === 'pending' ? 'pending' : 'failure', sourceUpdatedAt: providerDate(row.updated_at) });
      const reviews: GithubReview[] = list(reviewReply.data).map((row) => ({ id: githubId(row.id),
        author: { id: githubId(object(row.user).id), login: providerText(object(row.user).login, 100) }, headSha: sha(row.commit_id),
        state: providerText(row.state, 100), sourceSubmittedAt: row.submitted_at ? providerDate(row.submitted_at) : null }));
      const truncated = checkReply.truncated || statusReply.truncated || reviewReply.truncated || Number(checkReply.data.total_count) > checkRuns.length;
      if (raw.state !== 'open' && raw.state !== 'closed') throw new ServiceUnavailableError('Invalid GitHub pull state', 'GITHUB_INVALID_RESPONSE');
      const draft = raw.draft === true; const merged = raw.merged === true;
      const execution = merged ? 'merged' : raw.state === 'closed' ? 'closed_unmerged' : draft ? 'draft' : checks.some((check) => check.state === 'failure') ? 'checks_failed'
        : truncated || !checks.length || checks.some((check) => check.state !== 'success') ? 'checks_pending' : 'ready_for_review';
      return { repositoryId: repository.repositoryId, pullId: githubId(raw.id), number, title: providerText(raw.title),
        url: `${repository.url}/pull/${number}`, author: { id: githubId(author.id), login: providerText(author.login, 100) }, headSha,
        state: raw.state, draft, merged, sourceCreatedAt: providerDate(raw.created_at), sourceUpdatedAt: providerDate(raw.updated_at),
        sourceMergedAt: raw.merged_at ? providerDate(raw.merged_at) : null, checks, reviews, truncated, execution };
    },
  };
}
