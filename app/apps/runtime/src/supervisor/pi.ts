import { spawn } from 'node:child_process';
import { access, chmod, constants, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FLUX_TOOL_NAME, INIT_NAME, MODEL_GATEWAY_ORIGIN, MODEL_GATEWAY_TOKEN_ENV, modelGatewayBaseUrl, TEXT_FRAME_LIMITS, type KeyProvider, type RunOutcome,
  type SupervisorRequest, type SupervisorResult,
} from '@flux/runtime-protocol';
import { asThem, clearLeftovers, removeAsThem } from './data.js';
import type { Outcome, Send, SupervisorConfig } from './handlers.js';
import { asPerson, endProcesses, runFixed, type Person } from './process.js';
import { finishedOf, MODEL_NOT_ACCEPTED, RUN_BRIEF, RUN_BRIEF_OWN_TOOLS, runsOf, STOP_GRACE_MS } from './run.js';
import { createScratch, removeScratch, watchRun, type SandboxSetup } from './sandbox.js';

// An API-key agent's run in pi (#1441, RT-1, RT-5): pi 1.5.2 (MIT, pinned with its lockfile in the runtime image), in JSON mode, under the
// same contract as Claude Code and Codex. Flux is its only MCP server, with exactly the run's tools exposed directly; its own `read`, `bash`,
// `edit` and `write` run in the run's scratch where the runtime has Flux's sandbox (`bash` is Flux's sandbox shell); no extension, skill,
// prompt template, context file, project setting, session file, update check or telemetry. The model is the key's: pi speaks its provider's
// wire format to Flux's model gateway through the egress with the run token, and the gateway holds the key and meters every request (one
// adapter: `gatewayProvider`). Nothing pi prints is logged; its words, its Flux tool calls and its answer go on as the CLIs' do.

type PiRequest = Extract<SupervisorRequest, { kind: 'run'; client: 'pi' }>;

/** Where pi is in the runtime image (docker/pi: `npm ci` from its lockfile), and the launcher that starts it (pi-launch.ts). */
export const PI_PATHS = {
  node: '/usr/local/bin/node',
  launcher: '/opt/flux-runtime/apps/runtime/dist/supervisor/pi-launch.js',
  cli: '/opt/flux-runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
} as const;
export type PiPaths = { node: string; launcher: string; cli: string };

/** pi's own tools a run keeps where the runtime has Flux's sandbox (#1437, RT-5). Never `grep`, `find`, `ls` (bash does those), `codemode` or `tool_search`. */
export const PI_OWN_TOOLS = ['read', 'bash', 'edit', 'write'] as const;
/** The name pi gives a tool of Flux's MCP server. */
const PI_MCP_PREFIX = 'mcp__flux__';

/**
 * Every flag of a pi run (pi 1.5.2's `pi --help`, read 2026-11-13). JSON mode, one prompt read from standard input, nothing persisted,
 * nothing discovered: `--no-extensions` turns off every extension and `-e builtin:mcp` brings back only pi's own MCP support; no skills,
 * prompt templates, themes or context files (`AGENTS.md`, `CLAUDE.md`), project settings ignored, no network of its own (`--offline`).
 * `--tools` names exactly what the model is offered: pi's own tools (with the sandbox) and the tools of the `flux` server.
 */
export function piArgs(ownTools: boolean, brief: string, model: string): string[] {
  return [
    '--mode', 'json', '--no-session', '--no-extensions', '-e', 'builtin:mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--no-approve', '--offline', '--provider', 'flux', '--model', model,
    '--tools', [...(ownTools ? PI_OWN_TOOLS : []), `${PI_MCP_PREFIX}*`].join(','), '--append-system-prompt', brief,
  ];
}

/**
 * The wire format pi speaks for each provider at the gateway, and what it must not guess from the gateway's address (pi detects quirks by
 * host). Gemini through its OpenAI-compatible endpoint (`…/gemini/v1beta/openai`), as Flux's own adapter speaks to it.
 */
const PROVIDER_API: Record<KeyProvider, { api: 'anthropic-messages' | 'openai-responses' | 'openai-completions'; suffix?: string; compat?: Record<string, unknown> }> = {
  anthropic: { api: 'anthropic-messages' },
  openai: { api: 'openai-responses' },
  openrouter: { api: 'openai-completions', compat: { thinkingFormat: 'openrouter', supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } },
  gemini: { api: 'openai-completions', suffix: '/v1beta/openai', compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } },
  openai_compatible: { api: 'openai-completions', compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } },
};

