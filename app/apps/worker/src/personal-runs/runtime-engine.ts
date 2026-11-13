import { RUN_CAP_BOUNDS, createRuntimeManagerClient, runtimeManagerPort, streamManagerRun, type ManagerRunOutcome, type RunFrame, type SupervisorRequest } from '@flux/runtime-protocol';
import {
  clientAvailability, keyRunPlace, type AgentRuntimeConfig, type PersonalRuntime, type PersonalRuntimeEnd, type PersonalRuntimeEvent,
} from '@flux/core';
import { agentRuntimeStore, markRuntimeSignInAgain, personalRuntimeRow, recordRuntimeUsage, touchRuntimeBinding, type Database } from '@flux/db';

// The worker's side of a personal run on the owner's own Claude Code or Codex (F-022 AIM-3 "Run", #280, #281): it asks
// runtime-manager to run the CLI in the owner's own slot and binding directory, read from the database for
// the run's owner, never from a request. The slot's run frames become progress; its result becomes the
// run's end. Nothing of the CLI's output is logged.

/** How the slot's outcome is recorded. */
function endOf(outcome: ManagerRunOutcome): PersonalRuntimeEnd {
  if (!outcome.ok) {
    // A stream that broke after the CLI started: unknown, never rerun. A refusal before it: unavailable.
    if (outcome.code === 'broken') return { kind: 'ended', reason: 'unknown' };
    if (outcome.code === 'busy') return { kind: 'ended', reason: 'slot_busy' };
    return { kind: 'ended', reason: 'unavailable' };
  }
  const result = outcome.result;
  switch (result.outcome) {
    case 'completed': return result.answer === null ? { kind: 'ended', reason: 'unknown' } : { kind: 'answer', text: result.answer, turns: result.turns };
    case 'plan_limit': return { kind: 'ended', reason: 'plan_limit', planResetsAt: result.resetsAt ? new Date(result.resetsAt) : null };
    default: return { kind: 'ended', reason: result.outcome };
  }
}

function eventOf(frame: RunFrame): PersonalRuntimeEvent {
  switch (frame.e) {
    case 'init': return { kind: 'init', tools: [...frame.tools], mcpServers: frame.servers.map((server) => ({ ...server })), ...(frame.own ? { own: true as const } : {}) };
    case 'tool': return { kind: 'tool', name: frame.name };
    case 'search': return { kind: 'search', n: frame.n, query: frame.query };
    case 'found': return { kind: 'found', n: frame.n, results: [...frame.results], queries: [...(frame.queries ?? [])] };
    case 'text': return { kind: 'text', turn: frame.turn, text: frame.text };
  }
}

/**
 * `webSearch`: the operator's web switch (`FLUX_WEB_READS`, C-29). On, a run keeps the CLI's own web search (#1065, RT-5): Claude Code's
 * `WebSearch`, Codex's web search on OpenAI's cached index.
 */
