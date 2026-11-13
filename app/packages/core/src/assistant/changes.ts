import type { AgentMayDo, AssistantChangeState, AssistantWaitReason } from '@flux/contracts';

// How an agent's change is decided (F-036 AG-3, #855). Pure: the server's executor gathers the facts inside the change's
// transaction and records the outcome in the change log in that same transaction.

export interface AssistantChangeFacts {
  /** The agent's Ask me first. */
  mayDo: AgentMayDo;
  /** The owner can make this change themselves now (current project write access): the agent's rights are exactly the owner's. */
  ownerCanWrite: boolean;
  /** Deleting anything (a thought, a link). */
  removal: boolean;
  /** New, or the owner's or their agents' own thing; false for another person's thing. */
  mine: boolean;
  /** A task created for another person (its owner is someone else, or someone else's agent). */
  forOther: boolean;
  /**
   * A run's change would tell a person other than the owner something (#1089): a task that waits for them, or a decision about
   * their task, which notifies them with its words. An agent sends no message to another person by itself (AG-3, AG-4).
   */
  tells?: boolean;
}
export type AssistantChangeOutcome = { state: 'apply' } | { state: 'waiting'; reason: AssistantWaitReason }
  | { state: 'refused'; reason: 'outside_rights' };

/**
 * F-036 AG-3. Nothing outside the owner's rights is ever possible (no suggestion is prepared for anyone). Deleting, other people's things
 * (a task for another person included) and what would tell another person always wait, whatever the switch; Ask me first on waits for
 * everything else too; off ("Do it and tell me") applies the rest at once.
 */
export function classifyAssistantChange(facts: AssistantChangeFacts): AssistantChangeOutcome {
  if (!facts.ownerCanWrite) return { state: 'refused', reason: 'outside_rights' };
  if (facts.removal) return { state: 'waiting', reason: 'removal' };
  if (!facts.mine || facts.forOther) return { state: 'waiting', reason: 'others' };
  if (facts.tells) return { state: 'waiting', reason: 'tells' };
  if (facts.mayDo === 'ask') return { state: 'waiting', reason: 'ask' };
  return { state: 'apply' };
}

/** What the agent says instead of changing, in plain words, when its change cannot be made (F-036 AG-3 "Never possible"). */
export const REFUSALS: Readonly<Record<'outside_rights', string>> = {
  outside_rights: 'My owner can\'t change this, so neither can I',
};

export interface AssistantWaitLineInput {
  state: AssistantChangeState;
  waitReason: AssistantWaitReason | null;
  noun: string;
  operation: string;
  /** The other person: the thing's maker, or the person a task is for. */
  otherName: string | null;
  refusal: string | null;
  decidedByName: string | null;
}

/** The plain words of one change that is not simply done (F-036 AG-3): why it waits, who decided, or why it was not made. */
export function assistantWaitLine(input: AssistantWaitLineInput): string | null {
  switch (input.state) {
    case 'applied': return null;
    case 'applied_after_wait': return input.decidedByName ? `Approved by ${input.decidedByName}` : 'Approved';
    case 'skipped': return input.waitReason === 'removal' || input.operation.endsWith('.delete') ? 'Kept' : 'Skipped';
    case 'undone': return input.decidedByName ? `Undone by ${input.decidedByName}` : 'Undone';
    case 'refused': return input.refusal ?? 'Not applied';
    case 'waiting': break;
  }
  switch (input.waitReason) {
    case 'removal': return 'Deleting always waits for your OK.';
    case 'others': return input.operation === 'work.create' ? 'Tasks for other people wait for your OK.'
      : `${input.otherName ?? 'Someone else'}'s ${input.noun}: other people's things wait for your OK.`;
    case 'tells': return `It would notify ${input.otherName ?? 'someone else'}: what tells other people waits for your OK.`;
    case 'ask': return 'Waits for your OK: you asked it to check with you first.';
    default: return null;
  }
}
