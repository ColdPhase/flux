#!/usr/bin/env python3
"""Record the pinned source, actual image, limits and exit of the bounded transport cohort."""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

root = Path('/home/hubert/Develop/flux/.worktrees/231-calibration-a24843d7')
out = Path('/home/hubert/flux-evidence/231-calibration-20261018-a24843d7/transport')
source = 'a24843d7995e01e4ca62d15eb4364d3af3e12245'

def run(args, **kw):
    return subprocess.run(args, check=True, timeout=60, **kw)

def inspect(name):
    return json.loads(run(['docker', 'inspect', name], capture_output=True, text=True).stdout)[0]

def write(name, value):
    (out/name).write_text(json.dumps(value, indent=2)+'\n')

assert run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True).stdout.strip() == source
assert not run(['git', 'status', '--porcelain'], cwd=root, capture_output=True, text=True).stdout
out.mkdir(mode=0o700, exist_ok=False)
image = inspect('flux-231-calibration:a24843d7')
assert image['Config']['Labels']['com.flux.commit'] == source
files = ['app/apps/server/src/http/upgrades.ts', 'app/apps/server/src/editing/gate.ts', 'app/pnpm-lock.yaml', 'docker/Dockerfile']
tests = ['editing-transport.test.ts', 'editing-codec-source.test.ts', 'editing-codec-pool.test.ts', 'editing-codec-charge.test.ts']
files += ['app/tests/app/'+n for n in tests]
files += ['app/apps/server/src/editing/codec/'+p.name for p in (root/'app/apps/server/src/editing/codec').glob('*.mjs')]
hashes = {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in sorted(files)}
write('source-and-command.json', {'sourceSha': source, 'imageId': image['Id'], 'files': hashes, 'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
# Verify the baked app sources, rather than accepting only an image label.
paths = [name.removeprefix('app/') for name in files if name.startswith('app/')]
code = "const fs=require('node:fs'),c=require('node:crypto'); const p=JSON.parse(process.argv[1]); console.log(JSON.stringify({node:process.version,files:Object.fromEntries(p.map(n=>[n,c.createHash('sha256').update(fs.readFileSync(n)).digest('hex')]))}));"
observed = json.loads(run(['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=512m','--memory-swap=512m','--cpus=2','--pids-limit=64',image['Id'],'node','-e',code,json.dumps(paths)],capture_output=True,text=True).stdout)
assert observed['files'] == {name.removeprefix('app/'): sha for name,sha in hashes.items() if name.startswith('app/')}
write('baked-source.json',observed)
name = 'flux231-transport-'+uuid.uuid4().hex[:12]
args = ['docker','create','--name',name,'--init','--network=none','--read-only','--tmpfs','/tmp:rw,nosuid,noexec,size=32m','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=512m','--memory-swap=512m','--cpus=2','--pids-limit=64',image['Id'],'node_modules/.bin/tsx','--test','--test-concurrency=1','--test-reporter=tap','--test-timeout=20000']+['tests/app/'+n for n in tests]
write('invocation.json',args)
run(args,capture_output=True,text=True)
started = time.time()
try:
    before = inspect(name)
    host = before['HostConfig']
    assert before['Image'] == image['Id']
    assert (host['Memory'],host['MemorySwap'],host['NanoCpus'],host['PidsLimit'],host['ReadonlyRootfs'],host['NetworkMode']) == (536870912,536870912,2000000000,64,True,'none')
    write('container-before.json', {'imageId':before['Image'],'containerId':before['Id'],'limits':{k:host[k] for k in ['Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','NetworkMode','CapDrop','SecurityOpt','Tmpfs']}})
    with (out/'transport.tap').open('wb') as log:
        result = run(['docker','start','--attach',name],stdout=log,stderr=subprocess.STDOUT)
    after = inspect(name)
    write('container-after.json',{'imageId':after['Image'],'containerId':after['Id'],'state':after['State'],'elapsedSeconds':time.time()-started})
    assert not after['State']['Running'] and not after['State']['OOMKilled'] and after['State']['ExitCode'] == 0
finally:
    run(['docker','rm','-f',name],capture_output=True,text=True)
assert run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True).stdout.strip() == source
assert not run(['git','status','--porcelain'],cwd=root,capture_output=True,text=True).stdout
write('result.json',{'sourceSha':source,'imageId':image['Id'],'exitStatus':0,'containerRemoved':True,'scope':'Transport and production codec only; no SQL, browser or complete live-editing acceptance'})
