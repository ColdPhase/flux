import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CAPS } from './caps.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const inputs=JSON.parse(readFileSync(join(root,'candidate-inputs.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=process.env.FLUX_LIVE_SOURCE_SHA;
assert.match(source??'',/^[a-f0-9]{40}$/);assert.equal(inputs.schema,1);
assert.equal(Object.keys(inputs.canonicalModules).length,8);
for(const[name,expected]of Object.entries(inputs.canonicalModules)){
  assert.match(name,/^[a-z-]+\.mjs$/);assert.match(expected,/^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(join(root,name))),expected,`overlaid canonical ${name}`);
  assert.equal(hash(readFileSync(`/app/apps/server/src/editing/codec/${name}`)),expected,`actual image canonical ${name}`);
}
for(const[name,expected]of Object.entries(inputs.candidateFiles)){
  assert.match(name,/^[a-z.-]+\.mjs$/);assert.match(expected,/^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(join(root,name))),expected,`candidate ${name}`);
}
const packages=new Map();const rootsByName=new Map();
function metadataAt(path){
  const raw=readFileSync(join(path,'package.json'));if(raw.length>262144)throw new Error('Package metadata exceeds inventory bound');
  return{raw,metadata:JSON.parse(raw.toString('utf8'))};
}
function publicRoot(require,name){
  const entry=require.resolve(name);let parent=dirname(entry);
  for(let depth=0;depth<12;depth++){
    try{if(metadataAt(parent).metadata.name===name)return realpathSync(parent);}
    catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    const next=dirname(parent);if(next===parent)break;parent=next;
  }
  throw new Error(`Public dependency ${name} package metadata must resolve`);
}
function inspect(path){
  path=realpathSync(path);if(packages.has(path))return;
  if(packages.size>=128)throw new Error('Finite dependency inventory exceeded');
  const{raw,metadata}=metadataAt(path);
  const licenses=readdirSync(path).filter(name=>/^(license|copying)(\.(md|txt))?$/i.test(name)).map(name=>{
    const bytes=readFileSync(join(path,name));if(bytes.length>1048576)throw new Error('License exceeds inventory bound');
    return{name,sha256:hash(bytes)};
  });
  assert.equal(metadata.license,'MIT',`Review unexpected dependency license for ${metadata.name}`);assert.ok(licenses.length>0);
  const observed={name:metadata.name,version:metadata.version,license:metadata.license,licenses,path,packageSha256:hash(raw),resolutions:[]};
  packages.set(path,observed);
  const sameName=rootsByName.get(metadata.name)??new Set();sameName.add(path);rootsByName.set(metadata.name,sameName);
  const dependencies=metadata.dependencies??{};const optional=metadata.optionalDependencies??{};const peers=metadata.peerDependencies??{};
  const names=new Set([...Object.keys(dependencies),...Object.keys(optional),...Object.keys(peers)]);
  if(names.size>128)throw new Error('Dependency and peer fan-out exceeds inventory bound');
  const require=createRequire(join(path,'package.json'));
  for(const dependency of [...names].sort()){
    const declarations=[];
    if(dependency in dependencies)declarations.push({kind:'dependency',range:dependencies[dependency],required:!(dependency in optional)});
    if(dependency in optional)declarations.push({kind:'optionalDependency',range:optional[dependency],required:false});
    if(dependency in peers)declarations.push({kind:'peer',range:peers[dependency],required:metadata.peerDependenciesMeta?.[dependency]?.optional!==true});
    let resolved;
    try{resolved=publicRoot(require,dependency);}
    catch(error){
      if(error.code==='MODULE_NOT_FOUND'&&declarations.every(item=>!item.required)){
        observed.resolutions.push({name:dependency,declarations,status:'absent',reason:'MODULE_NOT_FOUND'});continue;
      }
      throw error;
    }
    const actual=metadataAt(resolved).metadata;
    observed.resolutions.push({name:dependency,declarations,status:'present',path:resolved,version:actual.version});
    inspect(resolved);
  }
}
for(const[name,expected]of Object.entries(inputs.dependencies)){
  const entry=resolve(root,'node_modules',name);const actual=metadataAt(entry).metadata;
  assert.equal(actual.name,name);assert.equal(actual.version,expected,`Pinned ${name}`);inspect(entry);
}
assert.equal(rootsByName.get('yjs')?.size,1,'All inspected dependency graphs use one installed Yjs package');
for(const name of ['yjs','@codemirror/state','@codemirror/view']){
  assert.equal(rootsByName.get(name)?.size,1,`Binding/protocol/dependency peers use one installed ${name} package`);
  assert.ok(rootsByName.get(name).has(realpathSync(resolve(root,'node_modules',name))),`Every resolved ${name} matches its exact declared fixture root`);
}
process.stdout.write(`${JSON.stringify({schema:1,sourceSha:source,recordedAt:new Date().toISOString(),versions:process.versions,
  lockSha256:hash(readFileSync('/app/pnpm-lock.yaml')),caps:CAPS,canonicalModules:inputs.canonicalModules,
  candidateFiles:inputs.candidateFiles,dependencies:[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.path.localeCompare(b.path)),
  meaning:'Actual pinned image/dependency/source inventory; no SQL, DOM, RSS or four-gate acceptance'},null,2)}\n`);
