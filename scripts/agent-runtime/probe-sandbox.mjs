// The per-run sandbox of the CLIs' own tools (#1437, RT-5), proved in a container with the runtime's real settings: root with only the six
// capabilities, a read-only root filesystem, no-new-privileges, the 1 GiB /scratch tmpfs, no network. It runs the real supervisor code (not
// its main, which needs a host with ptrace_scope of 1 or higher) with the real sandbox (Linux Landlock) and the TEST ONLY fake CLIs, which run
// each planned command through the shell they were given, as the real CLIs do (observed with Claude Code 2.1.285 and Codex 0.160.1 against a
// local mock model, 2026-11-13). From a run's own shell it tries to reach what it must not, and checks the limits and the scratch.
// scripts/check_runtime_sandbox.sh runs it.
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { callSupervisor, scanSupervisorText } from '/opt/flux-runtime/packages/runtime-protocol/dist/index.js';
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
record('the tools are on only where Landlock forbids TCP (ABI 4, Linux 6.7)', found.setup.abi >= 4, found.setup.abi);

// A Unix socket by path, which Landlock does not see (as a CLI's own messaging socket in its TMPDIR): the tools must not reach it either.
const unixPath = `/tmp/probe-${randomUUID()}.sock`;
const unixServer = net.createServer((socket) => socket.end('UNIX-REACHED\n'));
await new Promise((done) => unixServer.listen(unixPath, done));
await chmod(unixPath, 0o777);

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
  ['the init\'s and every other process\'s environment', 'for p in /proc/[0-9]*; do cat $p/environ 2>/dev/null; done | tr "\\0" "\\n" | grep -c -E "FLUX_RUN_TOKEN|SLOT_SECRET|login"'],
  ['the shared /tmp and the tools volume', 'echo x > /tmp/ada-left; ls /tmp; ls /opt/flux-runtime'],
  ['a link out of the scratch', `ln -s /data/${ada}/claude/.credentials.json link; ln /data/${ada}/claude/.credentials.json hard; ls`],
  ['TCP to Flux\'s /mcp stand-in and to the supervisor', `node -e 'for (const port of [${mcpPort}, ${supervisorPort}]) require("net").connect(port, "127.0.0.1").on("connect", () => console.log("CONNECTED", port)).on("error", (e) => console.log(e.code))'`],
  ['listening on a port', 'node -e \'require("net").createServer().listen(8099, "127.0.0.1").on("listening", () => { console.log("LISTENING"); process.exit(0); }).on("error", (e) => console.log(e.code))\''],
  ['UDP and DNS (Landlock covers TCP only)', 'node -e \'require("dgram").createSocket("udp4").on("error", (e) => console.log("UDP", e.code)).send("x", 53, "127.0.0.11", (e) => console.log("SENT", e ? e.code : "ok"))\'; '
    + 'node -e \'require("dns").lookup("example.com", (e) => console.log("DNS", e ? e.code : "resolved"))\'; '
    + 'python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM)" 2>&1 | tail -1'],
  ['a Unix socket by its path', `node -e 'require("net").connect(${JSON.stringify(unixPath)}).on("data", (d) => console.log(String(d).trim())).on("error", (e) => console.log("UNIX", e.code))'; `
    + `python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(unixPath)}); print(s.recv(64))" 2>&1 | tail -1`],
  ['what any process\'s command line says (it is readable)', 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " " | grep -c -E "logi[n]-|SLOT_SECRE[T]|FLUX_RUN_TOKE[N]"'],
  ['a pipe between programs still works (socketpair)', 'printf "a\\nb\\n" | sort -r | tr -d "\\n"; echo; python3 -c "import socket; a, b = socket.socketpair(); a.send(b\'ok\'); print(b.recv(2).decode())"'],
  ['an HTML page, a CSV and a PDF made in the scratch', 'printf "<h1>Report</h1><p>Lamp sensor</p>" > report.html && printf "a,b\\n1,2\\n" > table.csv'
    + ' && printf "%%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\\ntrailer<</Root 1 0 R>>\\n%%%%EOF\\n" > report.pdf && ls report.html table.csv report.pdf && head -c 8 report.pdf'],
  ['the toolbox (#1437): HTML and Markdown to PDF with pandoc and typst, a spreadsheet, a Word document and a chart with Python, jq, ripgrep and vips',
    'printf "# Lamp sensor\\n\\nFails below **5 lux**.\\n" > notes.md'
    + ' && pandoc report.html -o from-html.pdf --pdf-engine=typst && pandoc notes.md -o from-md.pdf --pdf-engine=typst'
    + ' && python3 -c "import pandas as pd, docx, matplotlib; matplotlib.use(\'Agg\'); import matplotlib.pyplot as plt;'
    + ' df = pd.read_csv(\'table.csv\'); df.to_excel(\'table.xlsx\', index=False); d = docx.Document(); d.add_paragraph(\'Lamp\'); d.save(\'notes.docx\');'
    + ' plt.plot([1, 2, 3]); plt.savefig(\'chart.png\')"'
    + ' && echo \'{"a": 1}\' | jq -c . && rg -c Lamp notes.md && vips copy chart.png chart.webp'
    + ' && for f in from-html.pdf from-md.pdf; do head -c 5 $f; echo; done && ls table.xlsx notes.docx chart.png chart.webp'],
  ['what the toolbox costs: the peak memory of pandoc with typst and of Python with pandas and matplotlib, in KiB',
    'python3 -c "import resource, subprocess, time; t = time.time(); subprocess.run([\'pandoc\', \'report.html\', \'-o\', \'m.pdf\', \'--pdf-engine=typst\'], check=True);'
    + ' print(\'pandoc+typst\', resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, round(time.time() - t, 2))";'
    + ' python3 -c "import resource, time; t = time.time(); import pandas, matplotlib; matplotlib.use(\'Agg\'); import matplotlib.pyplot as plt; plt.plot([1]); plt.savefig(\'m.png\');'
    + ' print(\'python+pandas+matplotlib\', resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, round(time.time() - t, 2))"'],
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
const at = (prefix) => probes.findIndex(([name]) => name.startsWith(prefix));
// A socket is refused by the seccomp filter (EAFNOSUPPORT) before Landlock's TCP rule (EACCES) is even asked.
const refusedNet = /EAFNOSUPPORT|EACCES|Address family not supported|Permission denied/;
const tcp = at('TCP to');
record(`refused: ${probes[tcp][0]}`, (out(tcp).match(/EAFNOSUPPORT|EACCES/g) ?? []).length === 2 && !out(tcp).includes('CONNECTED'), shown(tcp));
const listen = at('listening');
record(`refused: ${probes[listen][0]}`, refusedNet.test(out(listen)) && !/LISTENING/.test(out(listen)), shown(listen));
const udp = at('UDP');
record(`refused: ${probes[udp][0]}`, /UDP EAFNOSUPPORT|SENT EAFNOSUPPORT/.test(out(udp)) && /DNS /.test(out(udp)) && !/DNS resolved|SENT ok/.test(out(udp))
  && /Address family not supported|OSError/.test(out(udp)), shown(udp));
const unix = at('a Unix socket');
record(`refused: ${probes[unix][0]}`, !out(unix).includes('UNIX-REACHED') && /UNIX EAFNOSUPPORT/.test(out(unix)), shown(unix));
// (The pattern is written so that the shell's own command line, which holds it, does not match it.)
const cmdline = at('what any process');
record(`no secret in ${probes[cmdline][0]}`, out(cmdline).trim() === '0', shown(cmdline));
const pipe = at('a pipe between');
record(probes[pipe][0], /^ba$/m.test(out(pipe)) && /^ok$/m.test(out(pipe)), shown(pipe));
const made = at('an HTML page');
record(probes[made][0], outs[made]?.exit === 0 && out(made).includes('%PDF-1.4'), shown(made));
const tool = at('the toolbox');
record(probes[tool][0], outs[tool]?.exit === 0 && (out(tool).match(/%PDF-/g) ?? []).length === 2 && /notes\.docx/.test(out(tool)) && /chart\.webp/.test(out(tool)) && /\{"a":1\}/.test(out(tool)), shown(tool));
const cost = tool + 1;
record(probes[cost][0], outs[cost]?.exit === 0 && /pandoc\+typst \d+/.test(out(cost)), shown(cost));
for (const line of out(cost).trim().split('\n')) console.log(`MEASURE toolbox ${line} (KiB peak, seconds; one CPU)`);
const big = at('a file larger');
record(`limited: ${probes[big][0]}`, /File too large|File size limit exceeded/i.test(out(big)) && !/^300000000$/m.test(out(big)), shown(big));
const bomb = at('a fork bomb');
record(`limited and killed: ${probes[bomb][0]}`, !out(bomb).includes('all started') && (outs[bomb]?.exit === 137 || /Resource temporarily unavailable/i.test(out(bomb))), shown(bomb));
record(probes[bomb + 1][0], out(bomb + 1).trim() === 'alive', shown(bomb + 1));
const hog = at('a memory hog');
record(`killed: ${probes[hog][0]}`, outs[hog]?.exit === 137 || /exit 137|Killed/.test(out(hog)), shown(hog));
record(probes[hog + 1][0], out(hog + 1).trim() === 'alive', shown(hog + 1));
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
// The CLI's own login never leaves through Flux (coordinator decision on #1437): the supervisor says whether a text holds one of its values.
const scan = (bindingId, runId, text) => scanSupervisorText(target, { bindingId, runId, text });
const adaLogin = `claude-login-${ada.slice(0, 8)}`;
const foundIt = await scan(ada, holdRun, `Here is the report.\n${adaLogin}\nThanks`);
record('a text with the run\'s CLI login is found', foundIt.ok && foundIt.found === true, JSON.stringify(foundIt));
const clean = await scan(ada, holdRun, 'An ordinary report about the lamp sensor, nothing secret in it at all.');
record('an ordinary text is not', clean.ok && clean.found === false, JSON.stringify(clean));
const notHers = await scan(bo, holdRun, adaLogin);
record('another person cannot ask about her run', !notHers.ok && notHers.code === 'not_running', JSON.stringify(notHers));
await holding;
const ended = await scan(ada, holdRun, adaLogin);
record('nor anyone once it ended', !ended.ok && ended.code === 'not_running', JSON.stringify(ended));

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
// Codex 0.160.1's exec_command takes the shell the model names: a command outside Flux's sandbox shell runs under the CLI's outer domain
// only. The run is killed at once with every process of the person, also one that left the CLI's process group.
const escapeRun = randomUUID();
await writeAs(ada, `/data/${ada}/codex/fake-run.json`, JSON.stringify({ calls: [
  { name: 'exec_command', args: { shell: '/bin/sh', cmd: `setsid sh -c 'sleep 3; echo escaped > /data/${ada}/codex/escaped' & sleep 4` } },
  { name: 'flux_list_contexts' }] }));
const escapeStarted = Date.now();
const escaped = await call({ kind: 'run', bindingId: ada, client: 'codex', runId: escapeRun, prompt: 'Probe.', runToken: token(), tools: ['flux_list_contexts'], caps });
const escapeMs = Date.now() - escapeStarted;
await new Promise((done) => setTimeout(done, 4000));
record('a command in a shell the model named stops the run at once, and nothing it left behind lives on',
  escaped.ok && escaped.result.outcome === 'local_tool' && escaped.result.answer === null && !(await lstat(`/data/${ada}/codex/escaped`).catch(() => null)),
  `${escapeMs} ms ${JSON.stringify(escaped).slice(0, 300)}`);
console.log(`MEASURE escaped shell run ended after ${escapeMs} ms`);
record('its login stays', (await readFile(`/data/${ada}/codex/auth.json`, 'utf8').catch(() => '')).includes('codex-login-'));
record('every scratch is gone', (await readdir('/scratch')).length === 0, (await readdir('/scratch')).join());

server.close();
mcp.close();
unixServer.close();
const failed = results.filter((entry) => !entry.ok);
console.log(failed.length ? `\nSandbox check FAILED: ${failed.length} of ${results.length}` : `\nSandbox check passed: ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
