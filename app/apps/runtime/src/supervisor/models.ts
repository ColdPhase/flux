import { spawn } from 'node:child_process';
import { MAX_PLAN_MODELS, MODEL_ID, PLAN_MODEL_LIMITS, type PlanModel, type RuntimeClient } from '@flux/runtime-protocol';
import { openAppServer } from './app-server.js';
import { asPerson, type Person } from './process.js';
import { CLAUDE_MODELS_TEMPLATE, cliEnvironment, codexListOverrides } from './templates.js';
import type { SupervisorConfig } from './handlers.js';

// The models the signed-in CLI offers its account (#1332, F-022 amended): read in the person's own slot, reduced to closed shapes and
// passed on as ids, names and one-line notes. Nothing the CLI prints is logged or kept, and nothing here reads a credential.
//
// Claude Code (2.1.285, observed 2026-11-12): `claude -p --input-format stream-json …` waits for control requests on standard input; its answer
// to one `initialize` request carries `models`: `value` (the alias `--model` takes), `resolvedModel`, `displayName` and `description`
// ("Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok"), without a model call. The entry `default` only names which listed
// model is the account's default. Codex (0.160.1, observed 2026-11-12): `codex app-server` answers `model/list`, paged: `model`, `displayName`,
// `description`, `hidden`, `isDefault`, `inputModalities`.
//
// Dropped here, so they never leave the slot: hidden models, Fable (it can bill usage credits that Flux cannot see) and any id that is not a
// plain model id (it could be read as a flag or a path).

/** How long a read may take: the CLI's start-up and, for Codex, the account's list from the vendor. */
export const MODELS_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const REQUEST_ID = 'flux-models';
/** A plan has a handful of models; this many pages of 100 is far past that. */
const CODEX_PAGE_SIZE = 100;
const CODEX_MAX_PAGES = 5;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const FABLE = /fable/i;
/** Fable can bill usage credits that Flux cannot see (founder direction, #1332): it is never offered, whatever field names it. */
const isFable = (...values: unknown[]) => values.some((value) => typeof value === 'string' && FABLE.test(value));

/** A CLI's text as one plain line: no control character, runs of space as one, at most `max` characters. */
export function plainLine(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

const PRICE = /\$\s*\d/;

/**
 * Claude Code's `models` as the plan's choices: its aliases in its own order, without `default` (which names the account's default
 * model, so the listed model it resolves to is marked), Fable and ids Flux cannot pass on. A description reads "Opus 5.5 · Best for
 * everyday, complex tasks · $4/$20 per Mtok": the first part is the version (it names the model when it starts with the display name), the
 * price is an API price and means nothing on a plan, and what is left is the note.
 */
export function reduceClaudeModels(models: unknown): PlanModel[] {
  if (!Array.isArray(models)) return [];
  const entries = models.filter(isObject);
  const standard = entries.find((entry) => entry.value === 'default');
  const defaultResolved = typeof standard?.resolvedModel === 'string' ? standard.resolvedModel : null;
  const found: PlanModel[] = [];
  const seen = new Set<string>();
  let defaultTaken = false;
  for (const entry of entries) {
    const id = typeof entry.value === 'string' ? entry.value : '';
    if (id === 'default' || !MODEL_ID.test(id) || seen.has(id) || isFable(entry.value, entry.resolvedModel, entry.displayName)) continue;
    seen.add(id);
    const label = plainLine(entry.displayName, PLAN_MODEL_LIMITS.name);
    const parts = plainLine(entry.description, 400).split('·').map((part) => part.trim()).filter(Boolean);
    const versioned = !!label && !!parts[0] && parts[0].toLowerCase().startsWith(label.toLowerCase()) && parts[0].length <= 40;
    const isDefault = !defaultTaken && defaultResolved !== null && entry.resolvedModel === defaultResolved;
    if (isDefault) defaultTaken = true;
    found.push({
      id, name: (versioned ? parts[0] : label) || id, default: isDefault, seesPictures: true,
      note: (versioned ? parts.slice(1) : parts).filter((part) => !PRICE.test(part)).join(' · ').slice(0, PLAN_MODEL_LIMITS.note),
    });
    if (found.length >= MAX_PLAN_MODELS) break;
  }
  return found;
}

/** Codex's `model/list` entries (every page) as the plan's choices: the visible ones in its order, without Fable or ids Flux cannot pass on. */
export function reduceCodexModels(entries: readonly unknown[]): PlanModel[] {
  const found: PlanModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isObject(entry) || entry.hidden === true) continue;
    const id = typeof entry.model === 'string' ? entry.model : typeof entry.id === 'string' ? entry.id : '';
    if (!MODEL_ID.test(id) || seen.has(id) || isFable(id, entry.displayName)) continue;
    seen.add(id);
    found.push({
      id, name: plainLine(entry.displayName, PLAN_MODEL_LIMITS.name) || id, note: plainLine(entry.description, PLAN_MODEL_LIMITS.note),
      default: entry.isDefault === true, seesPictures: !Array.isArray(entry.inputModalities) || entry.inputModalities.includes('image'),
    });
    if (found.length >= MAX_PLAN_MODELS) break;
  }
  return found;
}

