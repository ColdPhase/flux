import { lookup } from 'node:dns/promises';
import { RUNTIME_PORTS, RUNTIME_SECRET } from '@flux/runtime-protocol';
import { createManagerServer, slotsFromEnv } from './server.js';

// `runtime-manager`'s main process. It listens only on its `runtime-control` address: the network alias
// `runtime-manager-control` exists on that network alone, so the slots, which share other networks
// with the manager, find nothing listening there (F-022 "On slot networks it only connects out").

const env = process.env;
const secret = env.FLUX_RUNTIME_MANAGER_SECRET ?? '';
if (!RUNTIME_SECRET.test(secret)) throw new Error('FLUX_RUNTIME_MANAGER_SECRET is missing or shorter than 32 characters; ./flux generates it in docker/.env');
const slots = slotsFromEnv(env, RUNTIME_SECRET);
if (slots.size === 0) throw new Error('No runtime slot is configured (FLUX_RUNTIME_SLOT_<n>)');
const listenName = env.FLUX_RUNTIME_MANAGER_LISTEN ?? 'runtime-manager-control';
const { address } = await lookup(listenName, { family: 4 });

const server = createManagerServer({ secret, slots });
server.listen(RUNTIME_PORTS.manager, address, () => {
  console.log(JSON.stringify({ event: 'ready', listen: `${listenName}:${RUNTIME_PORTS.manager}`, slots: [...slots.keys()] }));
});
const stop = () => { server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
