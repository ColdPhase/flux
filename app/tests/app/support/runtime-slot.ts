import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeClient } from '@flux/runtime-protocol';
import type { SupervisorConfig } from '../../../apps/runtime/src/supervisor/handlers.js';
import { createSupervisorServer } from '../../../apps/runtime/src/supervisor/server.js';

// An in-process runtime slot for the core tests (F-022 T3): a real supervisor over temporary `/data`
// and `/tmp` directories, with the TEST ONLY fake CLIs from the built workspace behind small wrappers.

export const slotSecret = () => randomBytes(24).toString('base64url');

export interface TestSlot {
  config: SupervisorConfig;
  url: string;
  released: number;
  close(): Promise<void>;
}

async function fakeWrapper(dir: string, name: 'claude' | 'codex') {
  const path = join(dir, name);
  const script = resolve(`apps/runtime/dist/fakes/fake-${name}.js`);
  await writeFile(path, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

export async function startTestSlot(options: { slot?: string; enabled?: RuntimeClient[]; bindingLimitBytes?: number; cliTimeoutMs?: number; withClis?: boolean } = {}): Promise<TestSlot> {
  const root = await mkdtemp(join(tmpdir(), 'flux-slot-'));
  const dataDir = join(root, 'data');
  const tmpDir = join(root, 'tmp');
  const bin = join(root, 'bin');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(tmpDir);
  await mkdir(bin);
  const withClis = options.withClis ?? true;
  const config: SupervisorConfig = {
    slot: options.slot ?? 'runtime-1',
    secret: slotSecret(),
    bootId: randomUUID(),
    dataDir,
    tmpDir,
    enabled: options.enabled ?? ['claude_code', 'codex'],
    cliPaths: withClis
      ? { claude_code: await fakeWrapper(bin, 'claude'), codex: await fakeWrapper(bin, 'codex') }
      : { claude_code: join(bin, 'missing-claude'), codex: join(bin, 'missing-codex') },
    egressHost: 'runtime-egress',
    bindingLimitBytes: options.bindingLimitBytes ?? 256 * 1024 * 1024,
    cliTimeoutMs: options.cliTimeoutMs ?? 10_000,
  };
  const state = { released: 0 };
  const { server } = createSupervisorServer(config, () => { state.released += 1; });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    config,
    url: `http://127.0.0.1:${port}`,
    get released() { return state.released; },
    async close() {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function portOf(url: string) { return Number(new URL(url).port); }
