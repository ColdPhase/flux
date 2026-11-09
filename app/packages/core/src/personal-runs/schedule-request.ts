import { ASSISTANT_JOB_LIMITS } from '@flux/contracts';
import { titleFromText } from '../assistant/jobs.js';
import { takeScheduleBlocks, type ScheduleRequest } from '../assistant/schedule-block.js';
import type { AnswerCleaner } from './answer-addresses.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';
import { writtenAddresses } from './web-addresses.js';

/**
 * A run's answer as it will be committed, worked out before the commit's transaction (#1156): that transaction holds the space's task lock,
 * and cleaning reads and checks the run's kept text, which only the commit deletes. Its `<schedule>` block taken out, the answer and the
 * schedule's instruction cleaned (#1149, C-30), and the listed form of each result the run's searches cited.
 */
export interface PreparedAnswer { text: string; schedule: ScheduleRequest | null; cited: ReadonlyMap<string, string> }

export async function preparedAnswer(answer: string, cleaner: AnswerCleaner, cited: readonly string[]): Promise<PreparedAnswer> {
  const taken = answer.includes('<schedule>') ? takeScheduleBlocks(answer) : { text: answer, request: null };
  let schedule: ScheduleRequest | null = null;
  if (taken.request) {
    // The instruction is every later run's request (#1149, C-30): an address in it that carries private text this run read is left out.
    const instruction = await cleaner.clean(taken.request.text);
    // Its name, which the schedule keeps and the answer's "Ready: …" says: given, or the instruction's first words as a schedule takes them
    // (`titleFromText`), which can cut a link short; cleaned too, and plain "Schedule" when cleaning made it longer than a name may be.
    const title = await cleaner.clean(taken.request.title ?? titleFromText(instruction.trim()));
    schedule = { ...taken.request, text: instruction, title: title.length <= ASSISTANT_JOB_LIMITS.title ? title : 'Schedule' };
  }
  const text = await cleaner.cleanAnswer(taken.text);
  // An address the cleaned answer holds passed as written (Claude Code's answer names the results it cites, #1065); any other cited result
  // is checked the same way.
  const listed = new Map(writtenAddresses(text).map((address) => [address, address] as const));
  for (const address of cited) if (!listed.has(address)) listed.set(address, await cleaner.cited(address));
  return { text, schedule, cited: listed };
}

/**
 * The answer's words after "Set up by asking" (AG-9, #858): a schedule block in what the owner says to their agent in its private chat prepares a
 * schedule that stays off until their tap. Any other run's block (`/ai` in a place, a schedule's run) is removed and does nothing (AST-7.5).
 * Inside the commit's transaction, on the prepared answer.
 */
export async function answerWithSchedule(ports: PersonalRunPorts, run: Pick<RunRecord, 'id' | 'kind' | 'ownerUserId' | 'projectId' | 'dmId' | 'agentId'>,
  answer: Pick<PreparedAnswer, 'text' | 'schedule'>): Promise<string> {
  // Only what the owner says to their agent in its private chat prepares a schedule (AG-9): not `/ai` in a space, not a run of a schedule.
  if (run.kind !== 'ask' || !answer.schedule || !ports.schedules || run.projectId !== null || run.dmId !== null) return answer.text;
  const prepared = await ports.schedules.prepare(run.ownerUserId, run.agentId, run.id, answer.schedule);
  if (!prepared.ok) return `${answer.text}\n\nI couldn't prepare that schedule: ${prepared.message}`.trim();
  return answer.text || `Ready: ${prepared.title}, ${prepared.words}. It stays off until you turn it on.`;
}
