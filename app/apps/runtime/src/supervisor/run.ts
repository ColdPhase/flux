import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCaps, RunOutcome, SupervisorFrame, SupervisorResult } from '@flux/runtime-protocol';
import { cliEnvironment, RUN_TEMPLATES } from './templates.js';

// One owner-invoked run of Claude Code (F-022 "Run", "Hardening: no local tool", "Caps", "Stop"). The
// supervisor builds the fixed argv from RUN_TEMPLATES, passes the prompt on stdin and the run token only
// in the CLI's environment (FLUX_RUN_TOKEN). The MCP config file names the Flux MCP URL and a header that
// references the variable; it never holds the token. The first `system/init` event must list only the
// exact Flux tools and only a connected `flux` MCP server, or the run is stopped with no answer.

/** The product brief appended to Claude Code's own system prompt, never replacing it (F-022 "Run"). */
export const RUN_BRIEF = 'You are the owner\'s assistant in Flux. Use only the Flux tools you are given. Read what they return and answer in plain text.';

/** Stdout beyond this is not read further: the run stops as `output_too_large`. */
const MAX_STREAM_BYTES = 1024 * 1024;
const STOP_TERM_AFTER_MS = 5_000;
const STOP_KILL_AFTER_MS = 7_000;
const TOOL_PREFIX = 'mcp__flux__';
/** The one built-in name the CLI may keep while MCP tools remain (F-022 "Hardening"). */
const ALLOWED_EXTRA_TOOLS = new Set(['EndConversation']);

/** Shapes that look like credentials (F-022 "Hardening": the committed answer and logs keep none). */
const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b(?:refresh_token|access_token|id_token)\b/g,
];
export const REDACTED = '[removed: looked like a secret]';

/** Replaces the run token and credential-shaped text. The caller learns whether anything matched. */
export function redactRun(text: string, runToken: string): { text: string; removed: boolean } {
  let out = text;
  let removed = false;
  if (runToken && out.includes(runToken)) { out = out.split(runToken).join(REDACTED); removed = true; }
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, () => { removed = true; return REDACTED; });
  }
  return { text: out, removed };
}

interface ActiveRun { child: ChildProcess; stopRequested: boolean }
const active = new Map<string, ActiveRun>();

/** Stop: SIGINT now, SIGTERM after a grace period, SIGKILL after that. Returns what was requested, not what finished. */
export function stopRun(runId: string): 'not_running' | 'stopping' {
  const run = active.get(runId);
  if (!run) return 'not_running';
  if (run.stopRequested) return 'stopping';
  run.stopRequested = true;
  signalGroup(run.child, 'SIGINT');
  setTimeout(() => { if (active.has(runId)) signalGroup(run.child, 'SIGTERM'); }, STOP_TERM_AFTER_MS).unref();
  setTimeout(() => { if (active.has(runId)) signalGroup(run.child, 'SIGKILL'); }, STOP_KILL_AFTER_MS).unref();
  return 'stopping';
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
}

/** The first event must be the CLI's `system` `init` event; its tool and MCP lists are checked exactly. */
export function checkInit(event: unknown, allowedTools: readonly string[]): boolean {
  if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'init') return false;
  const tools = event.tools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) return false;
  const allowed = new Set(allowedTools.map((tool) => `${TOOL_PREFIX}${tool}`));
  if (!tools.every((tool) => allowed.has(tool as string) || ALLOWED_EXTRA_TOOLS.has(tool as string))) return false;
  const servers = event.mcp_servers;
  if (!Array.isArray(servers) || servers.length === 0) return false;
  return servers.every((server) => isRecord(server) && server.name === 'flux' && server.status === 'connected');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface RunInput {
  runId: string;
  prompt: string;
  runToken: string;
  tools: readonly string[];
  caps: RunCaps;
}

export interface RunContext {
  cliPath: string;
  fluxMcpUrl: string;
  egressHost: string;
  tmpDir: string;
  bindingDir: string;
  send: (frame: SupervisorFrame) => void;
}

