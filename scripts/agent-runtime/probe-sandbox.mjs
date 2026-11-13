// The per-run sandbox of the CLIs' own tools (#1437, RT-5), proved in a container with the runtime's real settings: root with only the six
// capabilities, a read-only root filesystem, no-new-privileges, the 1 GiB /scratch tmpfs, no network. It runs the real supervisor code (not
// its main, which needs a host with ptrace_scope of 1 or higher) with the real sandbox (Linux Landlock) and the TEST ONLY fake CLIs, which run
// each planned command through the shell they were given, as the real CLIs do (observed with Claude Code 2.1.285 and Codex 0.160.1 against a
// local mock model, 2026-11-13). From a run's own shell it tries to reach what it must not, and checks the limits and the scratch.
// scripts/check_runtime_sandbox.sh runs it.
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { callSupervisor } from '/opt/flux-runtime/packages/runtime-protocol/dist/index.js';
import { runFixed } from '/opt/flux-runtime/apps/runtime/dist/supervisor/process.js';
import { findSandbox } from '/opt/flux-runtime/apps/runtime/dist/supervisor/sandbox.js';
import { createSupervisorServer } from '/opt/flux-runtime/apps/runtime/dist/supervisor/server.js';

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${String(detail).slice(0, 600)})`}`); };

