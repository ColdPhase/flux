import { NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { isId } from '../work/validation.js';
import type { AssistantSettingsPort } from './ports.js';

const unavailable = () => new NotFoundError('Assistant settings', 'ASSISTANT_SETTINGS_NOT_FOUND');
function owner(principal: Principal, workspaceId: string, ownerUserId: string) {
  if (principal.kind !== 'human' || principal.id !== ownerUserId || !isId(workspaceId)) throw unavailable();
  return principal.id;
}
/** The assistant's own settings, read only: its "What it may do" is its connection's row (`PATCH /api/v1/agent-connections/:id`, F-036). */
export function assistantSettingsUseCases(port: AssistantSettingsPort) {
  return {
    async get(principal: Principal, workspaceId: string, ownerUserId: string) {
      const result = await port.get(owner(principal, workspaceId, ownerUserId), workspaceId);
      if (!result) throw unavailable();
      return result;
    },
  };
}
