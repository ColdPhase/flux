import { projectAgentsPath, type ProjectAgents } from '@flux/contracts';
import { request } from '../api/client';

/** The Agents view of a project (UI116-2, #136): current connections. */
export const getProjectAgents = (projectId: string, signal?: AbortSignal) => request<ProjectAgents>(projectAgentsPath(projectId), { signal });
