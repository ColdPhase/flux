import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_PATH, type AgentRuntimeConsoleServerMessage, type AgentRuntimeStatus } from '@flux/contracts';
import { agentRuntimeStore } from '@flux/db';
import { reconcileAgentRuntime } from '@flux/core';
import { createRuntimeManagerClient, runtimeManagerPort } from '@flux/runtime-protocol';
import WebSocket from 'ws';
import { Browser } from './support/http.js';
import { pool,db,connectionString } from './support/db.js';
import { startTestSlot, portOf, slotSecret } from './support/runtime-slot.js';

const origin='http://127.0.0.1:18279',secret='isolated-runtime-two-api-test-'+ 'x'.repeat(40);
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(check:()=>boolean|Promise<boolean>,ms=5000) {
  const end=Date.now()+ms;
  while (!await check()) { if(Date.now()>end) throw new Error('bounded runtime condition not reached'); await delay(20); }
}
async function api(managerUrl:string,managerSecret:string) {
  const child=fork(resolve('tests/app/support/runtime-api-process.ts'),[],{ execArgv:['--import','tsx'],silent:true,
    env:{ ...process.env,FLUX_TEST_RUNTIME_CHILD:'true',DATABASE_URL:connectionString,FLUX_PUBLIC_ORIGIN:origin,FLUX_AUTH_SECRET:secret,
      FLUX_TEST_RUNTIME_MANAGER_URL:managerUrl,FLUX_TEST_RUNTIME_MANAGER_SECRET:managerSecret } });
  // No cookie, credential or PTY bytes are emitted by the harness.
  child.stdout?.resume(); child.stderr?.resume();
  const url=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{ child.kill('SIGKILL'); reject(new Error('runtime API child startup deadline')); },10_000);
    child.once('message',(message:unknown)=>{ clearTimeout(timer); const m=message as { ready?:boolean;url?:string }; if(m.ready&&m.url)resolve(m.url);else reject(new Error('child not ready')); });
    child.once('exit',()=>{ clearTimeout(timer);reject(new Error('runtime API child exited before ready')); });
  });
  return { child,url };
}
async function stop(child:ChildProcess) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise<void>(r=>child.once('exit',()=>r())); child.send('stop');
  const kill=setTimeout(()=>child.kill('SIGKILL'),3000); try{await exited;}finally{clearTimeout(kill);}
}
async function socket(browser:Browser) {
  const ws=new WebSocket(browser.base.replace('http','ws')+AGENT_RUNTIME_CONSOLE_PATH,{ headers:{ origin,cookie:browser.cookieHeader() } });
  const messages:AgentRuntimeConsoleServerMessage[]=[]; let output='';
  const closed=new Promise<number>(r=>ws.once('close',code=>r(code)));
  ws.on('message',(bytes,binary)=>{ if(binary)output+=bytes.toString();else messages.push(JSON.parse(bytes.toString()) as AgentRuntimeConsoleServerMessage); });
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return { ws,messages,closed,get output(){return output;} };
}

