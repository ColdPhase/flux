import { takeScheduleBlocks } from '../assistant/schedule-block.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

/**
 * The answer's words after "Set up by asking" (AG-9, #858): a schedule block in what the owner says to their agent in its private chat prepares a
 * schedule that stays off until their tap. Any other run's block (`/ai` in a place, a schedule's run) is removed and does nothing (AST-7.5).
 */
export async function answerWithSchedule(ports: PersonalRunPorts, run: Pick<RunRecord, 'id' | 'kind' | 'ownerUserId' | 'projectId' | 'dmId' | 'agentId'>, answer: string): Promise<string> {
  if (!answer.includes('<schedule>')) return answer;
  const taken = takeScheduleBlocks(answer);
  // Only what the owner says to their agent in its private chat prepares a schedule (AG-9): not `/ai` in a space, not a run of a schedule.
  if (run.kind !== 'ask' || !taken.request || !ports.schedules || run.projectId !== null || run.dmId !== null) return taken.text;
  const prepared = await ports.schedules.prepare(run.ownerUserId, run.agentId, run.id, taken.request);
  if (!prepared.ok) return `${taken.text}\n\nI couldn't prepare that schedule: ${prepared.message}`.trim();
  return taken.text || `Ready: ${prepared.title}, ${prepared.words}. It stays off until you turn it on.`;
}