/**
 * THE adapter to Flux's model gateway (#1441, RT-4 "The model gateway", `@flux/runtime-protocol` model-gateway.ts): the provider's base URL on
 * `runtime-egress:8081` (`modelGatewayBaseUrl`), pi's own client paths below it, and the run's gateway token as pi's API key, named
 * (`$FLUX_MODEL_GATEWAY_TOKEN`) and sent in the provider's usual header (Anthropic's `x-api-key`, `Authorization: Bearer` elsewhere). The
 * gateway swaps it for the sealed key, holds the key's budget before each request and charges the provider's usage after it; it refuses
 * with `flux_budget_exhausted` (402) or `flux_run_ended` (403), which pi does not retry (`classifyPiError`).
 */
export function gatewayProvider(provider: KeyProvider, origin: string, model: string, pictures: boolean) {
  const wire = PROVIDER_API[provider];
  return {
    baseUrl: `${modelGatewayBaseUrl(provider, origin.replace(/\/+$/, ''))}${wire.suffix ?? ''}`, api: wire.api, apiKey: `$${MODEL_GATEWAY_TOKEN_ENV}`,
    ...(wire.compat ? { compat: wire.compat } : {}),
    models: [{ id: model, name: model, input: pictures ? ['text', 'image'] : ['text'], contextWindow: PI_MODEL_LIMITS.contextWindow, maxTokens: PI_MODEL_LIMITS.maxTokens }],
  };
}

/** What pi assumes of a key's model it has no card for: the context it compacts within and the answer it asks for. */
export const PI_MODEL_LIMITS = { contextWindow: 128_000, maxTokens: 8_192 } as const;

/** pi's settings for a run: Flux's sandbox shell, no telemetry, no retries of its own (a refusal is final; the worker decides), SSE only. */
export function piSettings(model: string, shell: string | null) {
  return {
    defaultProvider: 'flux', defaultModel: model, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableSkillCommands: false,
    quietStartup: true, transport: 'sse', retry: { enabled: false }, ...(shell ? { shellPath: shell } : {}),
  };
}

/** pi's MCP servers: Flux's MCP route only, its tools declared to the model directly (`exposure: direct`, not behind a search or codemode). */
export function piMcp(mcpUrl: string) {
  return { mcpServers: { flux: { url: mcpUrl, headers: { Authorization: 'Bearer ${FLUX_RUN_TOKEN}' }, exposure: 'direct' } } };
}

/**
 * pi's error text in Flux's categories. pi ends a failed request with an assistant message whose `stopReason` is `error` and whose
 * `errorMessage` is the HTTP status and the body (observed with pi 1.5.2 against a mock gateway, 2026-11-13:
 * `402 {"type":"error","error":{"type":"flux_budget",…}}`).
 */
export function classifyPiError(text: string): RunOutcome {
  if (/\bflux_budget/.test(text)) return 'budget';
  if (/\bflux_credits\b|credit balance is too low|insufficient_quota|insufficient credits|exceeded your current quota/i.test(text)) return 'credits';
  if (/prompt is too long|context_length_exceeded|maximum context length|context window|too many tokens/i.test(text)) return 'input_too_large';
  if (MODEL_NOT_ACCEPTED.test(text) || /\bnot_found_error\b.*\bmodel\b/i.test(text)) return 'model_unavailable';
  if (/usage policy|content policy|refus/i.test(text)) return 'refused';
  return 'crashed';
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const TEXT_BATCH_MS = 150;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of an assistant message: its text blocks, in order. */
const textOf = (message: Record<string, unknown>) => (Array.isArray(message.content) ? message.content : [])
  .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text).join('');

/** A fixed shell line as the person with `$1` and `$2`: their pi home is made fresh, with this run's settings copied from the run's folder. */
async function freshHome(person: Person, bindingDir: string, runDir: string): Promise<boolean> {
  const done = await runFixed('/bin/sh', ['-c', 'rm -rf -- "$1/pi" && mkdir -m 0700 -- "$1/pi" && cp -- "$2/settings.json" "$2/models.json" "$2/mcp.json" "$1/pi/"',
    'sh', bindingDir, runDir], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 30_000, person });
  return done.code === 0 && !done.timedOut;
}