test('two actual API processes share one-use tickets and operation ownership across restart and real PTY disconnect', { timeout:40_000 },async()=>{
  const slot=await startTestSlot({ slot:'runtime-998',enabled:['claude_code'] }),managerSecret=slotSecret();
  const manager=createManagerServer({ secret:managerSecret,log:()=>undefined,slots:new Map([[slot.config.slot,{ host:'127.0.0.1',port:portOf(slot.url),secret:slot.config.secret }]]) });
  await new Promise<void>(r=>manager.listen(0,'127.0.0.1',r));
  const managerUrl=`http://127.0.0.1:${(manager.address() as {port:number}).port}`;
  const children:ChildProcess[]=[], sockets:WebSocket[]=[];let ownerId:string|undefined;
  try {
    const config={ clients:['claude_code'] as const,commercialTermsAgreedOn:null,idleDays:null,manager:{url:managerUrl,secret:managerSecret} };
    await reconcileAgentRuntime({ config:{...config,clients:[...config.clients]},store:agentRuntimeStore(db),manager:runtimeManagerPort(createRuntimeManagerClient(config.manager)) });
    const first=await api(managerUrl,managerSecret),second=await api(managerUrl,managerSecret);children.push(first.child,second.child);
    const a=new Browser(first.url,origin),email=`two-api-${randomUUID()}@example.test`;
    const signup=await a.request('POST','/api/auth/sign-up/email',{body:{email,password:'correct horse battery staple',name:'Two API owner'}});
    assert.equal(signup.status,200);ownerId=(signup.json as {user:{id:string}}).user.id;
    const b=new Browser(second.url,origin);for(const [name,value]of a.cookies)b.cookies.set(name,value);
    const response=await a.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(response.status,200);
    const ticket=(response.json as {ticket:string}).ticket;
    const [left,right]=await Promise.all([socket(a),socket(b)]);sockets.push(left.ws,right.ws);
    for(const view of[left,right])view.ws.send(JSON.stringify({t:'attach',ticket,cols:60,rows:20}));
    await until(()=>left.output.includes('Paste code')||right.output.includes('Paste code'));
    const winner=left.output.includes('Paste code')?left:right,loser=winner===left?right:left;
    assert.equal(await loser.closed,4403,'shared nonce admits exactly one API');
    winner.ws.send(JSON.stringify({t:'in',d:'fake-code-process-control\r'}));assert.equal(await winner.closed,1000);
    const done=winner.messages.at(-1);assert.ok(done?.t==='done');assert.equal(done.disposition,'accepted');assert.equal(done.signedIn,true);
    await stop(first.child);
    const restarted=await api(managerUrl,managerSecret);children.push(restarted.child);
    const c=new Browser(restarted.url,origin);for(const[n,v]of b.cookies)c.cookies.set(n,v);
    const replay=await socket(c);sockets.push(replay.ws);replay.ws.send(JSON.stringify({t:'attach',ticket,cols:60,rows:20}));
    assert.equal(await replay.closed,4403,'consumed nonce survives API restart');
    const current=await pool.query<{id:string}>('SELECT id FROM agent_runtime_bindings WHERE owner_user_id=$1 AND state=\'active\'',[ownerId]);
    const home=join(slot.config.dataDir,current.rows[0].id,'claude');
    await writeFile(join(home,'fake-scenario'),'login_hangs',{mode:0o600});
    const issue=await c.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(issue.status,200);
    const held=await socket(c);sockets.push(held.ws);held.ws.send(JSON.stringify({t:'attach',ticket:(issue.json as {ticket:string}).ticket,cols:60,rows:20}));
    await until(()=>held.output.includes('Paste code'));
    const calls=(await readFile(join(home,'fake-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)as{pid:number;argv:string[]});
    const pid=calls.at(-1)!.pid;assert.ok(calls.at(-1)!.argv.includes('login'));
    const competitor=await b.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'console'}});assert.equal(competitor.status,200);
    const busy=await socket(b);sockets.push(busy.ws);busy.ws.send(JSON.stringify({t:'attach',ticket:(competitor.json as {ticket:string}).ticket,cols:60,rows:20}));
    assert.equal(await busy.closed,4403);assert.deepEqual(busy.messages,[{t:'error',code:'busy'}]);
    held.ws.close(1000);
    await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},5000);
    await until(async()=>((await b.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus).binding?.recovery===true);
    const view=(await b.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus;
    assert.equal(view.binding?.state,'releasing');assert.equal(view.connections.claude_code,null);
    assert.equal((await b.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}})).status,409,'disconnect never grants same-binding replacement');
  } finally {
    for(const ws of sockets)ws.terminate();await Promise.all(children.map(stop));manager.closeAllConnections();await new Promise<void>(r=>manager.close(()=>r()));
    await slot.close();if(ownerId)await pool.query('DELETE FROM auth_users WHERE id=$1',[ownerId]);await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1',[slot.config.slot]);
  }
});

