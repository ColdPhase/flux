import { DomainError } from '@flux/core';
import { taskUseDomainError } from '../work/task-use-errors.js';

export function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function toolError(error: unknown) {
  error = taskUseDomainError(error);
  const safe = error instanceof DomainError
    ? { code: error.code, error: error.message }
    : { code: 'MCP_TOOL_UNAVAILABLE', error: 'Tool unavailable' };
  return { ...toolResult(safe), isError: true };
}
