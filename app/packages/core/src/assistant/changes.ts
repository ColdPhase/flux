import type { AgentMayDo, AssistantChangeState, AssistantWaitReason } from '@flux/contracts';

// How an agent's change is decided (F-036 AG-3, #855). Pure: the server's executor gathers the facts inside the change's
// transaction and records the outcome in the change log in that same transaction.

export interface AssistantChangeFacts {
  /** The agent's "What it may do". */
  mayDo: AgentMayDo;
  /** The owner can make this change themselves now (current project write access): the agent's rights are exactly the owner's. */
  ownerCanWrite: boolean;
  /** Deleting anything (a thought, a link). */
  removal: boolean;
  /** New, or the owner's or their agents' own thing; false for another person's thing. */
  mine: boolean;
  /** A task created for another person (its owner is someone else, or someone else's agent). */
  forOther: boolean;
}
export type AssistantChangeOutcome = { state: 'apply' } | { state: 'waiting'; reason: AssistantWaitReason }
  | { state: 'refused'; reason: 'only_read' | 'outside_rights' };

/**
 * F-036 AG-3. "Only read" changes nothing, and nothing outside the owner's rights is ever possible (no suggestion is prepared
 * for anyone). Deleting and other people's things (a task for another person included) always wait, whatever the choice; "Ask
 * me first" waits for everything else too; "Do it and tell me" applies the rest at once.
 */
export function classifyAssistantChange(facts: AssistantChangeFacts): AssistantChangeOutcome {
  if (facts.mayDo === 'read') return { state: 'refused', reason: 'only_read' };
  if (!facts.ownerCanWrite) return { state: 'refused', reason: 'outside_rights' };
  if (facts.removal) return { state: 'waiting', reason: 'removal' };
  if (!facts.mine || facts.forOther) return { state: 'waiting', reason: 'others' };
  if (facts.mayDo === 'ask') return { state: 'waiting', reason: 'ask' };
  return { state: 'apply' };
}

/** What the agent says instead of changing, in plain words, when its change cannot be made (F-036 AG-3 "Never possible"). */
export const REFUSALS: Readonly<Record<'only_read' | 'outside_rights', string>> = {
  only_read: 'I only read: my owner set "What it may do" to Only read, so I changed nothing',
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
    case 'ask': return 'Waits for your OK: you asked it to check with you first.';
    default: return null;
  }
}
