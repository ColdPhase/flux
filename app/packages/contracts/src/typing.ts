/** Ephemeral human activity: no draft content, event cursor, actor credentials or replay. */
export const TYPING_PATH = '/api/v1/typing';
export interface TypingContext { kind: 'conversation' | 'dm' | 'task'; id: string }
export type TypingCommand =
  | { type: 'watch'; context: TypingContext }
  | { type: 'active'; active: boolean }
  | { type: 'leave' };
export interface TypingSnapshot {
  type: 'snapshot';
  context: TypingContext;
  availability: 'ready' | 'unavailable';
  people: { id: string; name: string }[];
}
/** Authenticated socket owner, never a caller assertion or a session credential. */
export interface TypingIdentity { type: 'identity'; id: string }
export type TypingServerMessage = TypingIdentity | TypingSnapshot;
