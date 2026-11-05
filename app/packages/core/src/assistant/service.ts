import { ASSISTANT_LIMITS, type UpdateAssistantSettings } from '@flux/contracts';
import { InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { isId } from '../work/validation.js';
import type { AssistantSettingsPort } from './ports.js';

const unavailable = () => new NotFoundError('Assistant settings', 'ASSISTANT_SETTINGS_NOT_FOUND');
function owner(principal: Principal, workspaceId: string, ownerUserId: string) {
  if (principal.kind !== 'human' || principal.id !== ownerUserId || !isId(workspaceId)) throw unavailable();
  return principal.id;
}
/** The assistant's own settings. Its "What it may do" is its connection's row (`PATCH /api/v1/agent-connections/:id`, F-036). */
export function normalizeAssistantSettings(input: UpdateAssistantSettings): UpdateAssistantSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['backgroundRunsPerDay', 'expectedVersion'].includes(key)))
    throw new InvalidInputError('Choose supported assistant settings');
  const value = input.backgroundRunsPerDay; const range = ASSISTANT_LIMITS.backgroundRunsPerDay;
  if (value !== undefined && (!Number.isInteger(value) || value < range.min || value > range.max)) throw new InvalidInputError(`backgroundRunsPerDay must be ${range.min}–${range.max}`);
  return input;
}
export function assistantSettingsUseCases(port: AssistantSettingsPort) {
  return {
    async get(principal: Principal, workspaceId: string, ownerUserId: string) {
      const result = await port.get(owner(principal, workspaceId, ownerUserId), workspaceId);
      if (!result) throw unavailable();
      return result;
    },
    async save(principal: Principal, workspaceId: string, ownerUserId: string, expected: number | undefined, input: UpdateAssistantSettings) {
      const caller = owner(principal, workspaceId, ownerUserId);
      if (!Number.isInteger(expected) || expected! < 1 || expected! >= 2_147_483_647) throw new InvalidInputError('Supply the current If-Match version', 'INVALID_PRECONDITION');
      const result = await port.save(caller, workspaceId, expected!, normalizeAssistantSettings(input));
      if (!result) throw unavailable();
      if ('conflict' in result) throw new VersionConflictError(result.conflict.version, result.conflict);
      return result;
    },
  };
}
