import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir,open,rename,unlink } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import WebSocket,{type RawData} from 'ws';
import * as Y from 'yjs';
import { createDatabase } from '@flux/db';
import { EDITING_LIMITS,type Doc,type LiveDocBootstrap,type LiveMapBootstrap,type LiveReceipt,type SaveSharedDoc,type Thought,type UndoneLiveMap,type WikiTextEnvelope } from '@flux/contracts';
import { Browser,type ClientResponse } from '../support/http.js';

/** Public-client prepare→root actual force-recreate→verify. No auth/policy/SQL write/transport port is injected.
 * The only interposition is pausing the real client's receive side before its new immutable update.
 * A real committed receipt is observed through read-only SQL while that client has observed no ACK.
 * Root must recreate BOTH actual API containers before verify, then make fresh measurement inventory.
 * This is restart/replay evidence; it does not claim an unclean crash or full browser latency. */
interface Inventory {schema:1;sourceSha:string;apis:{apiInstance:string;apiUrl:string;containerId:string;imageId:string}[]}
interface State {schema:1;sourceSha:string;preparedAt:number;before:Inventory;actorId:string;cookies:[string,string][];workspaceId:string;
  wiki:{id:string;generation:string;body:string;savedBody:string;envelope:WikiTextEnvelope;bytes:string;bytesHash:string;receipt:LiveReceipt};
  map:{id:string;generation:string;sequence:number;thoughtId:string;version:number;commandId:string;command:{moves:{id:string;x:number;y:number;expectedVersion:number}[]};original:{x:number;y:number}};
  events:number;ackObserved:false}
const finite=5000,privateLimit=65_536;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const source=process.env.FLUX_LIVE_SOURCE_SHA;
assert.equal(process.env.FLUX_LIVE_RESTART_TEST,'1','Root must explicitly select its isolated restart fixture');assert.ok(source&&/^[0-9a-f]{40}$/.test(source));
const origin=process.env.FLUX_PUBLIC_ORIGIN;assert.ok(origin);assert.equal(new URL(origin).origin,origin);
const phase=process.argv[2];assert.ok(phase==='prepare'||phase==='verify','Usage: live/restart.ts prepare|verify');
const directory=process.env.FLUX_LIVE_RESTART_STATE_DIR??'/state';const stateFile=join(directory,'live-editing-restart.private.json');
const databaseUrl=process.env.DATABASE_URL;assert.ok(databaseUrl);const database=createDatabase(databaseUrl);
const clients:Client[]=[];const documents:Y.Doc[]=[];
const deadline=setTimeout(()=>{process.stderr.write('Live restart fixture exceeded its finite30s phase\n');process.exit(1);},30_000);
function status(response:ClientResponse,expected:number){assert.equal(response.status,expected,response.text);return response.json;}
function browser(base:string,cookies:[string,string][]=[]){const b=new Browser(base,origin);for(const [name,value] of cookies)b.cookies.set(name,value);const request=b.request.bind(b);
  b.request=(method,path,options={})=>request(method,path,{...options,headers:{host:new URL(origin!).host,...options.headers}});return b;}
