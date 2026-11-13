import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, join, relative } from 'node:path';
import { RUN_FILE_STATUS, type RunFileError, type RunFileRequest } from '@flux/runtime-protocol';
import { openBinding } from './data.js';
import type { SupervisorConfig } from './handlers.js';
import { asPerson } from './process.js';
import { runInProgress } from './run.js';

// A file of a run's scratch for `flux_attach_file` (#1437, RT-5). Only while that run of that person is in progress, and only through Flux's
// sandbox reader (native/sandbox.c `read`) as the person, which opens nothing but a regular file inside the scratch: a link as its last
// name, `..` out of it, another run's scratch and the person's own login are all refused by the kernel (Landlock), not by this code. The bytes
// go out as they are read; nothing is kept or logged.

/** The reader's exit codes (sandbox.c) in the protocol's words. */
const READ_ERRORS: Record<number, RunFileError> = { 2: 'file_missing', 3: 'file_not_regular', 4: 'file_too_large', 5: 'no_sandbox' };

function refuse(res: ServerResponse, code: RunFileError) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(RUN_FILE_STATUS[code], { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify({ error: code }));
}

/** The path as the reader takes it: relative to the scratch. An absolute path is accepted when it names something inside it. */
export function scratchRelative(scratch: string, path: string): string | null {
  if (!isAbsolute(path)) return path;
  const inside = relative(scratch, path);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : null;
}

export async function serveRunFile(config: SupervisorConfig, request: RunFileRequest, res: ServerResponse): Promise<void> {
  const sandbox = config.sandbox ?? null;
  if (!sandbox) { refuse(res, 'no_sandbox'); return; }
  const open = await openBinding(config.dataDir, request.bindingId, config.separate);
  if (!open.ok) { refuse(res, open.code); return; }
  if (!runInProgress(config, request.runId, request.bindingId)) { refuse(res, 'not_running'); return; }
  const scratch = join(sandbox.scratchRoot, request.runId);
  if (!(await lstat(scratch).catch(() => null))?.isDirectory()) { refuse(res, 'not_running'); return; }
  const path = scratchRelative(scratch, request.path);
  if (path === null) { refuse(res, 'file_missing'); return; }
  const child = spawn(sandbox.binary, ['read', scratch, path, String(request.maxBytes)], { env: {}, cwd: '/', shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    ...asPerson(open.person) });
  let started = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (!started) {
      started = true;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', connection: 'close' });
    }
    if (!res.write(chunk)) { child.stdout.pause(); res.once('drain', () => child.stdout.resume()); }
  });
  res.on('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise<void>((done) => {
    child.on('error', () => { refuse(res, 'internal'); done(); });
    child.on('close', (code) => {
      // A file that failed after its first bytes (it grew past its bound) ends the stream broken, never as a whole file.
      if (code === 0) { if (!started) res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', connection: 'close' }); res.end(); }
      else refuse(res, READ_ERRORS[code ?? -1] ?? 'internal');
      done();
    });
  });
}
