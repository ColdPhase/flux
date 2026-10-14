import { TaskUseRefusal } from '@flux/db';
import { ConflictError, RuleViolationError } from '@flux/core';

/** Translate a known storage outcome; no message parsing or additional authorization. */
export function taskUseDomainError(error: unknown): unknown {
  if (!(error instanceof TaskUseRefusal)) return error;
  if (error.code === 'TASK_TARGET_NOT_FOUND') return new RuleViolationError('A task target is unavailable', error.code);
  return new ConflictError(error.code === 'TASK_CREATION_REVERTED'
    ? 'Task creation was undone; open its history'
    : 'Task references changed; retry from current details', error.code);
}

export async function withTaskUseErrors<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw taskUseDomainError(error); }
}
