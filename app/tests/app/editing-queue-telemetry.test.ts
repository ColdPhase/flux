import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough,Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { developmentQueueTelemetry,EditingQueueTelemetry,EDITING_QUEUE_PREFIX,EDITING_RESOURCE_GAUGES,type EditingResourceSnapshot } from '../../apps/server/src/editing/telemetry.js';
import { editingResourcesChanged,observeEditingResources } from '../../apps/server/src/editing/resource-observation.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { AdmissionBudget } from '../../apps/server/src/editing/codec/admission-budget.mjs';
import { Assemblies,packet } from '../../apps/server/src/editing/codec/assembly.mjs';
const gauges=()=>Object.fromEntries(EDITING_RESOURCE_GAUGES.map(field=>[field,0])) as EditingResourceSnapshot;

test('development telemetry is disabled without both selections and requires explicit inspected instance identity',()=>{
  let writes=0;const stream=new Writable({write(_chunk,_encoding,callback){writes++;callback();}});
  assert.equal(developmentQueueTelemetry({},false,gauges,stream),null);
  assert.equal(developmentQueueTelemetry({FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY:'1'},false,gauges,stream),null);
  assert.equal(developmentQueueTelemetry({},true,gauges,stream),null);
  assert.throws(()=>developmentQueueTelemetry({FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY:'1'},true,gauges,stream),/Explicit inspected/);assert.equal(writes,0);
});
test('all25 mutation-maintained peaks survive a transient between emitted receipts and final has real drained counters',async()=>{
  const stream=new PassThrough({highWaterMark:65536});let raw='';stream.on('data',chunk=>{raw+=chunk.toString();});
  const state=gauges();const telemetry=new EditingQueueTelemetry('api-one',()=>({...state}),stream);const unobserve=observeEditingResources(telemetry.observe);
  try {
    assert.equal(telemetry.start(),true);
    for(const [index,field] of EDITING_RESOURCE_GAUGES.entries()){state[field]=index+1;editingResourcesChanged();state[field]=0;editingResourcesChanged();}
    assert.equal(telemetry.emit('wiki',{resourceId:randomUUID(),generation:randomUUID(),commandId:randomUUID(),confirmedSequence:7}),true);
    assert.equal(await telemetry.finish(true),true);
    const records=raw.trimEnd().split('\n').map(line=>{assert.ok(line.startsWith(EDITING_QUEUE_PREFIX));assert.ok(Buffer.byteLength(line.slice(EDITING_QUEUE_PREFIX.length)+'\n')<=4096);return JSON.parse(line.slice(EDITING_QUEUE_PREFIX.length));});
    assert.deepEqual(records.map(record=>record.kind),['initial','wiki','final']);const final=records[2];assert.equal(final.finalDrained,true);
    for(const [index,field] of EDITING_RESOURCE_GAUGES.entries()){assert.equal(final[field],0);assert.equal(final[`peak${field[0]!.toUpperCase()}${field.slice(1)}`],index+1);}
    assert.equal(final.attemptedRecords,3);assert.equal(final.retainedRecords,3);assert.equal(final.droppedRecords,0);
    assert.equal(telemetry.emit('map',{resourceId:randomUUID(),generation:randomUUID()}),false);assert.equal(raw.trimEnd().split('\n').length,3);
  }finally{unobserve();stream.destroy();}
});
test('actual Writable write(false) is retained and subsequent backpressure drops are cumulative; nonempty terminal transport cannot claim complete',async()=>{
  let release=()=>{};const stream=new Writable({highWaterMark:1,write(_chunk,_encoding,callback){release=()=>callback();}});
  const telemetry=new EditingQueueTelemetry('api-two',gauges,stream);
  assert.equal(telemetry.start(),true);assert.equal(telemetry.counts.retainedRecords,1);assert.equal(telemetry.counts.backpressured,true);
  assert.equal(telemetry.emit('map',{resourceId:randomUUID(),generation:randomUUID(),interactionId:randomUUID(),inputSequence:1}),false);
  assert.equal(telemetry.counts.attemptedRecords,2);assert.equal(telemetry.counts.droppedRecords,1);
  assert.equal(await telemetry.finish(true,0),false);assert.equal(telemetry.counts.attemptedRecords,telemetry.counts.retainedRecords+telemetry.counts.droppedRecords);
  release();stream.destroy();
});
test('missing actual source fields and positive terminal resources never become invented zero/complete',async()=>{
  const stream=new PassThrough({highWaterMark:65536});let raw='';stream.on('data',chunk=>{raw+=chunk.toString();});
  const state=gauges();state.mapSqlActive=1;const telemetry=new EditingQueueTelemetry('api-one',()=>({...state}),stream);telemetry.start();
  assert.equal(await telemetry.finish(true),true);assert.equal(JSON.parse(raw.trimEnd().split('\n')[1]!.slice(EDITING_QUEUE_PREFIX.length)).finalDrained,false);
  const missing=new EditingQueueTelemetry('api-two',()=>({} as EditingResourceSnapshot),stream);assert.equal(missing.start(),false);assert.equal(await missing.finish(true),false);assert.equal(missing.counts.retainedRecords,0);stream.destroy();
});

