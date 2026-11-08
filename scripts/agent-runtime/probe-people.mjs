// One runtime, many people (#860), proved in a container with the real settings: root with only the six capabilities, a
// read-only root filesystem, no-new-privileges. It runs the real supervisor code (not its main, which needs a host with
// ptrace_scope of 1 or higher) over the TEST ONLY fake CLIs, and tries from one person's user id to reach another's.
// scripts/check_runtime_people.sh runs it and reads the MEASURE lines from outside.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { callSupervisor } from '/opt/flux-runtime/packages/runtime-protocol/dist/index.js';
import { clearClientFiles, clearLeftovers, clearScratch, freePerson, hasUnconfirmed, PERSON_IDS, recordUnconfirmed, removeBinding } from '/opt/flux-runtime/apps/runtime/dist/supervisor/data.js';
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

// A CLI of hers can leave directories nobody can open (mode 000 all the way down) in her scratch and in /tmp; only she can give their
// rights back, and the next person with her user id must not find them (#910).
const asAda = (script, ...args) => runFixed('/bin/sh', ['-c', script, 'sh', ...args], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: person(adaStat) });
const closedTree = 'mkdir -p "$1/inner/deeper" && echo left > "$1/inner/deeper/file" && chmod 000 "$1/inner/deeper" "$1/inner" "$1"';
await asAda(closedTree, `${adaDir}/tmp/closed`);
record('control: she left a closed directory in her scratch', (await readdir(`${adaDir}/tmp`)).includes('closed'));
record('the cleanup of her scratch says it worked', await clearScratch(adaDir, person(adaStat)));
record('a closed directory in her scratch is gone', (await readdir(`${adaDir}/tmp`)).length === 0);
await asAda(closedTree, '/tmp/ada-closed');
record('control: she left a closed directory in /tmp', (await lstat('/tmp/ada-closed').catch(() => null))?.uid === adaStat.uid);
// Something she cannot remove: a root-owned directory with a file inside one of hers.
await runFixed('/bin/sh', ['-c', `mkdir -p /tmp/ada-stuck/root-owned && echo x > /tmp/ada-stuck/root-owned/file && chown ${adaStat.uid}:${adaStat.gid} /tmp/ada-stuck`],
  { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: null });
record('the cleanup of /tmp says that something stayed', (await clearLeftovers('/tmp', person(adaStat))) === false);
record('and the closed directory is gone though', (await lstat('/tmp/ada-closed').catch(() => null)) === null);
const stuck = await call({ kind: 'release', bindingId: ada });
record('a release does not say deleted while a file of hers stays in /tmp', stuck.ok && stuck.result.deleted === false, JSON.stringify(stuck).slice(0, 200));
record('and her directory stays, so her user id goes to nobody else', (await readdir('/data')).includes(ada));
await runFixed('/bin/sh', ['-c', 'rm -rf /tmp/ada-stuck'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: null });

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

// What a program can leave behind that no `rm` can take, or that sits where a cleanup of one person never looked (#915).
const eve = randomUUID();
const noah = randomUUID();
for (const bindingId of [eve, noah]) record(`bind ${bindingId.slice(0, 8)}`, (await call({ kind: 'bind', bindingId })).ok);
const eveStat = await lstat(`/data/${eve}`);
const noahStat = await lstat(`/data/${noah}`);
const as = (stat, script, ...args) => runFixed('/bin/sh', ['-c', script, 'sh', ...args], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 20_000, person: person(stat) });
const asNode = (stat, source, ...args) => runFixed(process.execPath, ['-e', source, ...args], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 60_000, person: person(stat) });
// A tree deeper than PATH_MAX: a few thousand levels of one-letter names, built by changing directory, which only a program like that can.
const deepTree = 'const fs = require("node:fs"); fs.mkdirSync(process.argv[1], { mode: 0o755 }); process.chdir(process.argv[1]); for (let level = 0; level < 2200; level += 1) { fs.mkdirSync("d"); process.chdir("d"); } fs.writeFileSync("file", "left");';
const stillThere = async (path) => (await lstat(path).catch(() => null)) !== null;
const callsOf = async (bindingId) => (await readFile(`/data/${bindingId}/claude/fake-calls.jsonl`, 'utf8').catch(() => '')).split('\n').filter((line) => line.includes('"logout"')).length;
await writeFile(`/data/${eve}/claude/.credentials.json`, '{"secret":"eve-login"}', { mode: 0o600 });
await runFixed('/bin/sh', ['-c', `chown ${eveStat.uid}:${eveStat.gid} /data/${eve}/claude/.credentials.json`], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: null });

