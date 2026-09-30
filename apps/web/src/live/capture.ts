/**
 * Browser capability checks that need no media SDK, so the live strip can render them before
 * the LiveKit client (loaded on demand when someone joins) is downloaded.
 */

/** Screen publishing needs the browser's picker; Android and iOS browsers do not have it. */
export function canPublishScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}