test('200ms ordinary sampling keeps one charged latest correlation without inventing dropped measurement interactions',async()=>{
  const stream=new PassThrough({highWaterMark:65536});let raw='';stream.on('data',chunk=>{raw+=chunk.toString();});const budget=new EditingOutputBudget();
  const telemetry=new EditingQueueTelemetry('api-one',()=>({...gauges(),externalOutputBytes:budget.bytes}),stream,budget);telemetry.start();
  const resourceId=randomUUID(),generation=randomUUID(),latest=randomUUID();
  for(let index=0;index<100;index++)telemetry.schedule('wiki',{resourceId,generation,commandId:randomUUID(),confirmedSequence:index});
  telemetry.schedule('map',{resourceId,generation,commandId:latest,confirmedSequence:100});
  assert.ok(budget.bytes>0);assert.ok(budget.bytes<65536,'Only one closed primitive correlation remains charged');assert.equal(telemetry.counts.attemptedRecords,1);
  await delay(230);assert.equal(budget.bytes,0);assert.equal(telemetry.counts.attemptedRecords,2);assert.equal(telemetry.counts.droppedRecords,0);
  assert.equal(await telemetry.finish(true),true);const records=raw.trimEnd().split('\n').map(line=>JSON.parse(line.slice(EDITING_QUEUE_PREFIX.length)));
  assert.deepEqual(records.map(record=>record.kind),['initial','map','final']);assert.equal(records[1].commandId,latest);stream.destroy();
});

test('real output, input and assembly mutations retain peaks even when all resources release before a sampled frame',async()=>{
  const stream=new PassThrough({highWaterMark:65536});stream.resume();const common=new EditingOutputBudget();
  const input=new AdmissionBudget(editingResourcesChanged);const assemblies=new Assemblies(editingResourcesChanged);
  const telemetry=new EditingQueueTelemetry('api-one',()=>({...gauges(),externalOutputBytes:common.bytes,externalInputBytes:input.bytes,codecLeases:input.leases.size,
    assemblyBytes:assemblies.bytes,assemblyCount:assemblies.pending.size}),stream,common);
  const unobserve=observeEditingResources(telemetry.observe);let raw='';stream.on('data',chunk=>{raw+=chunk.toString();});
  try {
    telemetry.start();const source=common.lease(4096);source.resize(8192);source.release();
    const lease=input.reservePending(new Uint8Array(16));const maximum=input.bytes;input.release(lease);
    const intent={workspace:'w',kind:'wiki' as const,room:'r',generation:'g',actor:'a',operation:'text' as const,uuid:'u',replica:1,parameters:null};
    assemblies.receive('actual',packet({...intent,index:0,count:1},new Uint8Array(100)),intent,0);assemblies.remove('actual');
    assert.equal(await telemetry.finish(true),true);const final=JSON.parse(raw.trimEnd().split('\n').at(-1)!.slice(EDITING_QUEUE_PREFIX.length));
    assert.equal(final.peakExternalOutputBytes,8192);assert.equal(final.peakExternalInputBytes,maximum);assert.equal(final.peakCodecLeases,1);
    assert.equal(final.peakAssemblyCount,1);assert.equal(final.peakAssemblyBytes,200);assert.equal(final.finalDrained,true);
  }finally{unobserve();stream.destroy();}
});
