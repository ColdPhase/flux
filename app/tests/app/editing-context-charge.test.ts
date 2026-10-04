import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { editingContextCharge,editingMapContextCharge } from '../../apps/server/src/editing/context-charge.js';

test('actual pinned Fastify params/query data records fit the charged HTTP/native admission shape',async()=>{
  const app=Fastify();
  const nullRecord=(value:unknown)=>{
    const prototype=Object.getPrototypeOf(value);
    return prototype===null||prototype&&Object.getPrototypeOf(prototype)===null&&Reflect.ownKeys(prototype).length===0;
  };
  app.post('/shape/:id',async request=>{
    const context={params:request.params,query:request.query,headers:request.headers,body:request.body};
    return{paramsNullRecord:nullRecord(request.params),queryNullRecord:nullRecord(request.query),wikiCharge:editingContextCharge(context),mapCharge:editingMapContextCharge(context)};
  });
  try {
    const response=await app.inject({method:'POST',url:`/shape/${randomUUID()}?mode=shared`,headers:{'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{scope:'project',projectId:randomUUID(),title:'A normal native map'}});
    assert.equal(response.statusCode,200,response.body);const value=response.json();
    assert.equal(value.paramsNullRecord,true,'Retain the actual pinned router prototype observation');assert.equal(value.queryNullRecord,true);
    assert.ok(value.wikiCharge>0&&value.wikiCharge<=65536);assert.ok(value.mapCharge>0&&value.mapCharge<=262144);
  }finally{await app.close();}
});

test('all200 closed movement records fit unchanged map metadata capacity while malformed/unbounded data refuse',()=>{
  const command={generation:randomUUID(),gestureId:randomUUID(),leaseId:randomUUID(),sequence:1,
    positions:Array.from({length:200},(_,index)=>({id:randomUUID(),x:index,y:-index,width:184,height:72}))};
  assert.ok(editingMapContextCharge({command})<=262144);assert.ok(Buffer.byteLength(JSON.stringify(command))<=65536);
  assert.throws(()=>editingContextCharge({command}),{code:'ADMISSION_METADATA_LIMIT'},'The wiki512-visit budget remains separate and unchanged');
  assert.throws(()=>editingMapContextCharge({text:'x'.repeat(262144)}),{code:'ADMISSION_METADATA_LIMIT'});
  const cycle:{self?:unknown}={};cycle.self=cycle;assert.throws(()=>editingMapContextCharge(cycle),{code:'ADMISSION_METADATA_LIMIT'});
  class Custom { value='closed but a custom prototype'; }
  assert.throws(()=>editingMapContextCharge(new Custom()),{code:'ADMISSION_METADATA_LIMIT'});
  let invoked=false;const getter={get value(){invoked=true;return'Never execute code while accounting';}};
  assert.throws(()=>editingMapContextCharge(getter),{code:'ADMISSION_METADATA_LIMIT'});assert.equal(invoked,false);
  assert.throws(()=>editingMapContextCharge({[Symbol('unaccounted')]:'hidden'}),{code:'ADMISSION_METADATA_LIMIT'});
});