async function regular(path:string,limit:number){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=await file.stat();assert.ok(before.isFile()&&before.size<=limit);const buffer=Buffer.alloc(limit+1);let length=0;while(length<buffer.length){const next=await file.read(buffer,length,buffer.length-length,null);if(!next.bytesRead)break;length+=next.bytesRead;}assert.ok(length<=limit);const after=await file.stat();assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(length,after.size);return buffer.subarray(0,length);}finally{await file.close();}}
async function inventory(){const path=process.env.FLUX_LIVE_RESTART_INVENTORY;assert.ok(path,'Actual before/after restart process inventory required');const value=JSON.parse((await regular(path,16384)).toString()) as Inventory;
  assert.equal(value.schema,1);assert.equal(value.sourceSha,source);assert.equal(value.apis.length,2);
  for(const api of value.apis){assert.match(api.apiInstance,/^[A-Za-z0-9_.-]{1,64}$/);assert.match(api.containerId,/^[0-9a-f]{64}$/);assert.match(api.imageId,/^sha256:[0-9a-f]{64}$/);assert.match(api.apiUrl,/^http:\/\//);}
  assert.notEqual(value.apis[0]!.containerId,value.apis[1]!.containerId);assert.equal(value.apis[0]!.imageId,value.apis[1]!.imageId);return value;}
async function writeState(value:State){await mkdir(directory,{recursive:true});const raw=Buffer.from(JSON.stringify(value));assert.ok(raw.length<=privateLimit);const temporary=join(dirname(stateFile),`.live-restart-${randomUUID()}.tmp`);
  const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(raw);await file.sync();}finally{await file.close();}try{await rename(temporary,stateFile);}finally{await unlink(temporary).catch(()=>{});}}
async function poll<T>(read:()=>Promise<T|undefined>){const until=Date.now()+finite;while(Date.now()<until){const result=await read();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Actual durable condition exceeded finite fixture deadline');}
class Client {
  readonly packets:{header:Record<string,unknown>;bytes?:Buffer}[]=[];
  private pending=new Map<string,{header:Record<string,unknown>;parts:Buffer[];bytes:number}>();private error:Error|null=null;
  constructor(readonly socket:WebSocket){socket.on('error',error=>{this.error=error;});socket.on('message',(raw:RawData,binary)=>{try{
    assert.ok(Buffer.isBuffer(raw)&&raw.byteLength<=EDITING_LIMITS.frameBytes);
    if(!binary){this.keep({header:JSON.parse(raw.toString()) as Record<string,unknown>});return;}
    const length=raw.readUInt32BE(0);assert.ok(length>0&&length+4<=raw.length);const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(4,4+length))) as Record<string,unknown>;
    assert.equal(typeof header.deliveryId,'string');assert.match(String(header.deliveryId),uuid);const id=String(header.deliveryId),index=Number(header.index),count=Number(header.count);
    assert.ok(Number.isInteger(index)&&Number.isInteger(count)&&count>0&&count<=EDITING_LIMITS.chunks&&index>=0&&index<count);
    const bytes=Buffer.from(raw.subarray(4+length));assert.ok(bytes.length<=EDITING_LIMITS.chunkBytes);let assembly=this.pending.get(id);
    if(!assembly){assert.equal(index,0);assert.ok(this.pending.size<2);assembly={header,parts:[],bytes:0};this.pending.set(id,assembly);}
    assert.equal(index,assembly.parts.length);for(const key of ['type','generation','sequence','commandId','hash','count'])assert.equal(header[key],assembly.header[key]);
    assembly.parts.push(bytes);assembly.bytes+=bytes.length;assert.ok(assembly.bytes<=EDITING_LIMITS.assemblyBytes);this.send({type:'received',deliveryId:id,index});
    if(assembly.parts.length===count){this.pending.delete(id);this.keep({header:assembly.header,bytes:Buffer.concat(assembly.parts)});}
  }catch(error){this.error=error instanceof Error?error:new Error(String(error));socket.terminate();}});}
  keep(packet:{header:Record<string,unknown>;bytes?:Buffer}){assert.ok(this.packets.length<2048);this.packets.push(packet);}
  send(value:unknown){this.socket.send(JSON.stringify(value));}
  async wait(predicate:(header:Record<string,unknown>)=>boolean){return poll(async()=>{if(this.error)throw this.error;const found=this.packets.find(p=>predicate(p.header));if(found)return found;assert.equal(this.socket.readyState,WebSocket.OPEN,'Real socket closed before required delivery');return undefined;});}
  update(envelope:WikiTextEnvelope,bytes:Uint8Array){assert.ok(bytes.length>0&&bytes.length<=privateLimit);const count=Math.ceil(bytes.length/EDITING_LIMITS.chunkBytes);
    for(let index=0;index<count;index++){const header=Buffer.from(JSON.stringify({...envelope,index,count}));const part=bytes.subarray(index*EDITING_LIMITS.chunkBytes,(index+1)*EDITING_LIMITS.chunkBytes);const frame=Buffer.alloc(4+header.length+part.length);frame.writeUInt32BE(header.length);header.copy(frame,4);frame.set(part,4+header.length);assert.ok(frame.length<=EDITING_LIMITS.frameBytes);this.socket.send(frame);}}
  close(){this.socket.terminate();this.pending.clear();}
  static async open(base:string,b:Browser,kind:'wiki'|'map',id:string){const url=new URL(`/api/v1/editing?kind=${kind}&id=${id}`,base);url.protocol='ws:';const socket=new WebSocket(url,{headers:{origin,host:new URL(origin!).host,cookie:b.cookieHeader()},perMessageDeflate:false,maxPayload:EDITING_LIMITS.frameBytes});const c=new Client(socket);clients.push(c);
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Restart fixture real socket did not open')),finite);socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);reject(error);});});return c;}
}
try {
  const current=await inventory();const base=current.apis[0]!.apiUrl;
  if(phase==='prepare'){
    const b=browser(base);status(await b.request('POST','/api/auth/sign-up/email',{body:{email:`live-restart-${randomUUID()}@example.test`,name:'Restart receipt owner',password:'original sealed bytes survive restart'}}),200);
    const actorId=(status(await b.request('GET','/api/v1/me'),200) as {user:{id:string}}).user.id;
    const ws=status(await b.request('POST','/api/v1/workspaces',{body:{name:'Actual live restart'}}),201) as {id:string};
    const project=status(await b.request('POST',`/api/v1/workspaces/${ws.id}/projects`,{body:{name:'Persistent live rooms',visibility:'restricted'}}),201) as {id:string};
    const saved=status(await b.request('POST',`/api/v1/projects/${project.id}/docs`,{body:{title:'Original pending text',body:'Saved before restart. ',state:'published'}}),201) as Doc;
    const head=status(await b.request('GET',`/api/v1/docs/${saved.id}/live`),200) as LiveDocBootstrap;
    const local=new Y.Doc();documents.push(local);status(await b.request('POST',`/api/v1/docs/${saved.id}/live/enroll`,{body:{generation:head.generation,replicaId:local.clientID}}),200);
    Y.applyUpdate(local,Buffer.from(head.checkpoint,'base64'));const before=Y.encodeStateVector(local);local.getText('body').insert(head.body.length,'Still pending locally 🚀. ');const bytes=Y.encodeStateAsUpdate(local,before);
    const envelope:WikiTextEnvelope={workspace:head.workspaceId,kind:'wiki',room:saved.id,generation:head.generation,actor:actorId,operation:'text',uuid:randomUUID(),replica:local.clientID,parameters:null};
    const wiki=await Client.open(base,b,'wiki',saved.id);wiki.send({type:'subscribe',generation:head.generation,afterSequence:head.sequence});await wiki.wait(h=>h.type==='head');
    wiki.socket.pause();assert.equal(wiki.socket.isPaused,true);wiki.update(envelope,bytes);
    const receipt=await poll(async()=>{const row=(await database.pool.query('SELECT receipt FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2',[actorId,envelope.uuid])).rows[0];return row?.receipt as LiveReceipt|undefined;});
    assert.equal(receipt.sequence,1);assert.equal(receipt.changed,true);assert.equal(wiki.packets.some(p=>p.header.type==='ack'&&p.header.commandId===envelope.uuid),false,'Paused real client has not observed the durable ACK');
    const sketch=status(await b.request('POST',`/api/v1/workspaces/${ws.id}/sketches`,{body:{title:'Persistent native move and undo',scope:'project',projectId:project.id}}),201) as {id:string};
    const thought=(status(await b.request('POST',`/api/v1/sketches/${sketch.id}/thoughts`,{body:{text:'Restarted thought',x:20,y:40},headers:{'idempotency-key':randomUUID()}}),201) as {thought:Thought}).thought;
    const initial=status(await b.request('GET',`/api/v1/sketches/${sketch.id}/live`),200) as LiveMapBootstrap;const commandId=randomUUID();const command={moves:[{id:thought.id,x:311,y:222,expectedVersion:thought.version}]};
    status(await b.request('PATCH',`/api/v1/sketches/${sketch.id}/positions`,{body:command,headers:{'idempotency-key':commandId}}),200);
    const moved=status(await b.request('GET',`/api/v1/sketches/${sketch.id}/live`),200) as LiveMapBootstrap;assert.equal(moved.sequence,initial.sequence+1);assert.equal(moved.sketch.thoughts[0]?.version,thought.version+1);
    await writeState({schema:1,sourceSha:source!,preparedAt:Date.now(),before:current,actorId,cookies:[...b.cookies],workspaceId:ws.id,
      wiki:{id:saved.id,generation:head.generation,body:local.getText('body').toString(),savedBody:saved.body,envelope,bytes:Buffer.from(bytes).toString('base64'),bytesHash:createHash('sha256').update(bytes).digest('hex'),receipt},
      map:{id:sketch.id,generation:moved.generation,sequence:moved.sequence,thoughtId:thought.id,version:thought.version+1,commandId,command,original:{x:thought.x,y:thought.y}},
      events:Number((await database.pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1',[ws.id])).rows[0].n),ackObserved:false});
    console.log('live-restart prepare: real committed unobserved ACK and native move stored in private fixture state; root must force-recreate both API processes');
  }else {
    const state=JSON.parse((await regular(stateFile,privateLimit)).toString()) as State;assert.equal(state.schema,1);assert.equal(state.sourceSha,source);assert.equal(state.ackObserved,false);assert.ok(Date.now()-state.preparedAt>=0&&Date.now()-state.preparedAt<=120_000);
    assert.equal(state.before.apis.length,2);for(const old of state.before.apis){const fresh=current.apis.find(api=>api.apiInstance===old.apiInstance);assert.ok(fresh);assert.notEqual(fresh.containerId,old.containerId,'Root must recreate both actual processes');assert.equal(fresh.imageId,old.imageId,'Restart reuses the exact candidate image');assert.equal(fresh.apiUrl,old.apiUrl);}
    const b=browser(base,state.cookies);assert.equal((status(await b.request('GET','/api/v1/me'),200) as {user:{id:string}}).user.id,state.actorId);
    const head=status(await b.request('GET',`/api/v1/docs/${state.wiki.id}/live`),200) as LiveDocBootstrap;assert.equal(head.generation,state.wiki.generation);assert.equal(head.sequence,1);assert.equal(head.body,state.wiki.body);
    assert.deepEqual(status(await b.request('GET',`/api/v1/docs/${state.wiki.id}/live/receipts/${state.wiki.envelope.uuid}`),200),state.wiki.receipt);
    const bytes=Buffer.from(state.wiki.bytes,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),state.wiki.bytesHash);
    const reloaded=new Y.Doc();documents.push(reloaded);status(await b.request('POST',`/api/v1/docs/${state.wiki.id}/live/enroll`,{body:{generation:head.generation,replicaId:reloaded.clientID}}),200);Y.applyUpdate(reloaded,Buffer.from(head.checkpoint,'base64'));
    const wiki=await Client.open(base,b,'wiki',state.wiki.id);wiki.send({type:'subscribe',generation:head.generation,afterSequence:head.sequence});await wiki.wait(h=>h.type==='head');wiki.update(state.wiki.envelope,bytes);
    const ack=await wiki.wait(h=>h.type==='ack'&&h.commandId===state.wiki.envelope.uuid);const {type,...receipt}=ack.header;assert.equal(type,'ack');assert.deepEqual(receipt,state.wiki.receipt,'Fresh Doc recovery replays original old-replica bytes and immutable UUID');
    assert.equal(Number((await database.pool.query('SELECT count(*)::int n FROM doc_live_updates WHERE doc_id=$1',[state.wiki.id])).rows[0].n),1);
    assert.equal(Number((await database.pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1',[state.workspaceId])).rows[0].n),state.events);
    assert.equal((status(await b.request('GET',`/api/v1/docs/${state.wiki.id}`),200) as Doc).body,state.wiki.savedBody);
    const save:SaveSharedDoc={clientCommandId:randomUUID(),expectedVersion:1,generation:head.generation,headSequence:head.sequence,headHash:head.hash,reason:'Explicit Save after real API recreation'};
    const saved=status(await b.request('POST',`/api/v1/docs/${state.wiki.id}/live/save`,{body:save}),200) as LiveReceipt;assert.equal(saved.savedDoc?.body,state.wiki.body);assert.equal(saved.savedDoc?.version,2);
    assert.equal((status(await b.request('GET',`/api/v1/docs/${state.wiki.id}/versions/1`),200) as Doc).body,state.wiki.savedBody);assert.deepEqual(status(await b.request('POST',`/api/v1/docs/${state.wiki.id}/live/save`,{body:save}),200),saved);
    const map=status(await b.request('GET',`/api/v1/sketches/${state.map.id}/live`),200) as LiveMapBootstrap;assert.equal(map.generation,state.map.generation);assert.equal(map.sequence,state.map.sequence);assert.equal(map.sketch.thoughts[0]?.version,state.map.version);
    const undo={clientCommandId:randomUUID(),originalCommandIds:[state.map.commandId]};const undone=status(await b.request('POST',`/api/v1/sketches/${state.map.id}/live/undo`,{body:undo}),200) as UndoneLiveMap;
    assert.equal(undone.delta.sequence,state.map.sequence+1);assert.equal(undone.delta.thoughts[0]?.version,state.map.version+1);assert.equal(undone.delta.thoughts[0]?.x,state.map.original.x);assert.equal(undone.delta.thoughts[0]?.y,state.map.original.y);
    assert.deepEqual(status(await b.request('POST',`/api/v1/sketches/${state.map.id}/live/undo`,{body:undo}),200),undone);
    status(await b.request('PATCH',`/api/v1/sketches/${state.map.id}/positions`,{body:state.map.command,headers:{'idempotency-key':state.map.commandId}}),200);
    const after=status(await b.request('GET',`/api/v1/sketches/${state.map.id}/live`),200) as LiveMapBootstrap;assert.equal(after.sequence,undone.delta.sequence);assert.equal(after.sketch.thoughts[0]?.version,state.map.version+1);assert.equal(after.sketch.thoughts[0]?.x,state.map.original.x);
    assert.equal(Number((await database.pool.query('SELECT count(*)::int n FROM map_live_journal WHERE sketch_id=$1 AND command_id=$2',[state.map.id,state.map.commandId])).rows[0].n),1);
    console.log('live-restart verify: both actual API CIDs changed; session/confirmed text/immutable pending receipt/explicit Save history/native ownUndo/retries persist without duplication');
  }
}finally {clearTimeout(deadline);for(const client of clients)client.close();for(const doc of documents)doc.destroy();await database.pool.end();}
