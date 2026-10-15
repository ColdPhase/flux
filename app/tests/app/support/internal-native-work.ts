import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AgentJsonValue,CreateWorkCommand } from '@flux/contracts';
import { DomainError } from '@flux/core';
import { nativeActionExecutor,type ActionInput } from '../../../apps/server/src/agent-connection/action-execution.js';
import { createAuth } from '../../../apps/server/src/identity/auth.js';
import { loadIdentityConfig } from '../../../apps/server/src/identity/config.js';
import { createOauthRequests } from '../../../apps/server/src/identity/oauth-flow.js';
import { db } from './db.js';
import { apiUrl,publicOrigin } from './http.js';
import type { ThreadNativeScene } from './internal-agent-threads.js';

// Resolve the server's already-declared MCP verifier; add no dependency/production export or registration.
const serverRequire=createRequire(new URL('../../../apps/server/package.json',import.meta.url));
const {requireMcpAuth}=await import(serverRequire.resolve('@better-auth/mcp'));
const auth=createAuth({db,config:loadIdentityConfig(),mailer:null,oauthRequests:createOauthRequests()});

/** TEST-ONLY closed existing-native-adapter verification, not a public MCP/CLI thought-source journey. */
export async function internalNativeWork(f:Pick<ThreadNativeScene,'tokens'>,input:ActionInput,task:CreateWorkCommand){
  const verified=requireMcpAuth(auth,async(_request:Request,token:Record<string,unknown>)=>{
    const ownerUserId=token.flux_owner_user_id,connectionId=token.flux_connection_id;
    if(typeof ownerUserId!=='string'||typeof connectionId!=='string'||token.sub!==ownerUserId
      ||typeof token.client_id!=='string'||typeof token.flux_grant_reference!=='string')throw new DomainError(403,'AGENT_EXECUTION_UNAVAILABLE','Actual bearer unavailable');
    const claims={ownerUserId,connectionId,clientId:token.client_id,grantReferenceId:token.flux_grant_reference,
      scopes:typeof token.scope==='string'?token.scope.split(/\s+/).filter(Boolean):[]};
    // Existing executor alone derives native.agent/runtime and checks current authority, quota, receipt and output.
    const value=await nativeActionExecutor(db,claims)(input,'work.create',null,task as unknown as AgentJsonValue,async native=>{
      const saved=await native.work.createWork(native.agent,input.projectId,task);
      return{value:{workId:saved.id,number:saved.number,version:saved.version},postconditions:[{kind:'work' as const,id:saved.id,version:saved.version}]};
    });return Response.json(value);
  },{resource:`${publicOrigin}/mcp`,jwksUrl:`${apiUrl}/api/auth/jwks`});
  const response=await verified(new Request(`${publicOrigin}/mcp`,{method:'POST',headers:{authorization:`Bearer ${f.tokens.access_token}`}}));
  assert.equal(response.status,200,await response.clone().text());return await response.json() as{workId:string;number:number;version:number;replayed:boolean};
}
