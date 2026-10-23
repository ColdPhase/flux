import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('supplied shell action binds Start/Resume, preserves configuration and removes temporary native output (stub CLI, no model)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-shell-'));
  const checkout = join(root, 'checkout'), bin = join(root, 'bin'), native = randomUUID();
  await mkdir(join(checkout, 'docker'), { recursive: true }); await mkdir(bin); await mkdir(join(root, 'home'));
  await copyFile('/flux-launcher', join(checkout, 'flux'));
  await writeFile(join(checkout, 'docker', '.env'), 'FLUX_PROJECT=cowork-shell-test\n');
  const sentinel = join(root, 'home', 'config.toml'); await writeFile(sentinel, 'user configuration is preserved\n');
  await writeFile(join(bin, 'docker'), `#!/usr/local/bin/node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), volume=args.indexOf('-v');
if(volume<0) process.exit(0);
const state=args[volume+1].split(':/cowork-state:Z')[0], helper=args.indexOf('tooling/dist/cowork.js');
const result=spawnSync(process.execPath, ['/app/tooling/dist/cowork.js', ...args.slice(helper+1)], {env:{...process.env,FLUX_COWORK_STATE_DIR:state},stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o700 });
  await writeFile(join(bin, 'codex'), `#!/usr/local/bin/node
const {appendFileSync}=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.160.1');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
appendFileSync(process.env.COWORK_ARGS,JSON.stringify(args)+'\\n');
if(args.includes('login')) process.exit(0);
if(!args.includes('--ignore-user-config')||!args.includes('--sandbox')||args.includes('--last'))process.exit(2);
if(args.includes('resume')&&args[args.indexOf('resume')+1]!==${JSON.stringify(native)})process.exit(3);
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(native)}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Safe checkpoint.'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o700 });
  const env = { ...process.env, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), PATH: `${bin}:${process.env.PATH}`,
    COWORK_ARGS: join(root, 'native-args.jsonl'), CODEX_API_KEY: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', FLUX_PROJECT: '' };
  const common = ['--client', 'codex', '--origin', 'https://flux.example', '--connection', randomUUID(), '--project', randomUUID()];
  const invoke = (action: string) => spawnSync('sh', [join(checkout, 'flux'), 'cowork', action, ...common], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
  try {
    const start = invoke('start'); assert.equal(start.error, undefined); assert.equal(start.status, 0, start.stderr + start.stdout);
    const second = invoke('start'); assert.notEqual(second.status, 0, 'Start never replaces its existing native thread');
    const resume = invoke('resume'); assert.equal(resume.error, undefined); assert.equal(resume.status, 0, resume.stderr + resume.stdout);
    const args = (await readFile(env.COWORK_ARGS, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(args.filter(row => row.includes('login')).length, 1, 'Resume reuses its existing native OAuth credential');
    assert.ok(args.some(row => row.includes('resume') && row.includes(native)));
    assert.ok(args.filter(row => row[0] === 'exec').every(row => row.some(arg => arg.startsWith('mcp_servers.flux.url="https://flux.example/mcp?flux_connection=')) && !row.some(arg => arg.includes('oauth_resource='))));
    assert.equal(await readFile(sentinel, 'utf8'), 'user configuration is preserved\n');
    const directories = await readdir(join(root, 'state', 'flux', 'cowork'));
    const files = await readdir(join(root, 'state', 'flux', 'cowork', directories[0]!));
    assert.deepEqual(files.sort(), ['binding.json', 'oauth-authorized']);
  } finally { await rm(root, { recursive: true }); }
});

/** A stub Codex that never finishes its native run, and a stub Docker that runs the real metadata helper. */
async function hangingHostShell(root: string) {
  const checkout = join(root, 'checkout'), bin = join(root, 'bin'), argsFile = join(root, 'native-args.jsonl');
  await mkdir(join(checkout, 'docker'), { recursive: true }); await mkdir(bin); await mkdir(join(root, 'home'));
  await copyFile('/flux-launcher', join(checkout, 'flux'));
  await writeFile(join(checkout, 'docker', '.env'), 'FLUX_PROJECT=cowork-watchdog-test\n');
  await writeFile(join(bin, 'docker'), `#!/usr/local/bin/node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), volume=args.indexOf('-v');
if(volume<0) process.exit(0);
const state=args[volume+1].split(':/cowork-state:Z')[0], helper=args.indexOf('tooling/dist/cowork.js');
const result=spawnSync(process.execPath, ['/app/tooling/dist/cowork.js', ...args.slice(helper+1)], {env:{...process.env,FLUX_COWORK_STATE_DIR:state},stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o700 });
  await writeFile(join(bin, 'codex'), `#!/usr/local/bin/node
const {appendFileSync}=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.160.1');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
appendFileSync(process.env.COWORK_ARGS,JSON.stringify(args)+'\\n');
if(args.includes('login')) process.exit(0);
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const env = { ...process.env, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), PATH: `${bin}:${process.env.PATH}`,
    COWORK_ARGS: argsFile, CODEX_API_KEY: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', FLUX_PROJECT: '', FLUX_COWORK_WATCHDOG_SECONDS: '' };
  const common = ['--client', 'codex', '--origin', 'https://flux.example', '--connection', randomUUID(), '--project', randomUUID()];
  const invoke = (extra: Record<string, string>, timeout = 30_000) => spawnSync('sh', [join(checkout, 'flux'), 'cowork', 'start', ...common],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout });
  return { invoke, argsFile };
}

test('supplied shell action stops a native run that outlives FLUX_COWORK_WATCHDOG_SECONDS (stub CLI, no model)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-watchdog-'));
  try {
    const { invoke, argsFile } = await hangingHostShell(root);
    const started = Date.now();
    const run = invoke({ FLUX_COWORK_WATCHDOG_SECONDS: '1' });
    const elapsed = Date.now() - started;
    assert.equal(run.error, undefined, 'the launcher returns on its own, without the test timeout');
    assert.ok(elapsed < 20_000, `the 1-second watchdog ends the run well before the 300-second default (${elapsed} ms)`);
    assert.match(run.stdout, /Flux host action /, 'the native run is recorded after the watchdog stops it');
    const calls = (await readFile(argsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(calls.filter(row => row.includes('exec')).length, 1, 'one native run was started (OAuth login is not a run)');
  } finally { await rm(root, { recursive: true }); }
});

test('supplied shell action refuses an invalid FLUX_COWORK_WATCHDOG_SECONDS before any native start (stub CLI, no model)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-watchdog-invalid-'));
  try {
    const { invoke, argsFile } = await hangingHostShell(root);
    for (const value of ['0', '-5', '1.5', 'soon', '05']) {
      const run = invoke({ FLUX_COWORK_WATCHDOG_SECONDS: value });
      assert.equal(run.error, undefined, value);
      assert.notEqual(run.status, 0, `${value} is refused`);
      assert.match(run.stderr, /FLUX_COWORK_WATCHDOG_SECONDS must be a positive whole number/, value);
    }
    await assert.rejects(readFile(argsFile, 'utf8'), { code: 'ENOENT' }, 'no native invocation was started');
  } finally { await rm(root, { recursive: true }); }
});
