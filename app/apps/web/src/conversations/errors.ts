import { ApiError } from '../api/client';

/** The sentence a failed read or write of the conversation shows. */
export function readableError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This project or conversation is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project, but cannot post here.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}
