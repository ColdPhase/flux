import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '@flux/core';
import { internalAgentThreadWriter } from '../../../apps/server/src/agent-connection/internal-agent-thread.js';
import { createAuth } from '../../../apps/server/src/identity/auth.js';
import { loadIdentityConfig } from '../../../apps/server/src/identity/config.js';
import { createOauthRequests } from '../../../apps/server/src/identity/oauth-flow.js';
import { apiUrl,publicOrigin } from './http.js';
import { db,pool } from './db.js';
import { actionScene } from './mcp-actions.js';

export type ThreadNativeScene=Awaited<ReturnType<typeof actionScene>>;
const authByDatabase=new WeakMap<Database,ReturnType<typeof createAuth>>();
export const threadCommand=(f:Pick<ThreadNativeScene,'projectId'|'runtimeSessionId'>,taskId:string,grantId:string)=>({
  projectId:f.projectId,taskId,runtimeSessionId:f.runtimeSessionId,grantId,clientCommandId:randomUUID(),
  peerRequestClass:'execute' as const,sources:[],message:{body:'One meaningful measured observation.'},
});
export async function nativeThreadPost(f:Pick<ThreadNativeScene,'tokens'>,command:ReturnType<typeof threadCommand>,database:Database=db){
  let auth=authByDatabase.get(database);if(!auth){auth=createAuth({db:database,config:loadIdentityConfig(),mailer:null,oauthRequests:createOauthRequests()});authByDatabase.set(database,auth);}
  const response=await internalAgentThreadWriter(database,auth,publicOrigin,`${apiUrl}/api/auth/jwks`)(new Request(`${publicOrigin}/mcp`,{
    method:'POST',headers:{authorization:`Bearer ${f.tokens.access_token}`,'content-type':'application/json'},body:JSON.stringify(command),
  }));
  assert.equal(response.status,200,await response.clone().text());return await response.json() as{taskId:string;conversationId:string;messageId:string;replayed:boolean};
}
export const turnLimit=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='AGENT_THREAD_TURN_LIMIT';
export async function threadBudget(taskId:string){return(await pool.query(`SELECT COALESCE((SELECT turn_count FROM(
  SELECT sequence,turn_count FROM agent_thread_guard_events WHERE task_id=$1
  UNION ALL SELECT sequence,0 FROM agent_thread_artifact_resets WHERE task_id=$1 AND sequence IS NOT NULL
  )b ORDER BY sequence DESC LIMIT 1),0) AS turns`,[taskId])).rows[0].turns as number;}
export async function fillThread(f:ThreadNativeScene,taskId:string,grantId:string){for(let i=0;i<5;i++)await nativeThreadPost(f,threadCommand(f,taskId,grantId));
  assert.equal(await threadBudget(taskId),5);await assert.rejects(nativeThreadPost(f,threadCommand(f,taskId,grantId)),turnLimit);}