/** One Claude Code run. Resolves with exactly one result; nothing is committed here (the manager does). */
export async function runClaudeCode(input: RunInput, context: RunContext): Promise<{ result: SupervisorResult }> {
  const { runId, runToken, caps } = input;
  const runDir = join(context.tmpDir, `run-${runId}`);
  const mcpConfigPath = join(runDir, 'mcp.json');
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  // The config refers to the variable; the token itself is only in the child's environment.
  const mcpConfig = { mcpServers: { flux: { type: 'http', url: context.fluxMcpUrl, headers: { Authorization: 'Bearer ${FLUX_RUN_TOKEN}' } } } };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
  const argv = RUN_TEMPLATES.claude_code({ tools: input.tools, caps, mcpConfigPath, mcpUrl: context.fluxMcpUrl, brief: RUN_BRIEF });
  const env = cliEnvironment('claude_code', context.bindingDir, context.egressHost, { FLUX_RUN_TOKEN: runToken });
  let outcome: RunOutcome = 'unknown';
  let answer: string | null = null;
  try {
    const finished = await executeRun({ ...input, argv, env, context });
    outcome = finished.outcome;
    answer = finished.answer;
  } finally {
    await rm(runDir, { recursive: true, force: true });
    // No transcript remains in the binding directory (the run also passes --no-session-persistence).
    await rm(join(context.bindingDir, 'claude', 'projects'), { recursive: true, force: true });
  }
  return { result: { kind: 'run', runId, outcome, answer } };
}

interface Executed { outcome: RunOutcome; answer: string | null }

function executeRun(options: RunInput & { argv: string[]; env: Record<string, string>; context: RunContext }): Promise<Executed> {
  const { runId, runToken, prompt, tools, caps, argv, env, context } = options;
  return new Promise((resolve) => {
    const child = spawn(context.cliPath, argv, { env, cwd: context.bindingDir, shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const run: ActiveRun = { child, stopRequested: false };
    active.set(runId, run);
    let settled = false;
    let initChecked = false;
    let resultEvent: Record<string, unknown> | null = null;
    let streamed = 0;
    let buffer = '';
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      clearTimeout(idle);
      active.delete(runId);
      signalGroup(child, 'SIGKILL');
      const finalOutcome = run.stopRequested && outcome !== 'answered' ? 'stopped' : outcome;
      if (finalOutcome !== 'answered') { resolve({ outcome: finalOutcome, answer: null }); return; }
      const text = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
      const redacted = redactRun(text, runToken).text;
      if (Buffer.byteLength(redacted, 'utf8') > caps.maxAnswerBytes) { resolve({ outcome: 'answer_too_large', answer: null }); return; }
      resolve({ outcome: 'answered', answer: redacted });
    };
    const stopWith = (outcome: RunOutcome) => { finish(outcome); };
    const wall = setTimeout(() => { stopWith('timed_out'); }, caps.wallClockSeconds * 1000);
    let idle = setTimeout(() => { stopWith('idle_timed_out'); }, caps.idleSeconds * 1000);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => { stopWith('idle_timed_out'); }, caps.idleSeconds * 1000); };
    context.send({ t: 'run', runId, state: 'started' });

    const handleLine = (line: string) => {
      if (!line.trim() || settled) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (!initChecked) {
        if (!checkInit(event, tools)) { stopWith('init_rejected'); return; }
        initChecked = true;
        context.send({ t: 'run', runId, state: 'init_checked' });
        return;
      }
      if (isRecord(event) && event.type === 'result') {
        resultEvent = event;
        const failed = event.is_error === true || event.subtype !== 'success';
        // The answer is final; the CLI may still be closing its own output.
        finish(failed ? 'failed' : 'answered');
        return;
      }
      context.send({ t: 'run', runId, state: 'progress' });
    };

    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt, 'utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      touch();
      streamed += chunk.length;
      if (streamed > MAX_STREAM_BYTES) { stopWith('output_too_large'); return; }
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !settled) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', () => { if (!settled) finish('failed'); });
    child.on('close', () => {
      if (settled) return;
      // A process that exits before its result (or before its init check) ends in its own state.
      finish(initChecked ? 'failed' : 'init_rejected');
    });
  });
}
