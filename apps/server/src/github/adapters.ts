import { githubRows } from '@flux/db';
import { evaluateProject, enforce, githubUseCases, type Database, type GithubProvider, type GithubUnitOfWork } from '@flux/core';
export function githubUnitOfWork(db: Database, provider: GithubProvider): GithubUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => work({ provider, rows: githubRows(tx), access: {
    async requireProject(principal, action, projectId) {
      const checked = enforce(await evaluateProject(principal, action === 'manage' ? 'project.manage' : action === 'write' ? 'project.write' : 'project.read', projectId, tx, { lock: true }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
  } })) };
}
export const createGithubUseCases = (db: Database, provider: GithubProvider) => githubUseCases(githubUnitOfWork(db, provider));
