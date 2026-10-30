import {
  GITHUB_AUTHORIZATION_PATH, githubBindingPath, githubRuleDefaultPath, githubTaskLinksPath, githubTaskRulePath, projectGithubBindingsPath,
  projectGithubCapabilitiesPath, projectGithubInstallationsPath, projectGithubRepositoriesPath, projectGithubStartPath,
  type GithubBinding, type GithubCapabilities, type GithubRepository, type GithubRuleDefault, type GithubTaskLink, type GithubTaskRuleView,
} from '@flux/contracts';
import { request } from '../api/client';

/** The GitHub calls of the project settings and task Details (#74). The server decides every access. */
export const getGithubCapabilities = (projectId: string, signal?: AbortSignal) =>
  request<GithubCapabilities>(projectGithubCapabilitiesPath(projectId), { signal });
export const listGithubBindings = (projectId: string, signal?: AbortSignal) =>
  request<GithubBinding[]>(projectGithubBindingsPath(projectId), { signal });
/** The GitHub address that continues the person's authorization or the App installation. */
export const startGithub = (projectId: string, purpose: 'authorize' | 'install') =>
  request<{ url: string }>(projectGithubStartPath(projectId, purpose), { method: 'POST' });
export const disconnectGithubBinding = (bindingId: string) => request(githubBindingPath(bindingId), { method: 'DELETE' });
export const disconnectGithubAccount = () => request(GITHUB_AUTHORIZATION_PATH, { method: 'DELETE' });
export const listGithubInstallations = (projectId: string) =>
  request<{ id: string; account: string }[]>(projectGithubInstallationsPath(projectId));
export const listGithubRepositories = (projectId: string, installationId: string, page: number) =>
  request<{ items: GithubRepository[]; more: boolean }>(`${projectGithubRepositoriesPath(projectId, installationId)}?page=${page}`);
export const bindGithubRepository = (projectId: string, installationId: string, repositoryId: string) =>
  request(projectGithubBindingsPath(projectId), { method: 'POST', body: { installationId, repositoryId } });
export const saveGithubRuleDefault = (projectId: string, enabled: boolean, mode: GithubRuleDefault['mode']) =>
  request<{ ruleDefault: GithubRuleDefault | null }>(githubRuleDefaultPath(projectId), { method: 'PUT', body: { enabled, mode } });
export const listTaskGithubLinks = (taskId: string, signal?: AbortSignal) => request<GithubTaskLink[]>(githubTaskLinksPath(taskId), { signal });
export const linkTaskPull = (taskId: string, body: { bindingId: string; number: number; role: GithubTaskLink['role'] }) =>
  request(githubTaskLinksPath(taskId), { method: 'POST', body });
export const getGithubTaskRule = (taskId: string, signal?: AbortSignal) => request<GithubTaskRuleView>(githubTaskRulePath(taskId), { signal });
