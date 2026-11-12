import type { ReactNode } from 'react';
import type { Conversation } from '@flux/contracts';
import { AnswerItem, type SourceLookups } from '../assistant/ConversationParts';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { WaitingChanges, type useAssistantChanges } from '../assistant/WaitingChanges';
import { clock, when } from '../app/messageParts';
import type { useReferenceWork } from '../work/useReferenceWork';
import type { FeedEntry } from './feed';

export interface AnswerContext {
  meId: string; projectId: string; writable: boolean; messages: Conversation['messages'];
  assistant: ReturnType<typeof useConversationAssistant>; changes: ReturnType<typeof useAssistantChanges>; referenceWork: ReturnType<typeof useReferenceWork>;
  author: (id: string) => string;
  /** The first names of the other people who read this place: they do not see the asker's private answer (#842). */
  others: string[];
  /** Where a private answer's citations point. */
  lookups: SourceLookups;
  /** "Ask about this" opens the ask mode in this pane's field; null where it cannot. */
  onAskAbout: (() => void) | null;
}
type AnswerEntry = Extract<FeedEntry, { type: 'answer' }>;
const applied = (state: string) => state === 'applied' || state === 'applied_after_wait';

/** The assistant's answer at `index` of the thread's feed. */
export function answerElements(entry: AnswerEntry, context: AnswerContext): ReactNode[] {
  const { meId, assistant, changes, referenceWork } = context;
  const lookups = { projectId: context.projectId, messages: context.messages, work: referenceWork.rows, author: context.author, people: context.lookups.people };
  const answerItem = (item: AnswerEntry) => {
    const answer = item.answer;
    const runChanges = changes.byRun.get(answer.runId);
    return <AnswerItem key={item.key} answer={answer} mine={answer.assistant.ownerUserId === meId} lookups={lookups} when={when} clock={clock}
      resultInMessage={!!runChanges?.some((change) => applied(change.state))} changes={runChanges ? <WaitingChanges changes={runChanges} onChanged={changes.refresh} meId={meId} /> : null}
      onRetry={() => assistant.retry(answer.runId)}
      onContinue={async () => { await assistant.ask('Continue', { continuesRunId: answer.runId }); }}
      onAskAbout={context.onAskAbout} />;
  };
  return [answerItem(entry)];
}
