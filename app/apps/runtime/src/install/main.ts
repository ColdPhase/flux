import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { parseRuntimeSwitch } from '@flux/runtime-protocol';
import { CLAUDE_CODE } from './pins.js';

// `runtime-install` (F-022 "Operator switch and installation"): Flux never ships Claude Code in an
// image. When the operator enables `claude_code`, this one-shot service fetches the pinned version
// from Anthropic's release bucket, checks the GPG-signed manifest against the key fingerprint
// Anthropic publishes, checks the binary's SHA-256 against that manifest and installs it into the
// tools volume, which the slots mount read-only. It reaches only `downloads.claude.ai`, through
// `runtime-egress`'s install proxy. It is idempotent: a verified install of the pinned version is kept.

const run = promisify(execFile);
const TOOLS = '/opt/flux-tools/claude';
const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

async function exists(path: string) { return access(path).then(() => true, () => false); }

async function link(version: string) {
  await mkdir(join(TOOLS, 'bin'), { recursive: true });
  const temporary = join(TOOLS, 'bin', `.claude-${randomBytes(4).toString('hex')}`);
  await symlink(`../versions/${version}/claude`, temporary);
  await rename(temporary, join(TOOLS, 'bin', 'claude'));
  for (const old of await readdir(join(TOOLS, 'versions'))) if (old !== version) await rm(join(TOOLS, 'versions', old), { recursive: true, force: true });
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** TEST ONLY: the fake `claude` of the test image, so the tools volume path is exercised without a download. */
async function installFake() {
  const fake = '/opt/flux-fakes/claude';
  if (!(await exists(fake))) throw new Error('FLUX_RUNTIME_INSTALL_SOURCE=test-fakes needs the test image (no /opt/flux-fakes)');
  const dir = join(TOOLS, 'versions', 'test-fake');
  await mkdir(dir, { recursive: true });
  await copyFile(fake, join(dir, 'claude'));
  await chmod(join(dir, 'claude'), 0o755);
  await link('test-fake');
  log({ event: 'installed', client: 'claude_code', version: 'test-fake', warning: 'TEST ONLY: fake Claude Code' });
}

async function fetchBytes(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url} is larger than expected`);
  return bytes;
}

async function verifyManifest(manifest: Buffer, signature: Buffer): Promise<void> {
  const home = await mkdtemp('/tmp/flux-gpg-');
  try {
    await writeFile(join(home, 'manifest.json'), manifest);
    await writeFile(join(home, 'manifest.json.sig'), signature);
    const gpg = (args: string[]) => run('gpg', ['--homedir', home, '--batch', '--no-tty', ...args], { maxBuffer: 1024 * 1024 });
    await gpg(['--import', CLAUDE_CODE.signingKeyFile]);
    const { stdout: keys } = await gpg(['--with-colons', '--fingerprint']);
    if (!keys.split('\n').some((line) => line === `fpr:::::::::${CLAUDE_CODE.signingKeyFingerprint}:`)) throw new Error('The bundled signing key does not have the published fingerprint');
    const { stdout: status } = await gpg(['--status-fd', '1', '--verify', join(home, 'manifest.json.sig'), join(home, 'manifest.json')]);
    const valid = status.split('\n').some((line) => line.startsWith('[GNUPG:] VALIDSIG ') && line.trim().split(' ').includes(CLAUDE_CODE.signingKeyFingerprint));
    if (!valid) throw new Error('manifest.json is not signed by the Claude Code release key');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function installClaudeCode() {
  const { version, releases } = CLAUDE_CODE;
  const dir = join(TOOLS, 'versions', version);
  const platform = process.arch === 'arm64' ? 'linux-arm64-musl' : process.arch === 'x64' ? 'linux-x64-musl' : null;
  if (!platform) throw new Error(`No Claude Code build for ${process.arch}`);
  const manifestBytes = await fetchBytes(`${releases}/${version}/manifest.json`, 256 * 1024);
  const signature = await fetchBytes(`${releases}/${version}/manifest.json.sig`, 64 * 1024);
  await verifyManifest(manifestBytes, signature);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { version?: unknown; platforms?: Record<string, { checksum?: unknown; size?: unknown }> };
  const entry = manifest.platforms?.[platform];
  if (manifest.version !== version || typeof entry?.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(entry.checksum)
    || typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > 1024 * 1024 * 1024) {
    throw new Error(`The signed manifest has no valid ${platform} entry for ${version}`);
  }
  const verified = join(dir, '.verified');
  if (await exists(join(dir, 'claude')) && (await readFile(verified, 'utf8').catch(() => '')) === entry.checksum
    && (await sha256File(join(dir, 'claude'))) === entry.checksum) {
    await link(version);
    log({ event: 'kept', client: 'claude_code', version });
    return;
  }
  await mkdir(join(TOOLS, 'versions'), { recursive: true });
  const partial = join(TOOLS, 'versions', `.partial-${randomBytes(6).toString('hex')}`);
  await mkdir(partial);
  try {
    const response = await fetch(`${releases}/${version}/${platform}/claude`, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`The Claude Code ${version} download answered ${response.status}`);
    const hash = createHash('sha256');
    let size = 0;
    const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).map((chunk: Buffer) => {
      size += chunk.length;
      if (size > (entry.size as number)) throw new Error('The download is larger than the signed manifest says');
      hash.update(chunk);
      return chunk;
    });
    await pipeline(counted, createWriteStream(join(partial, 'claude'), { mode: 0o755 }));
    if (size !== entry.size || hash.digest('hex') !== entry.checksum) throw new Error('The download does not match the signed manifest');
    await chmod(join(partial, 'claude'), 0o755);
    await writeFile(join(partial, '.verified'), entry.checksum);
    await rm(dir, { recursive: true, force: true });
    await rename(partial, dir);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  await link(version);
  log({ event: 'installed', client: 'claude_code', version, platform, sha256: entry.checksum });
}

const clients = parseRuntimeSwitch(process.env.FLUX_AGENT_RUNTIME);
if (!clients.includes('claude_code')) {
  log({ event: 'skipped', reason: 'claude_code is not enabled; Codex is in the runtime image' });
} else if (process.env.FLUX_RUNTIME_INSTALL_SOURCE === 'test-fakes') {
  await installFake();
} else if (process.env.FLUX_RUNTIME_INSTALL_SOURCE) {
  throw new Error('FLUX_RUNTIME_INSTALL_SOURCE is test only and may only be test-fakes');
} else {
  await installClaudeCode();
}
