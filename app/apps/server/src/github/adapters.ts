import { githubRows } from '@flux/db';
import { evaluateProject, enforce, githubUseCases, type Database, type GithubProvider, type GithubUnitOfWork } from '@flux/core';
import { githubTransaction } from './transactions.js';
type Provider = GithubProvider & { inTransaction?: (tx: Database) => GithubProvider };
export function githubUnitOfWork(db: Database, provider: Provider): GithubUnitOfWork {
  return { run: (work) => githubTransaction(db, async (tx) => work({ provider: provider.inTransaction?.(tx) ?? provider, rows: githubRows(tx), access: {
    async requireProject(principal, action, projectId) {
      const checked = enforce(await evaluateProject(principal, action === 'manage' ? 'project.manage' : action === 'write' ? 'project.write' : 'project.read', projectId, tx, { lock: true }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
  } })) };
}
export const createGithubUseCases = (db: Database, provider: Provider) => githubUseCases(githubUnitOfWork(db, provider));