/** Every page of `model/list`, by its cursor, up to a few pages. Anything that is not a list is an error. */
export async function collectCodexModels(request: (method: 'model/list', params: Record<string, unknown>) => Promise<unknown>): Promise<unknown[]> {
  const entries: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < CODEX_MAX_PAGES; page += 1) {
    const answer: unknown = await request('model/list', { limit: CODEX_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!isObject(answer) || !Array.isArray(answer.data)) throw new Error('Not a model list');
    entries.push(...answer.data);
    const next: unknown = answer.nextCursor;
    cursor = typeof next === 'string' && next.length > 0 && next.length <= 512 ? next : null;
    if (!cursor) break;
  }
  return entries;
}

/** The account's models as Codex's app-server lists them, without Flux's catalog (it would answer with Flux's own); null when unreadable or empty. */
export async function readCodexModels(config: SupervisorConfig, dir: string, person: Person): Promise<PlanModel[] | null> {
  let session;
  try {
    session = await openAppServer(config.cliPaths.codex, dir, config.egressHost, { timeoutMs: MODELS_TIMEOUT_MS, overrides: codexListOverrides(), person });
    const open = session;
    const models = reduceCodexModels(await collectCodexModels((method, params) => open.request(method, params)));
    return models.length ? models : null;
  } catch {
    return null;
  } finally {
    session?.close();
  }
}

/** The models of Claude Code's initialization answer; null when unreadable or empty. The process ends as soon as it has answered. */
export function readClaudeModels(config: SupervisorConfig, dir: string, person: Person): Promise<PlanModel[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let pending: Buffer = Buffer.alloc(0);
    const child = spawn(config.cliPaths.claude_code, [...CLAUDE_MODELS_TEMPLATE],
      { env: cliEnvironment('claude_code', dir, config.egressHost), cwd: dir, shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'], ...asPerson(person) });
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const finish = (models: PlanModel[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      resolve(models && models.length ? models : null);
    };
    const timer = setTimeout(() => finish(null), MODELS_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline === -1) break;
        const line = pending.subarray(0, newline).toString('utf8').trim();
        pending = pending.subarray(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        // Anything else the CLI writes (its own events) is not the answer; only the response to this request counts.
        if (!isObject(message) || message.type !== 'control_response' || !isObject(message.response) || message.response.request_id !== REQUEST_ID) continue;
        const answer = isObject(message.response.response) ? message.response.response : null;
        finish(message.response.subtype === 'success' && answer ? reduceClaudeModels(answer.models) : null);
        return;
      }
      if (pending.length > MAX_LINE_BYTES) finish(null);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
  });
}

/** The models of one CLI for the account signed in in the person's directory; null when it cannot say. */
export const readPlanModels = (config: SupervisorConfig, client: RuntimeClient, dir: string, person: Person): Promise<PlanModel[] | null> =>
  client === 'codex' ? readCodexModels(config, dir, person) : readClaudeModels(config, dir, person);
