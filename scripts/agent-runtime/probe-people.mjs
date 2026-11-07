// One runtime, many people (#860), proved in a container with the real settings: root with only the six capabilities, a
// read-only root filesystem, no-new-privileges. It runs the real supervisor code (not its main, which needs a host with
// ptrace_scope of 1 or higher) over the TEST ONLY fake CLIs, and tries from one person's user id to reach another's.
// scripts/check_runtime_people.sh runs it and reads the MEASURE lines from outside.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { callSupervisor } from '/opt/flux-runtime/packages/runtime-protocol/dist/index.js';
import { clearClientFiles, clearScratch, freePerson, hasUnconfirmed, PERSON_IDS, recordUnconfirmed } from '/opt/flux-runtime/apps/runtime/dist/supervisor/data.js';
import { runFixed } from '/opt/flux-runtime/apps/runtime/dist/supervisor/process.js';
import { createSupervisorServer } from '/opt/flux-runtime/apps/runtime/dist/supervisor/server.js';

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail).slice(0, 200) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); };

const config = {
  slot: 'runtime-1', secret: randomBytes(24).toString('base64url'), bootId: randomUUID(), dataDir: '/data', tmpDir: '/tmp', separate: true, capacity: 2,
  enabled: ['claude_code', 'codex'], cliPaths: { claude_code: '/opt/flux-fakes/claude', codex: '/opt/flux-runtime/codex/bin/codex' },
  egressHost: 'runtime-egress', bindingLimitBytes: 256 * 1024 * 1024, cliTimeoutMs: 10_000,
};
const { server } = createSupervisorServer(config);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const target = { host: '127.0.0.1', port: server.address().port, secret: config.secret };
const call = (request) => callSupervisor(target, request, { timeoutMs: 30_000 });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const rss = async () => Number(/^VmRSS:\s+(\d+)/m.exec(await readFile('/proc/self/status', 'utf8'))?.[1] ?? 0);

const ada = randomUUID();
const jonas = randomUUID();
for (const bindingId of [ada, jonas]) record(`bind ${bindingId.slice(0, 8)}`, (await call({ kind: 'bind', bindingId })).ok);
const adaStat = await lstat(`/data/${ada}`);
const jonasStat = await lstat(`/data/${jonas}`);
const person = (stat) => ({ uid: stat.uid, gid: stat.gid });
record('each person has their own user id, in the range', adaStat.uid !== jonasStat.uid && adaStat.uid >= PERSON_IDS.first && jonasStat.uid <= PERSON_IDS.last, `${adaStat.uid} ${jonasStat.uid}`);
record('their directory is 0700 and theirs', (adaStat.mode & 0o777) === 0o700 && adaStat.gid === adaStat.uid);
for (const sub of ['claude', 'codex', 'home', 'tmp']) {
  const stat = await lstat(`/data/${ada}/${sub}`);
  record(`${sub} is theirs`, stat.uid === adaStat.uid && (stat.mode & 0o777) === 0o700);
}
const free = await freePerson('/data');
record('the next person gets the next free id', free.uid === Math.max(adaStat.uid, jonasStat.uid) + 1, free.uid);

// Jonas has a login and a process that keeps running.
await writeFile(`/data/${jonas}/claude/.credentials.json`, '{"secret":"jonas-login"}', { mode: 0o600 });
const owned = await runFixed('/bin/sh', ['-c', `chown ${jonasStat.uid}:${jonasStat.gid} /data/${jonas}/claude/.credentials.json 2>&1; true`], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5000, person: null });
record('control: the supervisor could chown', owned.code === 0, owned.stdout);