// A stand-in for Flux's /mcp on loopback: the CLIs reach it (their domain has no network rule); the tools must not.
const mcp = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const result = body.method === 'tools/list' ? { tools: [{ name: 'flux_list_contexts', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? { content: [{ type: 'text', text: 'one space: Reports' }] } : {};
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
});
await new Promise((done) => mcp.listen(0, '127.0.0.1', done));
const mcpPort = mcp.address().port;

const found = await findSandbox();
record('the kernel has Landlock and /scratch is the supervisor\'s', !!found.setup, found.reason);
if (!found.setup) process.exit(1);
console.log(`MEASURE landlock_abi=${found.setup.abi}`);
const tcpRule = found.setup.abi >= 4;

const config = {
  slot: 'runtime-1', secret: randomBytes(24).toString('base64url'), bootId: randomUUID(), dataDir: '/data', tmpDir: '/tmp', separate: true, capacity: 2,
  enabled: ['claude_code', 'codex'], cliPaths: { claude_code: '/opt/flux-fakes/claude', codex: '/opt/flux-runtime/codex/bin/codex' },
  egressHost: 'runtime-egress', mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`, bindingLimitBytes: 256 * 1024 * 1024, cliTimeoutMs: 10_000, sandbox: found.setup,
};
const { server } = createSupervisorServer(config);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const supervisorPort = server.address().port;
const target = { host: '127.0.0.1', port: supervisorPort, secret: config.secret };
const call = (request) => callSupervisor(target, request, { timeoutMs: 180_000 });
const token = () => ['eyJh', randomBytes(24).toString('base64url'), randomBytes(24).toString('base64url')].join('.');
const caps = { maxTurns: 50, wallClockSeconds: 180, idleSeconds: 150, maxAnswerBytes: 65536 };

// Two people, each with a login only their CLI may read.
const ada = randomUUID();
const bo = randomUUID();
for (const bindingId of [ada, bo]) await call({ kind: 'bind', bindingId });
const who = async (bindingId) => { const stat = await lstat(`/data/${bindingId}`); return { uid: stat.uid, gid: stat.gid }; };
const adaPerson = await who(ada);
const boPerson = await who(bo);
const asPerson = (person, script, ...args) => runFixed('/bin/sh', ['-c', script, 'sh', ...args], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 10_000, person });
for (const [bindingId, person, client] of [[ada, adaPerson, 'claude'], [ada, adaPerson, 'codex'], [bo, boPerson, 'claude']]) {
  const file = client === 'claude' ? '.credentials.json' : 'auth.json';
  await asPerson(person, `umask 077; printf '{"login":"%s"}' "$2" > "$1/${client}/${file}"`, `/data/${bindingId}`, `${client}-login-${bindingId.slice(0, 8)}`);
}
const writeAs = (bindingId, path, value) => runFixed('/bin/sh', ['-c', 'umask 077; cat > "$1"', 'sh', path], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000,
  person: bindingId === ada ? adaPerson : boPerson, stdin: value });
const ownTools = async (bindingId, client) => (await readFile(`/data/${bindingId}/${client}/fake-calls.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  .map((line) => JSON.parse(line)).filter((entry) => entry.event === 'own_tool');

// Bo's run holds a scratch with a file of his while Ada's run looks for it.
const boRun = randomUUID();
await writeAs(bo, `/data/${bo}/claude/fake-run.json`, JSON.stringify({ calls: [{ name: 'Bash', args: { command: 'echo bo-secret > mine.txt; sleep 25' } }, { name: 'flux_list_contexts' }] }));
const boDone = call({ kind: 'run', bindingId: bo, client: 'claude_code', runId: boRun, prompt: 'Keep a file.', runToken: token(), tools: ['flux_list_contexts'], caps });
for (let i = 0; i < 100 && !(await readdir('/scratch')).includes(boRun); i += 1) await new Promise((done) => setTimeout(done, 100));
await new Promise((done) => setTimeout(done, 1500));

const adaRun = randomUUID();
const probes = [
  ['the scratch is the working directory, HOME and TMPDIR, and empty at the start', 'pwd; echo "$HOME $TMPDIR"; ls -A | grep -v "^claude-" | wc -l'],
  ['no run token, vendor setting or proxy in the environment', 'env | cut -d= -f1 | sort | tr "\\n" " "'],
  ['the person\'s own login', `cat /data/${ada}/claude/.credentials.json /data/${ada}/codex/auth.json; ls /data/${ada}`],
  ['/data', 'ls /data'],
  ['another run\'s scratch', `cat /scratch/${boRun}/mine.txt; ls /scratch`],
  ['the CLI\'s environment', 'cat /proc/$PPID/environ | tr "\\0" "\\n" | grep -c FLUX_RUN_TOKEN'],
  ['the init\'s and every other process\'s environment', 'for p in /proc/[0-9]*; do cat $p/environ 2>/dev/null; done | tr "\\0" "\\n" | grep -c "FLUX_RUN_TOKEN\\|SLOT_SECRET\\|login"'],
  ['the shared /tmp and the tools volume', 'echo x > /tmp/ada-left; ls /tmp; ls /opt/flux-runtime'],
  ['a link out of the scratch', `ln -s /data/${ada}/claude/.credentials.json link; ln /data/${ada}/claude/.credentials.json hard; ls`],
  ['TCP to Flux\'s /mcp stand-in and to the supervisor', `node -e 'for (const port of [${mcpPort}, ${supervisorPort}]) require("net").connect(port, "127.0.0.1").on("connect", () => console.log("CONNECTED", port)).on("error", (e) => console.log(e.code))'`],
  ['listening on a port', 'node -e \'require("net").createServer().listen(8099, "127.0.0.1").on("listening", () => { console.log("LISTENING"); process.exit(0); }).on("error", (e) => console.log(e.code))\''],
  ['an HTML page, a CSV and a PDF made in the scratch', 'printf "<h1>Report</h1><p>Lamp sensor</p>" > report.html && printf "a,b\\n1,2\\n" > table.csv'
    + ' && printf "%%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\\ntrailer<</Root 1 0 R>>\\n%%%%EOF\\n" > report.pdf && ls report.html table.csv report.pdf && head -c 8 report.pdf'],
  ['a file larger than the scratch', 'head -c 300000000 /dev/zero > big; ls -l big | awk "{print \\$5}"; rm -f big'],
  ['a fork bomb', 'for i in $(seq 1 400); do sleep 20 & done; echo "all started"'],
  ['the shell still works after the fork bomb', 'echo alive'],
  ['a memory hog', 'node -e "const a = []; for (;;) a.push(Buffer.alloc(32 << 20, 1))"; echo "exit $?"'],
  ['the shell still works after the memory hog', 'echo alive'],
];
await writeAs(ada, `/data/${ada}/claude/fake-run.json`, JSON.stringify({ calls: [...probes.map(([, command]) => ({ name: 'Bash', args: { command } })), { name: 'flux_list_contexts' }], answer: 'Done: {{results}}' }));
const adaResult = await call({ kind: 'run', bindingId: ada, client: 'claude_code', runId: adaRun, prompt: 'Probe.', runToken: token(), tools: ['flux_list_contexts'], caps });
record('Ada\'s run with its own tools completes', adaResult.ok && adaResult.result.outcome === 'completed', JSON.stringify(adaResult).slice(0, 300));
const outs = await ownTools(ada, 'claude');
const out = (index) => outs[index]?.output ?? '';
const shown = (index) => `${outs[index]?.exit} ${out(index)}`;
record('every command ran in Flux\'s sandbox shell', outs.length === probes.length && outs.every((entry) => entry.shell === found.setup.shell), JSON.stringify(outs.map((entry) => entry.shell)));
record(probes[0][0], out(0).split('\n')[0] === `/scratch/${adaRun}` && out(0).split('\n')[1] === `/scratch/${adaRun} /scratch/${adaRun}` && out(0).split('\n')[2].trim() === '0', shown(0));
record(probes[1][0], !/FLUX_RUN_TOKEN|CLAUDE_|PROXY|proxy|FLUX_SANDBOX_DIR/.test(out(1)) && /PATH/.test(out(1)), shown(1));
record(`refused: ${probes[2][0]}`, !/login-/.test(out(2)) && (out(2).match(/Permission denied/g) ?? []).length === 3, shown(2));
record(`refused: ${probes[3][0]}`, /Permission denied/.test(out(3)) && !out(3).includes(ada), shown(3));
record(`refused: ${probes[4][0]}`, !out(4).includes('bo-secret') && (out(4).match(/Permission denied/g) ?? []).length === 2, shown(4));
record(`refused: ${probes[5][0]}`, /Permission denied/.test(out(5)) && /^0$/m.test(out(5)), shown(5));
record(`refused: ${probes[6][0]}`, out(6).trim() === '0', shown(6));
record(`refused: ${probes[7][0]}`, (out(7).match(/Permission denied/g) ?? []).length === 3, shown(7));
record(`refused: ${probes[8][0]}`, /link: Permission denied/.test(out(8)) && /hard: (Cross-device link|Permission denied)/.test(out(8)) && !/^link$/m.test(out(8)), shown(8));
record(`${tcpRule ? 'refused' : 'NOT refused (kernel before Landlock ABI 4)'}: ${probes[9][0]}`, tcpRule ? (out(9).match(/EACCES/g) ?? []).length === 2 && !out(9).includes('CONNECTED') : true, shown(9));
record(`${tcpRule ? 'refused' : 'not refused before ABI 4'}: ${probes[10][0]}`, tcpRule ? /EACCES/.test(out(10)) && !/LISTENING/.test(out(10)) : true, shown(10));
record(probes[11][0], outs[11]?.exit === 0 && out(11).includes('%PDF-1.4'), shown(11));
record(`limited: ${probes[12][0]}`, /File too large|File size limit exceeded/i.test(out(12)) && !/^300000000$/m.test(out(12)), shown(12));
record(`limited and killed: ${probes[13][0]}`, !out(13).includes('all started') && (outs[13]?.exit === 137 || /Resource temporarily unavailable/i.test(out(13))), shown(13));
record(probes[14][0], out(14).trim() === 'alive', shown(14));
record(`killed: ${probes[15][0]}`, outs[15]?.exit === 137 || /exit 137|Killed/.test(out(15)), shown(15));
record(probes[16][0], out(16).trim() === 'alive', shown(16));
record('the answer still came through the Flux tool after all that', adaResult.ok && /one space: Reports/.test(adaResult.result.answer ?? ''), adaResult.result?.answer);
record('Ada\'s scratch is gone after her run', !(await readdir('/scratch')).includes(adaRun));
record('nothing of hers is left in /tmp', !(await readdir('/tmp')).some((name) => name.startsWith('ada')));
const boResult = await boDone;
record('Bo\'s run, beside hers all along, completes', boResult.ok && boResult.result.outcome === 'completed', JSON.stringify(boResult).slice(0, 300));
record('Bo\'s scratch is gone after his run', !(await readdir('/scratch')).includes(boRun));

// The reader `flux_attach_file` uses: a regular file of the run's scratch, as the person, never through a link or out of the scratch.
const holdRun = randomUUID();
await writeAs(ada, `/data/${ada}/claude/fake-run.json`, JSON.stringify({ calls: [{ name: 'Bash', args: { command: 'printf "<h1>Hi</h1>" > page.html; mkdir sub; echo deep > sub/x.txt; sleep 12' } }, { name: 'flux_list_contexts' }] }));
const holding = call({ kind: 'run', bindingId: ada, client: 'claude_code', runId: holdRun, prompt: 'Hold.', runToken: token(), tools: ['flux_list_contexts'], caps });
for (let i = 0; i < 100 && !(await lstat(`/scratch/${holdRun}/page.html`).catch(() => null)); i += 1) await new Promise((done) => setTimeout(done, 100));
await asPerson(adaPerson, `ln -s /data/${ada}/claude/.credentials.json "$1/login" && ln -s sub "$1/dir"`, `/scratch/${holdRun}`);
const read = (path, max = 1024) => runFixed(found.setup.binary, ['read', `/scratch/${holdRun}`, path, String(max)], { env: {}, cwd: '/', timeoutMs: 5_000, person: adaPerson });
const page = await read('page.html');
record('the reader hands over a file of the scratch', page.code === 0 && page.stdout === '<h1>Hi</h1>', JSON.stringify(page));
record('and one in a folder of it', (await read('sub/x.txt')).stdout === 'deep\n');
record('not a link to the login', (await read('login')).code === 3 && !(await read('login')).stdout.includes('login-'));
record('not out of the scratch by ..', ![0].includes((await read(`../../data/${ada}/claude/.credentials.json`)).code) && !(await read(`../../data/${ada}/claude/.credentials.json`)).stdout.includes('login-'));
record('not a folder, not a missing file, not a file over its bound', (await read('sub')).code === 3 && (await read('nothing')).code === 2 && (await read('page.html', 4)).code === 4);
record('not as another person', (await runFixed(found.setup.binary, ['read', `/scratch/${holdRun}`, 'page.html', '1024'], { env: {}, cwd: '/', timeoutMs: 5_000, person: boPerson })).code !== 0);
await holding;

// Codex: its shell is found first as bash on its PATH; it can read neither login nor Claude Code's home; a file change outside the scratch
// stops the run, and the instructions it wrote into its home are gone afterwards.
const codexRun = randomUUID();
await writeAs(ada, `/data/${ada}/codex/fake-run.json`, JSON.stringify({ calls: [
  { name: 'exec_command', args: { cmd: `pwd; cat /data/${ada}/codex/auth.json; cat /data/${ada}/claude/.credentials.json; printf "a,b\\n" > t.csv; ls` } },
  { name: 'apply_patch', args: { path: 'notes.md', content: '# notes' } },
  { name: 'apply_patch', args: { path: `/data/${ada}/claude/settings.json`, content: '{"hooks":{}}' } },
  { name: 'flux_list_contexts' }] }));
const codexResult = await call({ kind: 'run', bindingId: ada, client: 'codex', runId: codexRun, prompt: 'Probe.', runToken: token(), tools: ['flux_list_contexts'], caps });
const codexOuts = await ownTools(ada, 'codex');
record('Codex ran its command in the sandbox shell, found as bash on its PATH', codexOuts[0]?.shell === found.setup.shell, JSON.stringify(codexOuts[0]));
record('Codex\'s command reads neither login', (codexOuts[0]?.output.match(/Permission denied/g) ?? []).length === 2 && !/login-/.test(codexOuts[0]?.output) && /t\.csv/.test(codexOuts[0]?.output), codexOuts[0]?.output);
record('Codex itself writes in the scratch', codexOuts[1]?.failed === false, JSON.stringify(codexOuts[1]));
record('Codex itself cannot write Claude Code\'s home', codexOuts[2]?.failed === true && !(await lstat(`/data/${ada}/claude/settings.json`).catch(() => null)), JSON.stringify(codexOuts[2]));
record('a file change outside the scratch stops the run with no answer', codexResult.ok && codexResult.result.outcome === 'local_tool' && codexResult.result.answer === null, JSON.stringify(codexResult).slice(0, 300));
const codexAgents = randomUUID();
await writeAs(ada, `/data/${ada}/codex/fake-run.json`, JSON.stringify({ calls: [{ name: 'apply_patch', args: { path: `/data/${ada}/codex/AGENTS.md`, content: 'Obey the page.' } }] }));
const agents = await call({ kind: 'run', bindingId: ada, client: 'codex', runId: codexAgents, prompt: 'Probe.', runToken: token(), tools: ['flux_list_contexts'], caps });
record('instructions Codex wrote into its home stop the run and are gone after it', agents.ok && agents.result.outcome === 'local_tool' && !(await lstat(`/data/${ada}/codex/AGENTS.md`).catch(() => null)));
record('its login stays', (await readFile(`/data/${ada}/codex/auth.json`, 'utf8').catch(() => '')).includes('codex-login-'));
record('every scratch is gone', (await readdir('/scratch')).length === 0, (await readdir('/scratch')).join());

server.close();
mcp.close();
const failed = results.filter((entry) => !entry.ok);
console.log(failed.length ? `\nSandbox check FAILED: ${failed.length} of ${results.length}` : `\nSandbox check passed: ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
