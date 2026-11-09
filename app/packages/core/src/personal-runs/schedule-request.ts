import { takeScheduleBlocks } from '../assistant/schedule-block.js';
import type { AnswerCleaner } from './answer-addresses.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

/**
 * The answer's words after "Set up by asking" (AG-9, #858): a schedule block in what the owner says to their agent in its private chat prepares a
 * schedule that stays off until their tap. Any other run's block (`/ai` in a place, a schedule's run) is removed and does nothing (AST-7.5).
 */
export async function answerWithSchedule(ports: PersonalRunPorts, run: Pick<RunRecord, 'id' | 'kind' | 'ownerUserId' | 'projectId' | 'dmId' | 'agentId'>, answer: string,
  cleaner: Pick<AnswerCleaner, 'clean'>): Promise<string> {
  if (!answer.includes('<schedule>')) return answer;
  const taken = takeScheduleBlocks(answer);
  // Only what the owner says to their agent in its private chat prepares a schedule (AG-9): not `/ai` in a space, not a run of a schedule.
  if (run.kind !== 'ask' || !taken.request || !ports.schedules || run.projectId !== null || run.dmId !== null) return taken.text;
  // The instruction is every later run's request (#1149, C-30): an address in it that carries private text this run read is left out.
  const request = { ...taken.request, text: await cleaner.clean(taken.request.text), ...(taken.request.title ? { title: await cleaner.clean(taken.request.title) } : {}) };
  const prepared = await ports.schedules.prepare(run.ownerUserId, run.agentId, run.id, request);
  if (!prepared.ok) return `${taken.text}\n\nI couldn't prepare that schedule: ${prepared.message}`.trim();
  return taken.text || `Ready: ${prepared.title}, ${prepared.words}. It stays off until you turn it on.`;
}