const jonasSleeps = (seconds) => new Promise((resolve) => {
  execFile('/bin/sh', ['-c', `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { uid: jonasStat.uid, gid: jonasStat.gid }, (error, stdout) => resolve(Number(stdout.trim())));
});
const sleeper = await jonasSleeps(300);
record('control: Jonas has a process', sleeper > 0, sleeper);

// What Ada's CLI could try, under her user id, with no capabilities.
const attempt = `
const fs = require('node:fs');
const out = {};
const tried = (name, action) => { try { out[name] = 'REACHED ' + action(); } catch (error) { out[name] = error.code ?? error.message; } };
tried('readLogin', () => fs.readFileSync(process.argv[1] + '/claude/.credentials.json', 'utf8'));
tried('listHome', () => fs.readdirSync(process.argv[1]).join());
tried('writeHome', () => fs.writeFileSync(process.argv[1] + '/planted', 'x'));
tried('listData', () => fs.readdirSync('/data').join());
tried('signal', () => process.kill(Number(process.argv[2]), 'SIGKILL'));
tried('supervisorEnviron', () => fs.readFileSync('/proc/' + process.argv[3] + '/environ', 'utf8').length);
tried('supervisorMem', () => fs.openSync('/proc/' + process.argv[3] + '/mem', 'r'));
tried('rootFilesystem', () => fs.writeFileSync('/opt/flux-tools/planted', 'x'));
tried('toolsVolume', () => fs.accessSync('/opt/flux-fakes/claude', fs.constants.X_OK) ?? 'runs');
out.uid = process.getuid();
console.log(JSON.stringify(out));
`;
const tried = await runFixed(process.execPath, ['-e', attempt, `/data/${jonas}`, String(sleeper), String(process.pid)], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, cwd: `/data/${ada}`, timeoutMs: 10_000, person: person(adaStat), readStderr: true });
let reached = {};
try { reached = JSON.parse(tried.stdout); } catch { record('the attempts ran', false, `${tried.stdout} ${tried.stderr}`); }
record('the attempts ran under her id', reached.uid === adaStat.uid, reached.uid);
for (const [name, code] of [['readLogin', 'EACCES'], ['listHome', 'EACCES'], ['writeHome', 'EACCES'], ['listData', 'EACCES'], ['signal', 'EPERM'], ['supervisorEnviron', 'EACCES'], ['supervisorMem', 'EACCES']]) {
  record(`Ada cannot ${name}`, reached[name] === code, reached[name]);
}
record('Ada cannot write outside her place', String(reached.rootFilesystem).startsWith('E'), reached.rootFilesystem);
record('control: she can run the CLI', String(reached.toolsVolume).startsWith('REACHED'), reached.toolsVolume);
record('Jonas\'s process is alive after all that', (await readFile(`/proc/${sleeper}/status`, 'utf8').catch(() => '')).length > 0);

// A CLI runs as its person, and nothing it started outlives its command.
const status = await call({ kind: 'status', bindingId: ada, client: 'claude_code', bootId: config.bootId });
record('a status runs the fake CLI as Ada', status.ok && status.result.kind === 'status', JSON.stringify(status).slice(0, 160));
const calls = await lstat(`/data/${ada}/claude/fake-calls.jsonl`).catch(() => null);
record('what it wrote is hers', calls?.uid === adaStat.uid, calls?.uid);

// Links her CLI plants before it ends. The supervisor cleans up after her, and none of it may reach anyone else or make a file as root.
const adaDir = `/data/${ada}`;
const plant = (script) => runFixed('/bin/sh', ['-c', script, 'sh', adaDir, `/data/${jonas}`], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: person(adaStat) });
const jonasLogin = async () => (await readFile(`/data/${jonas}/claude/.credentials.json`, 'utf8').catch(() => '')).includes('jonas-login');
await plant('mv "$1/tmp" "$1/tmp.real"; ln -s /data "$1/tmp"');
await clearScratch(adaDir, person(adaStat));
record('a link planted as her scratch reaches nobody', await jonasLogin() && (await readdir('/data')).includes(jonas));
record('her scratch is a real directory again', (await lstat(`${adaDir}/tmp`)).isDirectory());
await plant('rm -rf "$1/tmp.real"; rm -rf "$1/claude"; ln -s "$2/claude" "$1/claude"');
await clearClientFiles(adaDir, 'claude_code', person(adaStat));
record('a link planted as her CLI home reaches nobody', await jonasLogin());
record('her CLI home is a real directory again', (await lstat(`${adaDir}/claude`)).isDirectory());
await plant('rm -rf "$1/home/.config"; ln -s "$2" "$1/home/.config"');
await clearClientFiles(adaDir, 'claude_code', person(adaStat));
record('a link planted in her home reaches nobody', await jonasLogin());
await plant('ln -s /data/stray-from-root "$1/unconfirmed-claude_code"');
await recordUnconfirmed(adaDir, 'claude_code');
record('a planted marker makes no file as root', (await lstat('/data/stray-from-root').catch(() => null)) === null);
record('whatever stands at the marker counts as recorded', await hasUnconfirmed(adaDir, 'claude_code'));
const shm = await plant('echo left > /dev/shm/ada-left');
record('nobody can leave anything in /dev/shm', shm.code !== 0, shm.code);

// What she leaves in the shared /tmp goes with her: her user id can go to someone else later.
await runFixed('/bin/sh', ['-c', 'echo left > /tmp/ada-left'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: person(adaStat) });
record('control: Ada left a file in /tmp', (await lstat('/tmp/ada-left').catch(() => null))?.uid === adaStat.uid);

// Releasing Ada leaves Jonas; releasing Jonas ends the process he left behind.
const releasedAda = await call({ kind: 'release', bindingId: ada });
record('release says everything of Ada is gone', releasedAda.ok && releasedAda.result.deleted === true, JSON.stringify(releasedAda).slice(0, 200));
record('what she left in /tmp is gone', (await lstat('/tmp/ada-left').catch(() => null)) === null);
record('her directory is gone, his stays', !(await readdir('/data')).includes(ada) && (await readdir('/data')).includes(jonas));
record('his login is untouched', (await readFile(`/data/${jonas}/claude/.credentials.json`, 'utf8')).includes('jonas-login'));
record('his process is untouched', (await readFile(`/proc/${sleeper}/status`, 'utf8').catch(() => '')).length > 0);
const releasedJonas = await call({ kind: 'release', bindingId: jonas });
record('release of Jonas ends what he left running', releasedJonas.ok && releasedJonas.result.deleted === true && !(await readFile(`/proc/${sleeper}/status`, 'utf8').catch(() => '')).includes('sleep'));
record('/data is empty', (await readdir('/data')).length === 0);

// What people cost: idle, then many of them.
console.log(`MEASURE supervisor_idle_rss_kib ${await rss()}`);
const everyone = Array.from({ length: Number(process.env.FLUX_PROBE_PEOPLE ?? 500) }, () => randomUUID());
const started = Date.now();
for (const bindingId of everyone) { const answer = await call({ kind: 'bind', bindingId }); if (!answer.ok) { record('bind many', false, JSON.stringify(answer)); break; } }
console.log(`MEASURE bind_ms_each ${((Date.now() - started) / everyone.length).toFixed(1)}`);
const stats = new Set();
for (const bindingId of everyone) stats.add((await lstat(`/data/${bindingId}`)).uid);
record(`${everyone.length} people have ${everyone.length} user ids`, stats.size === everyone.length, stats.size);
const report = await callSupervisor(target, { kind: 'status' }, { timeoutMs: 30_000, limits: { lineBytes: 2 * 1024 * 1024, totalBytes: 3 * 1024 * 1024, frames: 16 } });
record('the report lists them all', report.ok && report.result.slot.data.bindings.length === everyone.length, report.ok ? report.result.slot.data.bindings.length : report.code);
console.log(`MEASURE supervisor_rss_kib_with_people ${await rss()}`);
const processes = (await readdir('/proc')).filter((entry) => /^[0-9]+$/.test(entry)).length;
console.log(`MEASURE processes_with_people ${processes}`);
console.log('MEASURE idle_now');
await pause(Number(process.env.FLUX_PROBE_IDLE_MS ?? 20_000));
for (const bindingId of everyone) await call({ kind: 'release', bindingId });
record('everyone leaves', (await readdir('/data')).length === 0);

await new Promise((done) => server.close(done));
const failed = results.filter((result) => !result.ok);
console.log(`PEOPLE=${failed.length ? 'failed' : 'ok'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
