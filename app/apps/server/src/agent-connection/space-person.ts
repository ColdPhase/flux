import { ConflictError, DomainError, listSpacePeople } from '@flux/core';
import { accessPorts, type Database } from '@flux/db';
import { withAgentConnection, type FluxMcpClaims } from './context.js';

/** A name as people type it: no case, no accents (Polish "ł" too), single spaces. */
const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ł/g, 'l').replace(/\s+/g, ' ').trim();

/**
 * The person a task tool names (#1160): the task's owner or who it waits for, by their name as Flux shows it or by their user id, among the
 * people of the space (its People list, which the Owner field offers). A full name first, then one word of a name ("Bogdan" or
 * "Wiśniewski"), without case or accents. More than one fitting is refused with their names; nobody fitting is refused in the same words
 * whether or not such a person exists outside the space, so the answer names nobody the owner could not see there. It is read under the
 * same checks as every read (the owner's rights now, the run's place, the space's AI switch), before the change is prepared, and the change
 * keeps the id: the owner's Approve applies it to exactly that person.
 */
export async function spacePerson(db: Database, claims: FluxMcpClaims, projectId: string, given: string): Promise<string> {
  return withAgentConnection(db, claims, 'read', projectId, async ({ tx, principal }) => {
    const people = (await listSpacePeople(principal, projectId, tx as unknown as Database, accessPorts)).filter((person) => person.kind === 'human');
    const exact = people.find((person) => person.id === given.trim());
    if (exact) return exact.id;
    const wanted = plain(given);
    const full = people.filter((person) => plain(person.name) === wanted);
    const fits = full.length ? full : people.filter((person) => plain(person.name).split(' ').includes(wanted));
    if (fits.length === 1) return fits[0]!.id;
    if (fits.length > 1) throw new ConflictError(`More than one person in this space fits "${given}": ${fits.map((person) => `${person.name} (id ${person.id})`).join(', ')}. `
      + 'Give the full name, or the id.', 'PERSON_AMBIGUOUS');
    throw new DomainError(404, 'PERSON_NOT_IN_SPACE', `Nobody in this space is called "${given}". Give the name of a person of this space as Flux shows it, or ask your owner`);
  });
}