test('a held real manager response arriving after a second HTTP process requests sign-out is explicitly superseded', { timeout:30_000 },async()=>{
  const slot=await startTestSlot({ slot:'runtime-998',enabled:['claude_code'] }),managerSecret=slotSecret();
  const manager=createManagerServer({ secret:managerSecret,log:()=>undefined,slots:new Map([[slot.config.slot,{ host:'127.0.0.1',port:portOf(slot.url),secret:slot.config.secret }]]) });
  // Controlled network barrier around the actual manager result, after real CLI status finished.
  // No fake DB result/clock and no product test hook. Admission tx must already be released.
  let holdNext=false,release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;});
  const reached=new Promise<void>(r=>{entered=r;});
  const handlers=manager.listeners('request');manager.removeAllListeners('request');
  manager.on('request',(request,response)=>{
    if(holdNext&&request.url?.endsWith('/status')) {
      holdNext=false;const end=response.end;
      response.end=((...args:unknown[])=>{entered();void held.then(()=>Reflect.apply(end,response,args));return response;})as typeof response.end;
    }
    for(const handler of handlers)Reflect.apply(handler,manager,[request,response]);
  });
  await new Promise<void>(r=>manager.listen(0,'127.0.0.1',r));
  const managerUrl=`http://127.0.0.1:${(manager.address()as{port:number}).port}`;
  const children:ChildProcess[]=[],sockets:WebSocket[]=[];let ownerId:string|undefined,pending:Promise<unknown>|undefined;
  try {
    const config={clients:['claude_code']as const,commercialTermsAgreedOn:null,idleDays:null,manager:{url:managerUrl,secret:managerSecret}};
    await reconcileAgentRuntime({config:{...config,clients:[...config.clients]},store:agentRuntimeStore(db),manager:runtimeManagerPort(createRuntimeManagerClient(config.manager))});
    const first=await api(managerUrl,managerSecret),second=await api(managerUrl,managerSecret);children.push(first.child,second.child);
    const a=new Browser(first.url,origin),signup=await a.request('POST','/api/auth/sign-up/email',{body:{email:`held-http-${randomUUID()}@example.test`,password:'correct horse battery staple',name:'Held status owner'}});
    assert.equal(signup.status,200);ownerId=(signup.json as{user:{id:string}}).user.id;
    const b=new Browser(second.url,origin);for(const[n,v]of a.cookies)b.cookies.set(n,v);
    const issue=await a.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(issue.status,200);
    const login=await socket(a);sockets.push(login.ws);login.ws.send(JSON.stringify({t:'attach',ticket:(issue.json as{ticket:string}).ticket,cols:60,rows:20}));
    await until(()=>login.output.includes('Paste code'));login.ws.send(JSON.stringify({t:'in',d:'fake-code-held-http\r'}));assert.equal(await login.closed,1000);
    holdNext=true;
    const checking=a.request('POST','/api/v1/agent-runtime/check',{body:{client:'claude_code'}});pending=checking;
    await Promise.race([reached,delay(5000).then(()=>{throw new Error('manager response barrier deadline');})]);
    const tx=await pool.query<{n:number}>(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`);
    assert.equal(tx.rows[0].n,0,'held external response occupies no database transaction');
    assert.equal(((await b.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus).auth?.claude_code,'checking');
    const out=await b.request('POST','/api/v1/agent-runtime/sign-out',{body:{client:'claude_code'}});
    assert.equal(out.status,409);assert.equal((out.json as{code:string}).code,'AGENT_RUNTIME_AUTH_RECOVERY');
    release();const completed=await checking;assert.equal(completed.status,200);
    const status=completed.json as AgentRuntimeStatus;
    assert.deepEqual(status.authCompletion,{kind:'check',disposition:'superseded'});
    assert.equal(status.binding?.recovery,true);assert.equal(status.connections.claude_code,null);
    const rows=await pool.query<{state:string;signed_in_at:Date|null;sign_out_failed:boolean|null;revoked_at:Date|null}>('SELECT state,signed_in_at,sign_out_failed,revoked_at FROM agent_runtime_connections WHERE owner_user_id=$1',[ownerId]);
    assert.equal(rows.rows[0].state,'signed_out');assert.equal(rows.rows[0].signed_in_at,null);assert.equal(rows.rows[0].sign_out_failed,null);assert.ok(rows.rows[0].revoked_at);
  }finally{
    release();await pending?.catch(()=>undefined);for(const ws of sockets)ws.terminate();await Promise.all(children.map(stop));
    manager.closeAllConnections();await new Promise<void>(r=>manager.close(()=>r()));await slot.close();
    if(ownerId)await pool.query('DELETE FROM auth_users WHERE id=$1',[ownerId]);await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1',[slot.config.slot]);
  }
});
