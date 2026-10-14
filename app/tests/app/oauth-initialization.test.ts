import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { connectionString, pool } from './support/db.js';

function postgresError(error:unknown):{code?:unknown;constraint?:unknown}|null {
  for(let depth=0;depth<4&&error&&typeof error==='object';depth++){
    if('code' in error)return error;
    error='cause' in error?error.cause:null;
  }
  return null;
}

// The barrier is a labelled public query-boundary interposition: each SELECT really
// returns empty before either production context gets to perform its real INSERT.
test('simultaneous identity initialization survives a real competing resource insert and preserves existing policy', {timeout:15_000}, async()=>{
  const origin=`https://init-${randomUUID()}.example.test`;const resource=`${origin}/mcp`;
  const config=loadIdentityConfig({FLUX_PUBLIC_ORIGIN:origin,FLUX_AUTH_SECRET:randomBytes(32).toString('hex'),FLUX_AUTH_RATE_LIMIT:'false'});
  const databases=[createDatabase(connectionString),createDatabase(connectionString)];const servers=[Fastify(),Fastify()];
  let emptyReads=0,identifierConflicts=0;let openBarrier:()=>void=()=>{};let failBarrier:(error:Error)=>void=()=>{};
  const barrier=new Promise<void>((resolve,reject)=>{openBarrier=resolve;failBarrier=reject;});
  const timer=setTimeout(()=>failBarrier(new Error('Both actual empty resource lookups must reach the initialization barrier')),2000);
  const queries=databases.map(database=>database.pool.query);
  for(const[index,database]of databases.entries()){
    const query=queries[index]!;
    database.pool.query=function(...args:unknown[]){
      const statement=args[0];const text=typeof statement==='string'?statement:statement&&typeof statement==='object'&&'text'in statement?statement.text:null;
      const parameters=args[1];
      if(typeof text!=='string'||!text.includes('"oauth_resource"')||!Array.isArray(parameters)||!parameters.includes(resource))return Reflect.apply(query,database.pool,args);
      return Promise.resolve(Reflect.apply(query,database.pool,args)).then(async(result:{rows:unknown[]})=>{
        if(/^select\b/i.test(text)&&result.rows.length===0){
          emptyReads++;if(emptyReads===2){clearTimeout(timer);openBarrier();}await barrier;
        }
        return result;
      },(error:unknown)=>{
        const pg=postgresError(error);if(pg?.code==='23505'&&pg.constraint==='oauth_resource_identifier_unique')identifierConflicts++;
        throw error;
      });
    } as typeof database.pool.query;
  }
  const ready:Promise<unknown>[]=[];
  try{
    for(const[index,server]of servers.entries())registerIdentity(server,{db:databases[index]!.db,config,mailer:null});
    ready.push(...servers.map(server=>Promise.resolve(server.ready())));await Promise.all(ready);
    assert.equal(emptyReads,2);assert.equal(identifierConflicts,1,'One actual PostgreSQL insert loses the identifier race');
    const rows=(await pool.query('SELECT * FROM oauth_resource WHERE identifier=$1',[resource])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].identifier,resource);assert.equal(rows[0].name,resource);assert.equal(rows[0].disabled,false);assert.equal(rows[0].policy_version,1);
    for(const server of servers){
      const discovery=await server.inject({method:'GET',url:'/.well-known/oauth-protected-resource/mcp'});
      assert.equal(discovery.statusCode,200);assert.equal(discovery.json().resource,resource);
    }
    await pool.query('UPDATE oauth_resource SET disabled=true,allowed_scopes=$2,access_token_ttl=123,metadata=$3 WHERE identifier=$1',[resource,['flux.context.read'],{fixture:'admin policy survives restart'}]);
    const before=(await pool.query('SELECT * FROM oauth_resource WHERE identifier=$1',[resource])).rows[0];
    const later=createAuth({db:databases[0]!.db,config,mailer:null,oauthRequests:createOauthRequests()});await later.$context;
    assert.deepEqual((await pool.query('SELECT * FROM oauth_resource WHERE identifier=$1',[resource])).rows[0],before,'Default insertOnly initialization never overwrites existing administrative policy');
  }finally{
    clearTimeout(timer);openBarrier();await Promise.allSettled(ready);
    for(const[index,database]of databases.entries())database.pool.query=queries[index]!;
    await Promise.allSettled(servers.map(server=>server.close()));await Promise.all(databases.map(database=>database.pool.end()));
  }
});

test('an unrelated real resource primary-key conflict still fails initialization', {timeout:10_000}, async()=>{
  const database=createDatabase(connectionString);const query=database.pool.query;const occupied=randomUUID();
  const origin=`https://init-negative-${randomUUID()}.example.test`;const resource=`${origin}/mcp`;
  const config=loadIdentityConfig({FLUX_PUBLIC_ORIGIN:origin,FLUX_AUTH_SECRET:randomBytes(32).toString('hex'),FLUX_AUTH_RATE_LIMIT:'false'});
  await pool.query('INSERT INTO oauth_resource(id,identifier,name) VALUES($1,$2,$3)',[occupied,`https://occupied-${randomUUID()}.example.test/mcp`,'Unrelated primary key fixture']);
  let attempts=0;database.pool.query=function(...args:unknown[]){
    const statement=args[0];const text=typeof statement==='string'?statement:statement&&typeof statement==='object'&&'text'in statement?statement.text:null;
    const parameters=args[1];
    if(typeof text==='string'&&/^insert into "oauth_resource"/i.test(text)&&Array.isArray(parameters)&&parameters.includes(resource)){
      // Only the INSERT id is deliberately collided; PostgreSQL really rejects it.
      const replacement=[...parameters];assert.match(text,/\("id", "identifier"/);replacement[0]=occupied;attempts++;
      return Reflect.apply(query,database.pool,[statement,replacement,...args.slice(2)]);
    }
    return Reflect.apply(query,database.pool,args);
  } as typeof database.pool.query;
  try{
    const auth=createAuth({db:database.db,config,mailer:null,oauthRequests:createOauthRequests()});
    await assert.rejects(auth.$context,error=>{const pg=postgresError(error);return pg?.code==='23505'&&pg.constraint==='oauth_resource_pkey';});
    assert.equal(attempts,1);assert.equal(Number((await pool.query('SELECT count(*)::int n FROM oauth_resource WHERE identifier=$1',[resource])).rows[0].n),0);
  }finally{database.pool.query=query;await database.pool.end();}
});
