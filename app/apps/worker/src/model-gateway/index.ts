import { lookup } from 'node:dns/promises';
import type { Server } from 'node:http';
import { RUN_TOKEN_LIMITS } from '@flux/contracts';
import { createModelGateway, type AgentRuntimeConfig, type ModelGateway } from '@flux/core';
import type { Database } from '@flux/db';
import { MODEL_GATEWAY_LIMITS, MODEL_GATEWAY_PORTS } from '@flux/runtime-protocol';
import { personalRunWorkerUnitOfWork } from '../personal-runs/adapters.js';
import type { PersonalRunWorkerComposition } from '../personal-runs/composition.js';
import { createModelGatewayServer } from './server.js';

export { createModelGatewayServer, type ModelGatewayServerOptions } from './server.js';

// The model gateway in the worker (#1441): the only process that opens API keys (CA-4) is the one that sends a runtime run's model
// requests. It listens only when the agent runtime is on and API-key runs are on, and only on its address on the internal network
// runtime-egress reaches it over (`FLUX_MODEL_GATEWAY_LISTEN`, default the `worker-gateway` alias of `runtime-api`): no other
// network of the worker, the database's included, hears it.

export interface ModelGatewayHandle {
  /** Issues and closes runs' gateway tokens; null while the gateway is off. */
  gateway: ModelGateway | null;
  stop(): Promise<void>;
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

export async function startModelGateway({ db, composition, runtime, env }: {
  db: Database; composition: PersonalRunWorkerComposition; runtime: AgentRuntimeConfig; env: NodeJS.ProcessEnv;
}): Promise<ModelGatewayHandle> {
  const keys = composition.keys;
  if (!runtime.manager || !keys) return { gateway: null, stop: async () => undefined };
  const gateway = createModelGateway({
    uow: personalRunWorkerUnitOfWork(db), connections: composition.connections, limits: MODEL_GATEWAY_LIMITS,
    tokenLifetimeMs: RUN_TOKEN_LIMITS.lifetimeSeconds * 1000,
  });
  const name = env.FLUX_MODEL_GATEWAY_LISTEN || 'worker-gateway';
  const address = await lookup(name, { family: 4 }).catch(() => null);
  if (!address) {
    log({ event: 'model_gateway', state: 'off', reason: `${name} does not resolve: the worker is not on the runtime's network` });
    return { gateway: null, stop: async () => undefined };
  }
  const server: Server = createModelGatewayServer({ gateway, resolveKey: keys.resolveKey, policy: keys.policy, upstreams: keys.upstreams, log });
  const listening = await new Promise<boolean>((ready) => {
    server.once('error', () => ready(false));
    server.listen(MODEL_GATEWAY_PORTS.worker, address.address, () => ready(true));
  });
  if (!listening) {
    log({ event: 'model_gateway', state: 'off', reason: `cannot listen on ${name}:${MODEL_GATEWAY_PORTS.worker}` });
    return { gateway: null, stop: async () => undefined };
  }
  log({ event: 'model_gateway', state: 'listening', on: `${name}:${MODEL_GATEWAY_PORTS.worker}` });
  return { gateway, stop: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}