export const installedPi = (paths: PiPaths) => access(paths.cli, constants.R_OK).then(() => access(paths.launcher, constants.R_OK)).then(() => true, () => false);

export async function runPi(config: SupervisorConfig, request: PiRequest, dir: string, person: Person, send: Send): Promise<Outcome> {
  const paths = config.piPaths ?? PI_PATHS;
  const runs = runsOf(config);
  const crashed = (): Outcome => ({ result: { kind: 'run', runId: request.runId, outcome: 'crashed', answer: null, resetsAt: null, turns: 0 } });
  const mcpUrl = config.mcpUrl ?? `http://${config.egressHost}:8080/mcp`;
  const modelOrigin = config.modelOrigin ?? MODEL_GATEWAY_ORIGIN;
  const sandbox: SandboxSetup | null = config.sandbox ?? null;
  const runDir = join(config.tmpDir, `run-${request.runId}`);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir);
  await chmod(runDir, 0o755);
  let scratch: string | null = null;
  if (sandbox) {
    try { scratch = await createScratch(sandbox, request.runId, person); } catch { await rm(runDir, { recursive: true, force: true }).catch(() => undefined); return crashed(); }
  }
  const ownTools = scratch !== null;
  const brief = ownTools ? RUN_BRIEF_OWN_TOOLS : RUN_BRIEF;
  // pi's own files hold no secret: the run token is named (`$FLUX_RUN_TOKEN`), never written.
  const files: Record<string, unknown> = {
    'settings.json': piSettings(request.model, ownTools ? sandbox!.shell : null),
    'models.json': { providers: { flux: gatewayProvider(request.provider, modelOrigin, request.model, request.pictures === true) } },
    'mcp.json': piMcp(mcpUrl),
  };
  for (const [name, value] of Object.entries(files)) { await writeFile(join(runDir, name), JSON.stringify(value)); await chmod(join(runDir, name), 0o644); }
  const home = join(dir, 'pi');
  const cleanUp = async () => {
    const quiet = await endProcesses(person);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (!quiet) return;
    if (scratch) await removeScratch(scratch, person);
    await removeAsThem(person, home);
    await asThem(person, 'rm -rf -- "$1/tmp" && mkdir -m 0700 -- "$1/tmp"', dir);
    await clearLeftovers(config.tmpDir, person);
  };
  if (!(await freshHome(person, dir, runDir))) { await cleanUp(); return crashed(); }

  const work = scratch ?? join(dir, 'tmp');
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(dir, 'home'), LANG: 'C.UTF-8', TMPDIR: work, NO_COLOR: '1',
    // The gateway is plain HTTP on runtime-egress, never through its CONNECT proxy (RT-4); pi is given no proxy at all.
    NO_PROXY: config.egressHost, no_proxy: config.egressHost,
    PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    // Node's own compile cache would go to TMPDIR, the scratch: nothing but what the run makes belongs there.
    NODE_DISABLE_COMPILE_CACHE: '1',
    ...(scratch ? { FLUX_SANDBOX_DIR: scratch } : {}),
  };
  const argv = [paths.launcher, paths.cli, ...piArgs(ownTools, brief, request.model)];
  // pi runs inside the sandbox's outer domain: it writes only its own home and the scratch, and reads those, the run's folder and the system.
  const [file, args] = sandbox && scratch
    ? [sandbox.binary, ['cli', scratch, '--home', home, '--home', join(dir, 'home'), '--read', runDir, '--', paths.node, ...argv]]
    : [paths.node, argv];
  const allowedFlux = new Set(request.tools.map((tool) => `${PI_MCP_PREFIX}${tool}`));
  const allowed = new Set([...allowedFlux, ...(ownTools ? PI_OWN_TOOLS : [])]);

  const result = await new Promise<Extract<SupervisorResult, { kind: 'run' }>>((resolve) => {
    let outcome: RunOutcome | null = null;
    let answer: string | null = null;
    let turns = 0;
    let initSeen = false;
    let resultSeen = false;
    let stopping = false;
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(file, args, { env, cwd: work, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], ...asPerson(person) });
    const stopWatching = scratch && person && child.pid ? watchRun({ person, cliPid: child.pid, scratch, scratchRoot: sandbox!.scratchRoot }) : () => undefined;
    const killGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ } };
    const later = (ms: number, action: () => void) => { const timer = setTimeout(action, ms); timer.unref(); timers.push(timer); return timer; };
    const terminate = (reason: RunOutcome) => { outcome ??= reason; killGroup('SIGTERM'); later(STOP_GRACE_MS, () => killGroup('SIGKILL')); };
    runs.set(request.runId, { bindingId: request.bindingId, stop: () => {
      if (stopping || done) return;
      stopping = true;
      outcome ??= 'stopped';
      killGroup('SIGINT');
      later(STOP_GRACE_MS, () => { killGroup('SIGTERM'); later(STOP_GRACE_MS, () => killGroup('SIGKILL')); });
    } });
    // The words as pi streams them (#1248): batched about every 150 ms into one `text` frame of their message, within the run's bounds.
    let textTurn = 0; let pendingText = ''; let textTimer: NodeJS.Timeout | null = null; let textFrames = 0; let textTotal = 0;
    const flushText = () => {
      if (textTimer) { clearTimeout(textTimer); textTimer = null; }
      while (pendingText && textFrames < TEXT_FRAME_LIMITS.frames && textTotal < TEXT_FRAME_LIMITS.total) {
        let piece = pendingText.slice(0, Math.min(TEXT_FRAME_LIMITS.chars, TEXT_FRAME_LIMITS.total - textTotal));
        const last = piece.charCodeAt(piece.length - 1);
        if (piece.length > 1 && piece.length < pendingText.length && last >= 0xd800 && last <= 0xdbff) piece = piece.slice(0, -1);
        pendingText = pendingText.slice(piece.length);
        textFrames += 1; textTotal += piece.length;
        send({ t: 'run', e: 'text', turn: textTurn, text: piece });
      }
      pendingText = '';
    };
    const sayText = (turn: number, words: string) => {
      const clean = words.split('\u0000').join('');
      if (!clean || turn < 1) return;
      if (turn !== textTurn) { flushText(); textTurn = turn; }
      pendingText += clean;
      if (!textTimer) { textTimer = setTimeout(flushText, TEXT_BATCH_MS); textTimer.unref(); }
    };
    let idle = later(request.caps.idleSeconds * 1000, () => terminate('no_event'));
    later(request.caps.wallClockSeconds * 1000, () => terminate('wall_clock'));

    let assistantMessages = 0;
    let lastAssistant: Record<string, unknown> | null = null;
    /**
     * The read-back (RT-5): every system message lists the tools pi offers the model (`toolsAdded`). Anything but the run's exact Flux tools
     * and, with the sandbox, pi's four own tools stops the run with nothing committed; so does a run whose Flux server offered no tool.
     */
    const checkTools = (message: Record<string, unknown>) => {
      const offered = (Array.isArray(message.toolsAdded) ? message.toolsAdded : []).map((tool) => (isObject(tool) && typeof tool.name === 'string' ? tool.name : '\u0000'));
      if (offered.some((name) => !allowed.has(name))) { terminate('local_tool'); return; }
      if (initSeen) return;
      initSeen = true;
      const flux = offered.filter((name) => allowedFlux.has(name));
      send({ t: 'run', e: 'init', tools: flux.filter((name) => INIT_NAME.test(name)).slice(0, 64), servers: [{ name: 'flux', status: flux.length ? 'connected' : 'failed' }] });
      if (!flux.length) terminate('local_tool');
    };
    const handle = (event: Record<string, unknown>) => {
      if (outcome) return;
      const type = typeof event.type === 'string' ? event.type : '';
      const message = isObject(event.message) ? event.message : null;
      if (type === 'message_start' && message?.role === 'system') { checkTools(message); return; }
      if (!initSeen && type !== 'session' && type !== 'agent_start' && type !== 'turn_start') {
        // The first thing pi says after it starts is its system message with its tools: anything else first is not the pi Flux reviewed.
        if (type !== 'message_start' && type !== 'message_end') { terminate('local_tool'); return; }
        if (message?.role !== 'system' && message?.role !== 'user') { terminate('local_tool'); return; }
      }
      if (type === 'message_start' && message?.role === 'assistant') { assistantMessages += 1; return; }
      if (type === 'message_update') {
        const delta = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') sayText(Math.max(1, assistantMessages), delta.delta);
        return;
      }
      if (type === 'tool_execution_start') {
        const name = typeof event.toolName === 'string' ? event.toolName : '';
        if (!allowed.has(name)) { terminate('local_tool'); return; }
        if (allowedFlux.has(name)) {
          const tool = name.slice(PI_MCP_PREFIX.length);
          if (FLUX_TOOL_NAME.test(tool)) send({ t: 'run', e: 'tool', name: tool });
        }
        return;
      }
      if (type === 'message_end' && message?.role === 'assistant') { lastAssistant = message; return; }
      if (type === 'turn_end') {
        turns += 1;
        // The answer is one more turn: a response that asked for tools and leaves no turn for it ends the run at the cap.
        const last = lastAssistant as Record<string, unknown> | null;
        if (last?.stopReason === 'toolUse' && turns >= request.caps.maxTurns) terminate('max_turns');
        return;
      }
      if (type === 'agent_settled') {
        resultSeen = true;
        later(STOP_GRACE_MS, () => { killGroup('SIGTERM'); later(STOP_GRACE_MS, () => killGroup('SIGKILL')); });
        const last = lastAssistant as Record<string, unknown> | null;
        if (event.aborted === true || last?.stopReason === 'aborted') { outcome = stopping ? 'stopped' : 'crashed'; return; }
        if (!last) { outcome = 'crashed'; return; }
        if (last.stopReason === 'error') { outcome = classifyPiError(typeof last.errorMessage === 'string' ? last.errorMessage : ''); return; }
        const text = textOf(last);
        if (Buffer.byteLength(text, 'utf8') > request.caps.maxAnswerBytes) outcome = 'answer_too_large';
        else { answer = text; outcome = 'completed'; }
      }
      // session, agent_start, turn_start, user messages, tool results and updates, queue, compaction and retry events carry nothing for Flux.
    };

    let pending: Buffer = Buffer.alloc(0);
    let total = 0;
    const seen: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDOUT_BYTES) { terminate('unknown'); return; }
      clearTimeout(idle);
      if (!outcome) idle = later(request.caps.idleSeconds * 1000, () => terminate('no_event'));
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline === -1) break;
        const line = pending.subarray(0, newline).toString('utf8').trim();
        pending = pending.subarray(newline + 1);
        if (!line) continue;
        let event: unknown;
        if (config.piDiagnostics && seen.length < 400) seen.push(line.slice(0, 600));
        try { event = JSON.parse(line); } catch { terminate('unknown'); return; }
        if (!isObject(event)) { terminate('unknown'); return; }
        handle(event);
      }
      if (pending.length > MAX_LINE_BYTES) terminate('unknown');
    });
    // pi's stderr is drained and dropped: never read, kept or logged (a test may ask for it, piDiagnostics).
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (config.piDiagnostics && stderr.length < 64_000) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => undefined);
    // The run's two tokens on the first line, for the launcher only; then the request, which pi reads as its prompt.
    child.stdin.end(`${JSON.stringify({ run: request.runToken, model: request.modelToken })}\n${request.prompt}`);
    const settle = (code: number | null) => {
      if (done) return;
      done = true;
      flushText();
      stopWatching();
      for (const timer of timers) clearTimeout(timer);
      killGroup('SIGKILL');
      if (!outcome) outcome = resultSeen ? 'unknown' : stopping ? 'stopped' : code === 0 || pending.length ? 'unknown' : 'crashed';
      if (config.piDiagnostics) void readFile(join(home, 'mcp.log'), 'utf8').catch(() => '').then((mcpLog) => config.piDiagnostics!({ stderr, mcpLog, events: [`outcome ${outcome}`, ...seen] }));
      resolve({ kind: 'run', runId: request.runId, outcome, answer: outcome === 'completed' ? answer : null, resetsAt: null, turns });
    };
    child.on('error', () => settle(null));
    child.on('close', (code) => settle(code));
  });
  runs.delete(request.runId);
  finishedOf(config).set(request.runId, Date.now());
  await cleanUp();
  return { result };
}