export function managerPersonalRuntime(config: AgentRuntimeConfig, db: Database, { webSearch = false }: { webSearch?: boolean } = {}): PersonalRuntime {
  const manager = config.manager;
  const states = clientAvailability(config);
  // API-key agents in pi (#1441): `pi` in FLUX_AGENT_RUNTIME.
  const keys = !!manager && config.keys === true;
  const enabled = !!manager && (states.claude_code === 'available' || states.codex === 'available' || keys);
  const client = manager ? createRuntimeManagerClient(manager) : null;
  return {
    enabled,
    webSearch,
    keys,
    async target(ownerUserId, cli = 'claude_code') {
      if (cli === 'pi') {
        // pi needs no sign-in: the owner's place in the runtime, made now when they have none.
        if (!keys || !client) return { ok: false, reason: 'off' };
        const place = await keyRunPlace(agentRuntimeStore(db), runtimeManagerPort(client), ownerUserId);
        return place ? { ok: true, target: { ...place, client: 'pi' } } : { ok: false, reason: 'unavailable' };
      }
      if (!enabled || states[cli] !== 'available') return { ok: false, reason: 'off' };
      const row = await personalRuntimeRow(db, ownerUserId, [cli]);
      if (row.state === 'signed_in' && row.slot && row.bindingId) return { ok: true, target: { slot: row.slot, bindingId: row.bindingId, client: cli } };
      return { ok: false, reason: row.state === 'sign_in_again' ? 'sign_in_again' : 'unavailable' };
    },
    async run(target, request, onEvent) {
      if (!manager) return { kind: 'ended', reason: 'unavailable' };
      await touchRuntimeBinding(db, target.bindingId).catch(() => undefined);
      const caps = {
        maxTurns: Math.min(Math.max(request.caps.maxTurns, RUN_CAP_BOUNDS.maxTurns.min), RUN_CAP_BOUNDS.maxTurns.max),
        wallClockSeconds: Math.min(Math.max(request.caps.wallClockSeconds, RUN_CAP_BOUNDS.wallClockSeconds.min), RUN_CAP_BOUNDS.wallClockSeconds.max),
        idleSeconds: Math.min(Math.max(request.caps.idleSeconds, RUN_CAP_BOUNDS.idleSeconds.min), RUN_CAP_BOUNDS.idleSeconds.max),
        maxAnswerBytes: Math.min(Math.max(request.caps.maxAnswerBytes, RUN_CAP_BOUNDS.maxAnswerBytes.min), RUN_CAP_BOUNDS.maxAnswerBytes.max),
      };
      const client = target.client ?? 'claude_code';
      const common = { bindingId: target.bindingId, runId: request.runId, prompt: request.prompt, runToken: request.runToken, tools: request.tools, caps,
        ...(request.webSearch ? { webSearch: true as const } : {}) };
      // A key run in pi (#1441): the key's provider and model; the key itself stays with Flux's model gateway.
      const sent: Extract<SupervisorRequest, { kind: 'run' }> | null = client === 'pi'
        ? (request.key && request.model ? { kind: 'run', client, ...common, model: request.model, provider: request.key.provider, ...(request.key.pictures ? { pictures: true as const } : {}) } : null)
        : { kind: 'run', client, ...common, ...(request.model ? { model: request.model } : {}) };
      if (!sent) return { kind: 'ended', reason: 'unavailable' };
      const outcome = await streamManagerRun(manager, target.slot, sent, (frame) => onEvent(eventOf(frame)));
      if (client === 'pi') return endOf(outcome);
      // Connect AI's usage line (#854): what the provider reported (Codex's own read), or the limit the run met.
      if (outcome.ok) {
        const result = outcome.result;
        const usage = result.outcome === 'plan_limit'
          ? { leftPercent: 0, window: result.usage?.window ?? null, resetsAt: result.resetsAt ? new Date(result.resetsAt) : null, limitReached: true }
          : result.usage ? { leftPercent: result.usage.leftPercent, window: result.usage.window, resetsAt: result.usage.resetsAt ? new Date(result.usage.resetsAt) : null, limitReached: result.usage.leftPercent === 0 }
            // A finished run shows the plan is usable again, even before the reset it stated.
            : result.outcome === 'completed' ? { leftPercent: null, window: null, resetsAt: null, limitReached: false } : null;
        if (usage) await recordRuntimeUsage(db, target.bindingId, client, usage).catch(() => undefined);
        // #1129: the CLI said its login no longer works; its status may still report one (a revoked key or token), so Settings says so.
        if (result.outcome === 'sign_in_again') await markRuntimeSignInAgain(db, target.bindingId, client).catch(() => undefined);
      }
      return endOf(outcome);
    },
    async stop(target, runId) {
      if (!client) return 'failed';
      const answer = await client.request(target.slot, { kind: 'stop', bindingId: target.bindingId, runId });
      return answer.ok && answer.result.kind === 'stop' ? answer.result.state : 'failed';
    },
  };
}
