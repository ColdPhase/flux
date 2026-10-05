import type { TypingContext } from '@flux/contracts';
import type { Principal } from '../principal.js';
import { typingContextKey } from './commands.js';
import type { TypingPulse } from './presence.js';

export interface TypingActor { actorId: string; sessionId: string }
/** Current native authority, injected by the server. No cached grants or caller names. */
export interface TypingAccessPorts {
  currentHuman(actor: TypingActor): Promise<{ id: string; name: string } | null>;
  canonicalContext(principal: Principal, context: TypingContext, action: 'read' | 'write'): Promise<TypingContext | null>;
}
export interface TypingTaskDiscussion {
  /** Existing accepted canonical root only; reads never create a conversation. */
  conversation(principal: Principal, taskId: string): Promise<string | null>;
}
export async function authorizeTypingContext(ports: TypingAccessPorts, actor: TypingActor, context: TypingContext, action: 'read' | 'write'): Promise<TypingContext | null> {
  actor = { ...actor };
  context = { ...context };
  if (!(await ports.currentHuman(actor))) return null;
  const canonical = await ports.canonicalContext({ kind: 'human', id: actor.actorId }, context, action);
  if (!canonical || !(await ports.currentHuman(actor))) return null;
  return canonical;
}
/** Exact sender session, then current write, then exact session/name again before delivery. */
export async function authorizeTypingSender(ports: TypingAccessPorts, pulse: TypingPulse): Promise<{ id: string; name: string } | null> {
  const actor = { actorId: pulse.actorId, sessionId: pulse.sessionId };
  const context = { ...pulse.context };
  if (!(await ports.currentHuman(actor))) return null;
  const canonical = await ports.canonicalContext({ kind: 'human', id: actor.actorId }, context, 'write');
  if (!canonical || typingContextKey(canonical) !== typingContextKey(context)) return null;
  return ports.currentHuman(actor);
}
