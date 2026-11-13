// Stands in for the worker's child process in the tests of its sandbox (C-63): it is started with the same flags and arguments, confines itself with the
// same addon, then tries what a hostile parser would try. What it found goes back as the one text segment of an answer.
/* global process, setTimeout, clearTimeout, fetch */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

const [, addon, rawLimits] = process.argv.slice(2);
const limits = JSON.parse(rawLimits);
try { createRequire(import.meta.url)(addon).confine(limits.extraBytes, limits.cpuSeconds); } catch { process.exit(70); }

const found = {};
const attempt = async (name, run) => { try { found[name] = await run(); } catch (error) { found[name] = `refused ${error.code ?? error.name}`; } };
const settle = (start) => new Promise((resolve) => { const timer = setTimeout(() => resolve('no answer'), 3000); start((value) => { clearTimeout(timer); resolve(value); }); });

await attempt('tcp', () => settle((done) => { import('node:net').then(({ connect }) => { const socket = connect(80, '1.1.1.1'); socket.on('error', (e) => done(`refused ${e.code}`)); socket.on('connect', () => done('connected')); }); }));
await attempt('udp', () => settle((done) => { import('node:dgram').then(({ createSocket }) => { const socket = createSocket('udp4'); socket.on('error', (e) => done(`refused ${e.code}`)); socket.send('x', 53, '1.1.1.1', (e) => done(e ? `refused ${e.code}` : 'sent')); }); }));
await attempt('fetch', () => fetch('http://1.1.1.1/').then(() => 'fetched', (e) => `refused ${e.cause?.code ?? e.message}`));
await attempt('dns', () => settle((done) => { import('node:dns').then(({ lookup }) => lookup('example.com', (e, a) => done(e ? `refused ${e.code}` : `resolved ${a}`))); }));
await attempt('exec', async () => { (await import('node:child_process')).execSync('id'); return 'ran'; });
await attempt('read', () => `read ${readFileSync('/etc/passwd', 'utf8').length}`);
await attempt('write', () => { writeFileSync('/tmp/flux-file-text-probe', 'x'); return 'wrote'; });
await attempt('memory', () => { new Uint8Array(Math.round(limits.extraBytes * 1.5)).fill(1); return 'allocated'; });
found.env = Object.keys(process.env).length;
const line = `${JSON.stringify({ ok: true, segments: [{ text: JSON.stringify(found) }] })}\n`;
writeSync(1, line);
process.exit(0);
