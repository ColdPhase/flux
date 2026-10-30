import { policyEventPorts } from '@flux/core';
import { eventRepository, accessReader, type Executor } from '@flux/db';

/** Event recording inside `tx` (#89): the access policy decides the audience, `@flux/db` stores. */
export const eventPorts = (tx: Executor) => policyEventPorts(accessReader(tx), eventRepository(tx));
