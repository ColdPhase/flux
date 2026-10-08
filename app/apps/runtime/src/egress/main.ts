import { lookup } from 'node:dns/promises';
import { parseRuntimeSwitch, RUNTIME_PORTS } from '@flux/runtime-protocol';
import { allowedHosts, INSTALL_HOSTS } from './policy.js';
import { createMcpForwarder, createProxyServer } from './server.js';

// `runtime-egress`'s main process. Slots reach it on their own networks: the HTTPS proxy (3128) for
// the vendor hosts of the clients the operator enabled, and the MCP forwarder (8080) to the API's
// `/mcp` on `runtime-api`. The installer's proxy (3129, the download host only) listens on the
// `runtime-install` network's address alone, so no slot can download from it.

const env = process.env;
const clients = parseRuntimeSwitch(env.FLUX_AGENT_RUNTIME);
const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const [apiHost, apiPort] = (env.FLUX_RUNTIME_EGRESS_API ?? 'api:8080').split(':');

const hosts = allowedHosts(clients, { includeSignOut: true });
const proxy = createProxyServer({ allow: hosts, log });
proxy.listen(RUNTIME_PORTS.egressProxy, '0.0.0.0');
const mcp = createMcpForwarder({ upstream: { host: apiHost!, port: Number(apiPort ?? 8080) }, log });
mcp.listen(RUNTIME_PORTS.egressMcp, '0.0.0.0');

const installName = env.FLUX_RUNTIME_EGRESS_INSTALL_LISTEN ?? 'runtime-egress-install';
const install = clients.includes('claude_code') ? await lookup(installName, { family: 4 }).catch(() => null) : null;
const installServer = install ? createProxyServer({ allow: new Set(INSTALL_HOSTS), log }) : null;
installServer?.listen(RUNTIME_PORTS.egressInstall, install!.address);
log({ event: 'ready', clients, hosts: [...hosts], signOutAvailable: true, install: installServer ? `${installName}:${RUNTIME_PORTS.egressInstall}` : 'off' });

const stop = () => { proxy.close(); mcp.close(); installServer?.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
