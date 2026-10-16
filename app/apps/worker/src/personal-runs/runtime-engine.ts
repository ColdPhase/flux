import { RUN_CAP_BOUNDS, createRuntimeManagerClient, streamManagerRun, type ManagerRunOutcome, type RunFrame } from '@flux/runtime-protocol';
import {
  clientAvailability, type AgentRuntimeConfig, type Database, type PersonalRuntime, type PersonalRuntimeEnd, type PersonalRuntimeEvent,
} from '@flux/core';
import { personalRuntimeRow, touchRuntimeBinding } from '@flux/db';

// The worker's side of a personal run on the owner's own Claude Code (F-022 AIM-3 "Run", #280): it asks
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
  return frame.e === 'init' ? { kind: 'init', tools: [...frame.tools], mcpServers: frame.servers.map((server) => ({ ...server })) } : { kind: 'tool', name: frame.name };
}

export function managerPersonalRuntime(config: AgentRuntimeConfig, db: Database): PersonalRuntime {
  const manager = config.manager;
  const enabled = !!manager && clientAvailability(config).claude_code === 'available';
  const client = manager ? createRuntimeManagerClient(manager) : null;
  return {
    enabled,
    async target(ownerUserId) {
      if (!enabled) return { ok: false, reason: 'off' };
      const row = await personalRuntimeRow(db, ownerUserId);
      if (row.state === 'signed_in' && row.slot && row.bindingId) return { ok: true, target: { slot: row.slot, bindingId: row.bindingId } };
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
      const outcome = await streamManagerRun(manager, target.slot, { kind: 'run', bindingId: target.bindingId, client: 'claude_code', runId: request.runId,
        prompt: request.prompt, runToken: request.runToken, tools: request.tools, caps }, (frame) => onEvent(eventOf(frame)));
      return endOf(outcome);
    },
    async stop(target, runId) {
      if (!client) return 'failed';
      const answer = await client.request(target.slot, { kind: 'stop', bindingId: target.bindingId, runId });
      return answer.ok && answer.result.kind === 'stop' ? answer.result.state : 'failed';
    },
  };
}
