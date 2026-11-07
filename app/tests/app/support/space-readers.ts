import { workspaceMembersPath, type ProjectPerson, type WorkspaceMember } from '@flux/contracts';
import { expectStatus, type Person } from './people.js';

/**
 * Everyone who can read a space now (F-037): the people added to it, which is what its People list shows, and the company's owners and
 * admins, who reach every space without being added. A promotion preview names exactly these.
 */
export async function spaceReaders(who: Person, workspaceId: string, projectId: string) {
  const listed = expectStatus(await who.browser.request('GET', `/api/v1/projects/${projectId}/people`), 200) as ProjectPerson[];
  const managers = (expectStatus(await who.browser.request('GET', workspaceMembersPath(workspaceId)), 200) as WorkspaceMember[]).filter((member) => member.role === 'owner' || member.role === 'admin');
  const people = new Map(listed.filter((person) => person.kind === 'human').map((person) => [person.id, person.name]));
  for (const member of managers) if (!people.has(member.userId)) people.set(member.userId, member.name);
  return { people: [...people].map(([id, name]) => ({ id, name })), agents: listed.filter((person) => person.kind === 'agent') };
}
