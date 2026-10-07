import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createSupervisorServer } from '../../apps/runtime/src/supervisor/server.js';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_PATH, type AgentRuntimeConsoleServerMessage, type AgentRuntimeStatus } from '@flux/contracts';
import { agentRuntimeStore } from '@flux/db';
import { reconcileAgentRuntime } from '@flux/core';
import { callSupervisor, createRuntimeManagerClient, runtimeManagerPort, CONSOLE_UPGRADE_ANSWER, ConsoleFrameReader, encodeControl, parseSupervisorRequest } from '@flux/runtime-protocol';
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


test('API crash with an undelivered old logout requires full recovery; late logout cannot delete the fresh login', { timeout:30_000 },async()=>{
  const slot=await startTestSlot({slot:'runtime-998',enabled:['claude_code']}),managerSecret=slotSecret();
  const target={host:'127.0.0.1',port:portOf(slot.url),secret:slot.config.secret};
  let holdLogout=false,enter!:()=>void,release!:()=>void,lateCode:string|undefined;
  const reached=new Promise<void>(r=>{enter=r;}),held=new Promise<void>(r=>{release=r;});
  const manager=createManagerServer({secret:managerSecret,log:()=>undefined,slots:new Map([[slot.config.slot,target]]),
    call:async(t,request)=>{
      // Existing manager dependency seam: barrier holds a real parsed request, then performs the
      // real closed HTTP call. The target address follows the restarted supervisor as Docker DNS does.
      if(holdLogout&&request.kind==='logout'){holdLogout=false;enter();await held;const answer=await callSupervisor(t,request);lateCode=answer.ok?'ok':answer.code;return answer;}
      return callSupervisor(t,request);
    }});
  await new Promise<void>(r=>manager.listen(0,'127.0.0.1',r));
  const managerUrl=`http://127.0.0.1:${(manager.address()as{port:number}).port}`;
  const config={clients:['claude_code']as const,commercialTermsAgreedOn:null,idleDays:null,manager:{url:managerUrl,secret:managerSecret}};
  const children:ChildProcess[]=[],sockets:WebSocket[]=[];let ownerId:string|undefined,fresh:Server|undefined,pending:Promise<unknown>|undefined;
  try{
    const port=runtimeManagerPort(createRuntimeManagerClient(config.manager)),store=agentRuntimeStore(db);
    await reconcileAgentRuntime({config:{...config,clients:[...config.clients]},store,manager:port});
    const first=await api(managerUrl,managerSecret),second=await api(managerUrl,managerSecret);children.push(first.child,second.child);
    const a=new Browser(first.url,origin),signup=await a.request('POST','/api/auth/sign-up/email',{body:{email:`crashed-auth-${randomUUID()}@example.test`,password:'correct horse battery staple',name:'Crashed auth owner'}});
    assert.equal(signup.status,200);ownerId=(signup.json as{user:{id:string}}).user.id;
    const b=new Browser(second.url,origin);for(const[n,v]of a.cookies)b.cookies.set(n,v);
    const signin=async(browser:Browser)=>{
      const issue=await browser.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(issue.status,200);
      const view=await socket(browser);sockets.push(view.ws);view.ws.send(JSON.stringify({t:'attach',ticket:(issue.json as{ticket:string}).ticket,cols:60,rows:20}));
      await until(()=>view.output.includes('Paste code'));view.ws.send(JSON.stringify({t:'in',d:'fake-code-crash-recovery\r'}));assert.equal(await view.closed,1000);
      const done=view.messages.at(-1);assert.ok(done?.t==='done'&&done.disposition==='accepted'&&done.signedIn);
    };
    await signin(a);
    const old=(await pool.query<{id:string}>('SELECT id FROM agent_runtime_bindings WHERE owner_user_id=$1 AND state=\'active\'',[ownerId])).rows[0].id;
    holdLogout=true;pending=a.request('POST','/api/v1/agent-runtime/sign-out',{body:{client:'claude_code'}}).catch(()=>({ disconnected:true }));
    await Promise.race([reached,delay(5000).then(()=>{throw new Error('logout dispatch barrier deadline');})]);
    const exited=new Promise<void>(r=>first.child.once('exit',()=>r()));first.child.kill('SIGKILL');await exited;
    // Exact actual-DB clock control simulates the lost lease; it grants no same-binding takeover.
    await pool.query(`UPDATE agent_runtime_auth_operations SET claimed_at=clock_timestamp()-interval '2 minutes',
      lease_ends_at=clock_timestamp()-interval '1 minute' WHERE binding_id=$1`,[old]);
    const denied=await b.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(denied.status,409);
    const blocked=(await b.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus;
    assert.equal(blocked.binding?.recovery,true);assert.equal(blocked.connections.claude_code,null);
    await reconcileAgentRuntime({config:{...config,clients:[...config.clients]},store,manager:port});
    assert.equal(slot.released,1,'real supervisor release confirmed full deletion');
    const freshConfig={...slot.config,bootId:randomUUID()};
    fresh=createSupervisorServer(freshConfig,()=>undefined).server;
    await new Promise<void>(r=>fresh!.listen(0,'127.0.0.1',r));target.port=(fresh.address()as{port:number}).port;
    await reconcileAgentRuntime({config:{...config,clients:[...config.clients]},store,manager:port});
    await signin(b);
    const current=(await pool.query<{id:string}>('SELECT id FROM agent_runtime_bindings WHERE owner_user_id=$1 AND state=\'active\'',[ownerId])).rows[0].id;
    assert.notEqual(current,old);assert.notEqual(freshConfig.bootId,slot.config.bootId);
    const file=join(slot.config.dataDir,current,'claude','.credentials.json'),before=await readFile(file,'utf8');
    release();await until(()=>lateCode!==undefined);
    assert.equal(lateCode,'invalid_request','late real HTTP logout meets the new supervisor boot fence before effects');
    assert.equal(await readFile(file,'utf8'),before,'fresh credential survived the obsolete destructive request');
    assert.equal(((await b.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus).connections.claude_code?.state,'signed_in');
  }finally{
    release();await pending?.catch(()=>undefined);for(const ws of sockets)ws.terminate();await Promise.all(children.map(stop));
    manager.closeAllConnections();await new Promise<void>(r=>manager.close(()=>r()));
    if(fresh){fresh.closeAllConnections();await new Promise<void>(r=>fresh!.close(()=>r()));}await slot.close();
    if(ownerId)await pool.query('DELETE FROM auth_users WHERE id=$1',[ownerId]);await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1',[slot.config.slot]);
  }
});


test('well-shaped console result for another status client is refused without persistence; current-client control succeeds', {timeout:25_000},async()=>{
  // Fault injection at the actual closed manager/API stream. No vendor CLI/account is represented.
  let statusClient:'claude_code'|'codex'='codex';
  const rogue=createServer();
  rogue.on('upgrade',(_request,socket,head)=>{
    socket.on('error',()=>socket.destroy());socket.write(CONSOLE_UPGRADE_ANSWER);
    const reader=new ConsoleFrameReader('to_supervisor');
    const frames=(chunk:Buffer)=>{
      for(const frame of reader.push(chunk))if(frame.type==='open'){
        const parsed=parseSupervisorRequest('login',frame.body);assert.ok(parsed.ok&&parsed.request.kind==='login');
        socket.write(encodeControl({t:'accepted',kind:'login',bootId:parsed.request.bootId}));
        socket.end(encodeControl({t:'result',result:{kind:'login',client:'claude_code',ended:'exited',exitCode:0,
          status:{client:statusClient,signedIn:true,facts:{authMethod:'claude.ai',plan:'max',accountLabel:'a***@example.org',accountDigest:null},credentialFile:'ok',bindingBytes:0,bindingOverLimit:false}}}));
      }
    };
    socket.on('data',frames);if(head.length)frames(head);
  });
  await new Promise<void>(r=>rogue.listen(0,'127.0.0.1',r));
  const managerSecret=slotSecret(),target={host:'127.0.0.1',port:(rogue.address()as{port:number}).port,secret:slotSecret()};
  const names=['runtime-997','runtime-998'],manager=createManagerServer({secret:managerSecret,log:()=>undefined,slots:new Map(names.map(name=>[name,target]))});
  await new Promise<void>(r=>manager.listen(0,'127.0.0.1',r));
  let child:ChildProcess|undefined;
  const owners:string[]=[],sockets:WebSocket[]=[];
  try{
    const fixture=await api(`http://127.0.0.1:${(manager.address()as{port:number}).port}`,managerSecret);child=fixture.child;
    for(const [index,client]of(['codex','claude_code']as const).entries()){
      statusClient=client;const browser=new Browser(fixture.url,origin);
      const signup=await browser.request('POST','/api/auth/sign-up/email',{body:{email:`client-frame-${randomUUID()}@example.test`,password:'correct horse battery staple',name:'Client frame owner'}});
      assert.equal(signup.status,200);const owner=(signup.json as{user:{id:string}}).user.id;owners.push(owner);
      const binding=randomUUID(),bootId=randomUUID();
      await pool.query(`INSERT INTO agent_runtime_slots(slot,state,boot_id) VALUES($1,'held',$2)`,[names[index],bootId]);
      await pool.query(`INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state) VALUES($1,$2,$3,'active')`,[binding,owner,names[index]]);
      const issue=await browser.request('POST',AGENT_RUNTIME_CONSOLE_PATH,{body:{client:'claude_code',method:'sso'}});assert.equal(issue.status,200);
      const view=await socket(browser);sockets.push(view.ws);view.ws.send(JSON.stringify({t:'attach',ticket:(issue.json as{ticket:string}).ticket,cols:60,rows:20}));
      assert.equal(await view.closed,index===0?4503:1000);
      if(index===0){
        assert.deepEqual(view.messages.filter(message=>message.t==='error'),[{t:'error',code:'unavailable'}]);
        assert.equal(view.messages.filter(message=>message.t==='done').length,0);
        await until(async()=>((await browser.request('GET',AGENT_RUNTIME_PATH)).json as AgentRuntimeStatus).binding?.recovery===true);
        assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runtime_connections WHERE binding_id=$1',[binding])).rows[0].n,0);
      }else{
        const done=view.messages.at(-1);assert.ok(done?.t==='done'&&done.disposition==='accepted'&&done.signedIn);
        assert.equal((await pool.query('SELECT state FROM agent_runtime_connections WHERE binding_id=$1',[binding])).rows[0].state,'signed_in');
      }
    }
  }finally{
    for(const ws of sockets)ws.terminate();if(child)await stop(child);manager.closeAllConnections();rogue.closeAllConnections();
    await Promise.all([new Promise<void>(r=>manager.close(()=>r())),new Promise<void>(r=>rogue.close(()=>r()))]);
    for(const owner of owners)await pool.query('DELETE FROM auth_users WHERE id=$1',[owner]);await pool.query('DELETE FROM agent_runtime_slots WHERE slot=ANY($1)',[names]);
  }
});
