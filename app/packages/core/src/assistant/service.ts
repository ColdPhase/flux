import { ASSISTANT_AREAS, ASSISTANT_LIMITS, type AssistantAreaMode, type UpdateAssistantSettings } from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { isId } from '../work/validation.js';
import type { AssistantSettingsPort } from './ports.js';

const unavailable = () => new NotFoundError('Assistant settings', 'ASSISTANT_SETTINGS_NOT_FOUND');
function owner(principal: Principal, workspaceId: string, ownerUserId: string) {
  if (principal.kind !== 'human' || principal.id !== ownerUserId || !isId(workspaceId)) throw unavailable();
  return principal.id;
}
export function normalizeAssistantSettings(input: UpdateAssistantSettings): UpdateAssistantSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['approvalMode', 'changesPerRun', 'backgroundRunsPerDay', 'areas', 'projectMode', 'selectedProjectIds', 'expectedVersion'].includes(key)))
    throw new InvalidInputError('Choose supported assistant settings');
  if (input.approvalMode !== undefined && !['act', 'ask'].includes(input.approvalMode)) throw new InvalidInputError('Choose act or ask');
  for (const key of ['changesPerRun', 'backgroundRunsPerDay'] as const) {
    const value = input[key]; const range = ASSISTANT_LIMITS[key];
    if (value !== undefined && (!Number.isInteger(value) || value < range.min || value > range.max)) throw new InvalidInputError(`${key} must be ${range.min}–${range.max}`);
  }
  if (input.areas !== undefined) {
    if (!input.areas || typeof input.areas !== 'object' || Array.isArray(input.areas)
      || Object.entries(input.areas).some(([key, value]) => !ASSISTANT_AREAS.some((area) => area.id === key) || !['off', 'read', 'edit'].includes(value as AssistantAreaMode)))
      throw new InvalidInputError('Choose off, only read or read and edit for supported areas');
  }
  if (input.projectMode !== undefined && !['all', 'chosen'].includes(input.projectMode)) throw new InvalidInputError('Choose all or chosen projects');
  if (input.selectedProjectIds !== undefined && (!Array.isArray(input.selectedProjectIds) || input.selectedProjectIds.length > 50
    || input.selectedProjectIds.some((id) => !isId(id)) || new Set(input.selectedProjectIds).size !== input.selectedProjectIds.length))
    throw new InvalidInputError('Choose distinct supported projects');
  if (input.selectedProjectIds !== undefined && input.projectMode !== 'chosen') throw new InvalidInputError('Use chosen projects when supplying a project list');
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
      if (result === 'OUTSIDE_CONSENT') throw new ForbiddenError('Choose projects and permissions within this assistant consent', 'ASSISTANT_OUTSIDE_CONSENT');
      if (result === 'AUTHORITY_UNAVAILABLE') throw new ForbiddenError('Current project access cannot allow this change', 'ASSISTANT_AUTHORITY_UNAVAILABLE');
      if ('conflict' in result) throw new VersionConflictError(result.conflict.version, result.conflict);
      return result;
    },
  };
}
