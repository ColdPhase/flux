import { useNavigate } from 'react-router';
import { tellOperator } from '../assistant/api';
import { askState } from '../assistant/format';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useShellActions } from '../app/shellContext';
import type { AssistantAsk } from './useAssistantAsk';
import type { PaneCore } from './paneCore';

/**
 * What the ask bar says and offers (#68): the assistant's state. The assistant has exactly its owner's rights (F-036 AG-3),
 * so it is in every project its owner can read; nobody asks a manager to let it in.
 */
export function useAskBar({ project, audienceShort }: PaneCore, assistant: ReturnType<typeof useConversationAssistant>, ask: AssistantAsk) {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  const { setAskFailure } = ask;
  const state = askState(assistant.status, audienceShort);
  // A refused ask: the owner can no longer read here, so neither can their assistant.
  const notIn = ask.askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS';
  const notInText = 'You can\'t open this space any more, so neither can your assistant.';
  function onAction(action: string) {
    if (action === 'connect') openDetails('connect-ai');
    else if (action === 'resume') void assistant.resume().catch(() => setAskFailure('Couldn’t resume. Try again.'));
    else if (action === 'tell') void tellOperator(project.workspaceId, assistant.status?.setup.runtime.client).then(() => setAskFailure('Told whoever runs Flux.'), () => setAskFailure('Couldn’t tell them. Try again.'));
    else if (action === 'key') navigate('/settings/ai-connections');
    else navigate('/settings/assistant');
  }
  return { state, error: notIn ? notInText : ask.askFailure, onAction };
}