await asNode(eveStat, deepTree, '/tmp/eve-deep');
const plainRm = await as(eveStat, 'rm -rf -- "$1"', '/tmp/eve-deep');
record('control: rm cannot take a tree deeper than PATH_MAX', plainRm.code !== 0 && await stillThere('/tmp/eve-deep'), `${plainRm.code}`);
record('the cleanup of /tmp takes it', (await clearLeftovers('/tmp', person(eveStat))) === true && !(await stillThere('/tmp/eve-deep')));

// Eve's directory that anyone may write to, and Noah's own directory inside it that only he can open.
await as(eveStat, 'mkdir -m 0777 "$1" && echo eve > "$1/eve-file"', '/tmp/eve-shared');
await as(noahStat, 'mkdir -m 0700 "$1/noah-private" && echo noah > "$1/noah-private/noah-file" && echo noah > /tmp/noah-top', '/tmp/eve-shared');
record('control: Noah left a directory inside Eve\'s and a file at the top', (await lstat('/tmp/eve-shared/noah-private').catch(() => null))?.uid === noahStat.uid && (await stillThere('/tmp/noah-top')));
await as(eveStat, 'mkdir -m 0755 "$1/mine-and-closed" && mkdir -p -m 0700 "$1/mine-and-closed/inner" && chmod 000 "$1/mine-and-closed/inner" "$1/mine-and-closed"', '/tmp/eve-shared');
const eveBlocked = await call({ kind: 'release', bindingId: eve });
record('Eve\'s release stays open while Noah\'s directory is inside hers, and says so', eveBlocked.ok && eveBlocked.result.deleted === false && (await readdir('/data')).includes(eve), JSON.stringify(eveBlocked).slice(0, 160));
record('and everything else of hers is gone', !(await stillThere('/tmp/eve-shared/eve-file')) && !(await stillThere('/tmp/eve-shared/mine-and-closed')));
const firstLogouts = await callsOf(eve);
const eveAgain = await call({ kind: 'release', bindingId: eve });
record('asked again, it is still open', eveAgain.ok && eveAgain.result.deleted === false);
record('and it does not sign out a second time', firstLogouts > 0 && (await callsOf(eve)) === firstLogouts, `${firstLogouts} then ${await callsOf(eve)}`);
record('its report is the first attempt\'s, not a failed second sign-out', JSON.stringify(eveAgain.result?.logout) === JSON.stringify(eveBlocked.result?.logout), JSON.stringify([eveAgain.result?.logout, eveBlocked.result?.logout]));
record('Noah\'s cleanup finds what he left inside Eve\'s directory, and his file at the top', (await clearLeftovers('/tmp', person(noahStat))) === true
  && !(await stillThere('/tmp/eve-shared/noah-private')) && !(await stillThere('/tmp/noah-top')) && (await stillThere('/tmp/eve-shared')));
await asNode(noahStat, deepTree, '/data/' + noah + '/home/deep');
record('control: Noah\'s place holds a tree deeper than PATH_MAX', await stillThere(`/data/${noah}/home/deep`));
const eveDone = await call({ kind: 'release', bindingId: eve });
record('with Noah\'s directory gone, Eve\'s release finishes', eveDone.ok && eveDone.result.deleted === true && !(await stillThere('/tmp/eve-shared')) && !(await readdir('/data')).includes(eve), JSON.stringify(eveDone).slice(0, 160));
const noahDone = await call({ kind: 'release', bindingId: noah });
record('Noah\'s release takes the deep tree in his place and says so', noahDone.ok && noahDone.result.deleted === true && !(await readdir('/data')).includes(noah), JSON.stringify(noahDone).slice(0, 160));
record('root made nothing in /data while doing it', (await readdir('/data')).length === 0);

