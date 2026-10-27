import { policyEventPorts, type Executor } from '@flux/core';
import { eventRepository, accessReader } from '@flux/db';

/** Event recording inside `tx` (#89): the access policy decides the audience, `@flux/db` stores. */
export const eventPorts = (tx: Executor) => policyEventPorts(accessReader(tx), eventRepository(tx));
