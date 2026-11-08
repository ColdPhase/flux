import { agentConnectionRepository, type Database } from '@flux/db';

/** One adapter for the browser's connection list, OAuth issuance and MCP calls. */
export function createAgentConnectionStore(db: Database) {
  const repository = agentConnectionRepository(db);
  return { ...repository, heldConnectionName: repository.heldName };
}
