import type { AssistantChangeState, AssistantWaitReason } from '@flux/contracts';

// How an assistant run's change is decided (F-027 AST-5, A3 #403). Pure: the server's executor gathers the
// facts inside the change's transaction and records the outcome in the change log in that same transaction.

export interface AssistantChangeFacts {
  /** The owner's choice: "Do it and tell me" (`act`) or "Ask me first" (`ask`). */
  mode: 'act' | 'ask';
  /** The owner can make this change themselves now (current project write access). */
  ownerCanWrite: boolean;
  /** Removing a thought or a link (always waits, case 1). */
  removal: boolean;
  /** New, or made by the owner or their assistant; false for another person's thing (case 2). */
  mine: boolean;
  /** Another person has the page open in a live session (case 4). */
  liveTypist: boolean;
  /** Automatic changes the run has already used, and its limit (case 5). */
  reserved: number;
  limit: number;
}
export type AssistantChangeOutcome = { state: 'apply' } | { state: 'waiting'; reason: AssistantWaitReason };

/**
 * The combination table of AST-5. Outside the owner's rights it is a suggestion for whoever can decide it;
 * removals and other people's things wait in both modes; past the run's limit the rest wait; a page someone
 * is typing in is deferred in "Do it and tell me" and waits for the owner in "Ask me first"; "Ask me first"
 * waits for everything; otherwise the change applies at once.
 */
export function classifyAssistantChange(facts: AssistantChangeFacts): AssistantChangeOutcome {
  if (!facts.ownerCanWrite) return { state: 'waiting', reason: 'outside_rights' };
  if (facts.removal) return { state: 'waiting', reason: 'removal' };
  if (!facts.mine) return { state: 'waiting', reason: 'others' };
  if (facts.mode === 'ask') return { state: 'waiting', reason: 'ask' };
  if (facts.reserved >= facts.limit) return { state: 'waiting', reason: 'limit' };
  if (facts.liveTypist) return { state: 'waiting', reason: 'live_wiki' };
  return { state: 'apply' };
}

export interface AssistantChangeLineInput {
  state: AssistantChangeState;
  waitReason: AssistantWaitReason | null;
  phrase: string;
  noun: string;
  objectTitle: string;
  ownerName: string;
  /** The other person: the object's maker, the live typist or the suggestion's recipient. */
  otherName: string | null;
  limit: number;
  sent: boolean;
  refusal: string | null;
  decidedByName: string | null;
}

/** The plain words of one change (AST-5.3: the reason shown in plain words; F-027 "The one line everywhere else"). */
export function assistantChangeLine(input: AssistantChangeLineInput): string | null {
  const title = input.objectTitle ? ` ${input.objectTitle}` : '';
  const other = input.otherName ?? 'someone else';
  switch (input.state) {
    case 'applied': return null;
    case 'applied_after_wait': return input.decidedByName ? `Approved by ${input.decidedByName}` : 'Applied when the page was free';
    case 'not_now': return 'Not now';
    case 'expired': return `Expired: ${input.phrase} · Ask again`;
    case 'undone': return `Undone`;
    case 'refused': return input.refusal ?? 'Not applied';
    case 'waiting': break;
  }
  switch (input.waitReason) {
    case 'ask': return 'You asked me to check with you first';
    case 'removal': return `Removing a ${input.noun} always waits for you`;
    case 'others': return `${other}'s ${input.noun}: changing it waits for you`;
    case 'limit': return `Past this request's limit of ${input.limit} changes`;
    case 'live_wiki': return `I'll edit${title} when ${other} finishes typing.`;
    case 'conflict': return `${other} changed${title} while typing. Check it before applying`;
    case 'outside_rights': return input.sent ? `Sent to ${other}`
      : `${input.objectTitle ? `${other} owns ${input.objectTitle}` : `${other} can decide this`}. Suggest this change to them? · Send to ${other}`;
    default: return null;
  }
}
