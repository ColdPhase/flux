import { takeScheduleBlocks } from '../assistant/schedule-block.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

/**
 * The answer's words after "Set up by asking" (F-027 AST-7): a schedule block in the owner's own request prepares a schedule that
 * stays off until their tap. Any other run's block (a background run, a summary) is removed and does nothing (AST-7.5).
 */
export async function answerWithSchedule(ports: PersonalRunPorts, run: Pick<RunRecord, 'id' | 'kind' | 'silent' | 'ownerUserId' | 'projectId'>, answer: string): Promise<string> {
  if (!answer.includes('<schedule>')) return answer;
  const taken = takeScheduleBlocks(answer);
  if (run.kind !== 'ask' || run.silent || !taken.request || !ports.schedules) return taken.text;
  const prepared = await ports.schedules.prepare(run.ownerUserId, run.projectId, run.id, taken.request);
  if (!prepared.ok) return `${taken.text}\n\nI couldn't prepare that schedule: ${prepared.message}`.trim();
  return taken.text || `Ready: ${prepared.title}, ${prepared.words}. It stays off until you turn it on.`;
}
