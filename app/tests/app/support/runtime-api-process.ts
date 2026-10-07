// TEST ONLY child: production runtime HTTP/WebSocket routes and Better Auth on a real DB.
// Separate OS processes have independent ticket/console Maps; shared persistence owns authority.
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createDatabase } from '@flux/db';
import { agentRuntimeRoutes } from '../../../apps/server/src/agent-runtime/routes.js';
import { loadIdentityConfig, registerIdentity } from '../../../apps/server/src/identity/index.js';

if (process.env.FLUX_TEST_RUNTIME_CHILD !== 'true' || !process.send) throw new Error('test child only');
const origin=process.env.FLUX_PUBLIC_ORIGIN!, secret=process.env.FLUX_AUTH_SECRET!;
const { db,pool }=createDatabase(process.env.DATABASE_URL!);
const app=Fastify({ logger:false });
const sessions=registerIdentity(app,{ db,config:loadIdentityConfig({ FLUX_PUBLIC_ORIGIN:origin,FLUX_AUTH_SECRET:secret,FLUX_AUTH_RATE_LIMIT:'false' }),mailer:null });
await app.register(websocket,{ options:{ maxPayload:1024 } });
await app.register(agentRuntimeRoutes,{ db,sessions,secret,publicOrigin:origin,config:{ clients:['claude_code'],commercialTermsAgreedOn:null,idleDays:null,
  manager:{ url:process.env.FLUX_TEST_RUNTIME_MANAGER_URL!,secret:process.env.FLUX_TEST_RUNTIME_MANAGER_SECRET! } } });
await app.listen({ host:'127.0.0.1',port:0 });
process.send!({ ready:true,url:`http://127.0.0.1:${(app.server.address() as { port:number }).port}` });
process.on('message',(message:unknown)=>{ if (message==='stop') void app.close().then(()=>pool.end()).then(()=>process.exit(0)); });