// A second person swaps entries of a released person's directories, which she opened to everyone, for links to a third person's files
// while root removes the binding (review of #952, P1). A removal that goes by path (`rm -r`, Node's `fs.rm`) follows a link swapped in
// after it looked and root deletes what is behind it; the walk of tree.ts checks every directory it stands in, so nothing is lost.
// Before the fix, root deleted the third person's files in 30 of 30 rounds of this.
const kai = randomUUID();
const raf = randomUUID();
for (const bindingId of [kai, raf]) await call({ kind: 'bind', bindingId });
const kaiStat = await lstat(`/data/${kai}`);
const rafStat = await lstat(`/data/${raf}`);
const racer = `
const fs = require('node:fs');
const [dir, target, ms] = process.argv.slice(1);
const end = Date.now() + Number(ms);
while (Date.now() < end) {
  for (let i = 0; i < 40; i += 1) {
    const place = dir + '/x' + i;
    const aside = dir + '/h' + i;
    try { fs.renameSync(place, aside); fs.symlinkSync(target, place); } catch { /* it is being removed */ }
    try { fs.unlinkSync(place); fs.renameSync(aside, place); } catch { /* and so is this */ }
  }
}
`;
const raceRounds = 8;
let lostRounds = 0;
let stoppedFirst = 0;
let notFinished = 0;
for (let round = 0; round < raceRounds; round += 1) {
  await runFixed('/bin/sh', ['-c', 'mkdir -p "$1/home/keep"; i=0; while [ $i -lt 100 ]; do echo kept-$i > "$1/home/keep/f$i"; i=$((i+1)); done', 'sh', `/data/${kai}`],
    { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 20_000, person: person(kaiStat) });
  const keep = `/data/${kai}/home/keep`;
  const before = (await readdir(keep)).length;
  const ola = randomUUID();
  await call({ kind: 'bind', bindingId: ola });
  const olaStat = await lstat(`/data/${ola}`);
  // Her CLI, before it ended: many directories of files, and her place opened to everyone.
  await as(olaStat, 'r="$1/race"; mkdir -m 0777 "$r"; i=0; while [ $i -lt 40 ]; do mkdir -m 0777 "$r/x$i"; j=0; while [ $j -lt 60 ]; do : > "$r/x$i/f$j"; j=$((j+1)); done; i=$((i+1)); done; chmod 0777 "$1"', `/data/${ola}`);
  const swapping = spawn(process.execPath, ['-e', racer, `/data/${ola}/race`, keep, '2000'], { uid: rafStat.uid, gid: rafStat.gid, env: { PATH: '/usr/bin:/bin' }, cwd: '/', stdio: 'ignore' });
  const swapped = new Promise((done) => swapping.on('exit', done));
  await pause(100);
  // The walk stops when it finds a directory it stood in swapped (it then says it is not finished, and a release stays open and asks
  // again); it never goes on into what the swap points at.
  const first = await removeBinding('/data', ola);
  await swapped;
  if ((await readdir(keep)).length < before) lostRounds += 1;
  if (!first) {
    // Once nobody swaps any more, the same removal finishes.
    stoppedFirst += 1;
    if (!await removeBinding('/data', ola) || await lstat(`/data/${ola}`).then(() => true, () => false)) notFinished += 1;
  }
}
record(`root removing a binding while another person swaps its entries for links deletes nothing of a third person's (${raceRounds} rounds)`, lostRounds === 0, `${lostRounds} rounds lost files`);
record('and a removal the swapping interrupted finishes at the next try, once it has stopped', notFinished === 0, `${notFinished} of ${stoppedFirst} did not`);
for (const bindingId of [kai, raf]) await call({ kind: 'release', bindingId });
record('root made nothing in /data while doing it either', (await readdir('/data')).length === 0);

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
