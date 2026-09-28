import type { LiveContextRef, LiveJoinGrant, LivePresentationRef, LiveSession } from '@flux/contracts';
import { InvalidInputError, NotFoundError, RuleViolationError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { LivePorts, LiveSessionRecord } from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidInputError(`${name} must be a UUID`);
  return value;
};
const human = (principal: Principal) => {
  if (principal.kind !== 'human') throw new RuleViolationError('Only people join live media sessions', 'HUMAN_SESSION_REQUIRED');
};

/** Domain boundary; transport and persistence implement the ports, never authorize by themselves. */
export function liveUseCases(ports: LivePorts) {
  async function visible({ roomId, ...session }: LiveSessionRecord): Promise<LiveSession> {
    let participants: LiveSession['participants'];
    try { participants = await ports.media.participants(roomId); }
    catch { participants = null; }
    return { ...session, participants };
  }
  async function current(principal: Principal, sessionId: string): Promise<LiveSessionRecord> {
    const session = await ports.sessions.find(uuid(sessionId, 'sessionId'));
    if (!session) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
    await ports.access.requireProject(principal, session.projectId);
    return session;
  }

  return {
    async start(principal: Principal, context: LiveContextRef, clientSessionId: string): Promise<LiveSession> {
      human(principal);
      if (!context || !['conversation', 'work', 'sketch'].includes(context.type))
        throw new InvalidInputError('context must name a conversation, work item or project sketch');
      uuid(context.id, 'context.id');
      uuid(clientSessionId, 'clientSessionId');
      const { projectId } = await ports.access.resolveContext(principal, context);
      const session = await ports.sessions.createOrGet(principal, projectId, context, clientSessionId, ports.media.ensureRoom);
      if (session.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
      return visible(session);
    },

    async get(principal: Principal, sessionId: string): Promise<LiveSession> {
      human(principal);
      return ports.sessions.withRead(principal, uuid(sessionId, 'sessionId'), visible);
    },

    async join(principal: Principal, sessionId: string): Promise<LiveJoinGrant> {
      human(principal);
      return ports.sessions.withAdmission(principal, uuid(sessionId, 'sessionId'), async (session) => {
        await ports.media.requireRoom(session.roomId);
        const grant = await ports.media.grant(session.roomId, principal.id);
        return { session: await visible(session), mediaUrl: ports.mediaUrl, token: grant.token, expiresAt: grant.expiresAt.toISOString() };
      });
    },

    async leave(principal: Principal, sessionId: string): Promise<void> {
      human(principal);
      const session = await ports.sessions.find(uuid(sessionId, 'sessionId'));
      if (!session) return;
      if (session.state === 'ending' || session.state === 'ended') return;
      // A person may disconnect their own media even after project access was revoked.
      await ports.media.removeParticipant(session.roomId, principal.id);
    },

    async present(principal: Principal, sessionId: string, ref: LivePresentationRef, clientEventId: string): Promise<void> {
      human(principal);
      const session = await current(principal, sessionId);
      if (session.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
      uuid(clientEventId, 'clientEventId');
      if (!ref || !['message', 'material', 'work', 'result', 'sketch'].includes(ref.type) || !Number.isInteger(ref.version) || ref.version < 1)
        throw new InvalidInputError('ref must name a versioned Flux object');
      uuid(ref.id, 'ref.id');
      if (ref.type === 'sketch' && (ref.selectedThoughtIds?.length ?? 0) > 100)
        throw new InvalidInputError('A presentation may select at most 100 thoughts');
      if (ref.type === 'sketch' && ref.selectedThoughtIds)
        for (const thoughtId of ref.selectedThoughtIds) uuid(thoughtId, 'selectedThoughtIds[]');
      await ports.access.requirePresentation(principal, session.projectId, ref);
      await ports.sessions.present(session.id, principal, ref, clientEventId);
    },
  };
}
