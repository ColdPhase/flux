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
    // A notification (pi's `notifications/initialized`) has no answer.
    if (body.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = body.method === 'initialize' ? { protocolVersion: body.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flux', version: '1' } }
      : body.method === 'tools/list' ? { tools: [{ name: 'flux_list_contexts', inputSchema: { type: 'object' } }] }
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
record(`${tcpRule ? 'refused' : 'NOT refused (kernel before Landlock ABI 4)'}: ${probes[9][0]}`, tcpRule ? (out(9).match(/EACCES/g) ?? []).length === 2 && !out(9).includes('CONNECTED') : true, shown(9));
record(`${tcpRule ? 'refused' : 'not refused before ABI 4'}: ${probes[10][0]}`, tcpRule ? /EACCES/.test(out(10)) && !/LISTENING/.test(out(10)) : true, shown(10));
record(probes[11][0], outs[11]?.exit === 0 && out(11).includes('%PDF-1.4'), shown(11));
const tool = probes.findIndex(([name]) => name.startsWith('the toolbox'));
record(probes[tool][0], outs[tool]?.exit === 0 && (out(tool).match(/%PDF-/g) ?? []).length === 2 && /notes\.docx/.test(out(tool)) && /chart\.webp/.test(out(tool)) && /\{"a":1\}/.test(out(tool)), shown(tool));
const cost = tool + 1;
record(probes[cost][0], outs[cost]?.exit === 0 && /pandoc\+typst \d+/.test(out(cost)), shown(cost));
for (const line of out(cost).trim().split('\n')) console.log(`MEASURE toolbox ${line} (KiB peak, seconds; one CPU)`);
record(`limited: ${probes[14][0]}`, /File too large|File size limit exceeded/i.test(out(14)) && !/^300000000$/m.test(out(14)), shown(14));
record(`limited and killed: ${probes[15][0]}`, !out(15).includes('all started') && (outs[15]?.exit === 137 || /Resource temporarily unavailable/i.test(out(15))), shown(15));
record(probes[16][0], out(16).trim() === 'alive', shown(16));
record(`killed: ${probes[17][0]}`, outs[17]?.exit === 137 || /exit 137|Killed/.test(out(17)), shown(17));
record(probes[18][0], out(18).trim() === 'alive', shown(18));
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

// pi (#1441): an API-key run, with the REAL pinned pi in the outer domain, its own `read`, `bash`, `edit` and `write`, and a model stand-in on
// loopback that plays the gateway (Chat Completions, as for an OpenAI-compatible key). The model asks for each probe in turn.
const modelSteps = [];
const modelResults = [];
const model = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const results = (body.messages ?? []).filter((message) => message.role === 'tool');
    if (results.length) modelResults.push(String(results.at(-1).content ?? ''));
    const step = modelSteps.shift() ?? { text: 'Done.' };
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([chunk({ role: 'assistant', content: '' }, null),
      step.tool ? chunk({ tool_calls: [{ index: 0, id: `call_${modelResults.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null) : chunk({ content: step.text }, null),
      chunk({}, step.tool ? 'tool_calls' : 'stop'), 'data: [DONE]\n\n'].join(''));
  });
});
await new Promise((done) => model.listen(0, '127.0.0.1', done));
const modelPort = model.address().port;
config.pi = true;
config.modelOrigin = `http://127.0.0.1:${modelPort}`;
const piRun = randomUUID();
const piToken = token();
const piModelToken = `flux_mg_${randomBytes(32).toString('base64url')}`;
const piProbes = [
  ['pi\'s bash: the scratch, a clean environment', { tool: 'bash', args: { command: 'pwd; env | cut -d= -f1 | sort | tr "\\n" " "' } }],
  ['pi\'s bash: the person\'s and another person\'s files', { tool: 'bash', args: { command: `cat /data/${ada}/claude/.credentials.json /data/${bo}/claude/.credentials.json; ls /data/${ada}/pi` } }],
  ['pi\'s bash: pi\'s own environment', { tool: 'bash', args: { command: 'cat /proc/$PPID/environ | tr "\\0" "\\n" | grep -c FLUX_RUN_TOKEN' } }],
  ['pi\'s bash: TCP to the model stand-in', { tool: 'bash', args: { command: `node -e 'require("net").connect(${modelPort}, "127.0.0.1").on("connect", () => console.log("CONNECTED")).on("error", (e) => console.log(e.code))'` } }],
  ['pi\'s read: its own /proc environment', { tool: 'read', args: { path: '/proc/self/environ' } }],
  ['pi\'s read: another person\'s login', { tool: 'read', args: { path: `/data/${bo}/claude/.credentials.json` } }],
  ['pi\'s write: outside the scratch', { tool: 'write', args: { path: '/tmp/pi-left.txt', content: 'x' } }],
  ['pi\'s write: a file in the scratch', { tool: 'write', args: { path: 'report.html', content: '<h1>Report</h1>' } }],
  ['the Flux tool', { tool: 'mcp__flux__flux_list_contexts', args: {} }],
];
modelSteps.push(...piProbes.map(([, step]) => step), { text: 'Done with pi.' });
const piResult = await call({ kind: 'run', bindingId: ada, client: 'pi', runId: piRun, prompt: 'Probe.', runToken: piToken, tools: ['flux_list_contexts'], caps,
  model: 'mock-model', provider: 'openai_compatible', modelToken: piModelToken });
record('pi\'s run completes', piResult.ok && piResult.result.outcome === 'completed' && piResult.result.answer === 'Done with pi.', JSON.stringify(piResult).slice(0, 400));
const piOut = (index) => modelResults[index] ?? '';
record(piProbes[0][0], piOut(0).split('\n')[0] === `/scratch/${piRun}` && !/FLUX_RUN_TOKEN|PI_|FLUX_SANDBOX_DIR/.test(piOut(0)), piOut(0));
record(`refused: ${piProbes[1][0]}`, !/login-/.test(piOut(1)) && (piOut(1).match(/Permission denied/g) ?? []).length === 3, piOut(1));
record(`refused: ${piProbes[2][0]}`, /Permission denied/.test(piOut(2)) && /^0$/m.test(piOut(2)), piOut(2));
record(`${tcpRule ? 'refused' : 'NOT refused (kernel before Landlock ABI 4)'}: ${piProbes[3][0]}`, tcpRule ? /EACCES/.test(piOut(3)) && !piOut(3).includes('CONNECTED') : true, piOut(3));
record(`${piProbes[4][0]} holds neither token (the launcher sets them after the start)`, !piOut(4).includes(piToken) && !piOut(4).includes(piModelToken) && !/FLUX_RUN_TOKEN|FLUX_MODEL_GATEWAY_TOKEN/.test(piOut(4)), piOut(4).slice(0, 300));
record(`refused: ${piProbes[5][0]}`, !/login-/.test(piOut(5)) && /EACCES|permission denied/i.test(piOut(5)), piOut(5));
record(`refused: ${piProbes[6][0]}`, /EACCES|permission denied|read-only/i.test(piOut(6)) && !(await lstat('/tmp/pi-left.txt').catch(() => null)), piOut(6));
record(piProbes[7][0], /Successfully wrote|wrote/i.test(piOut(7)), piOut(7));
record('pi reached Flux\'s tool', /one space: Reports/.test(piOut(8)), piOut(8));
record('pi\'s scratch and its home are gone after the run', !(await readdir('/scratch')).includes(piRun) && !(await lstat(`/data/${ada}/pi`).catch(() => null)));
model.close();

server.close();
mcp.close();
const failed = results.filter((entry) => !entry.ok);
console.log(failed.length ? `\nSandbox check FAILED: ${failed.length} of ${results.length}` : `\nSandbox check passed: ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
