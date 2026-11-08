import { useNavigate } from 'react-router';
import { tellOperator } from '../assistant/api';
import { grantPerson } from '../people/api';
import { askState } from '../assistant/format';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useShellActions } from '../app/shellContext';
import type { AssistantAsk } from './useAssistantAsk';
import type { PaneCore } from './paneCore';

/**
 * What the ask bar says and offers (#68): the assistant's state. The assistant has exactly its owner's rights (F-036 AG-3), so it is in
 * every space its owner belongs to; nobody asks a manager to let it in. A company owner or admin can open a space without being in it
 * (C-15): there the bar says the assistant works only in spaces they are in, and offers Add me, the same step as in Settings › Company.
 */
export function useAskBar({ project, me, outside, audienceShort, revalidateRef }: PaneCore, assistant: ReturnType<typeof useConversationAssistant>, ask: AssistantAsk) {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  const { setAskFailure } = ask;
  const state = askState(assistant.status, audienceShort, outside);
  // A refused ask of someone who belongs here: the owner can no longer read here, so neither can their assistant. (Someone outside is told by the state.)
  const notIn = !outside && ask.askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS';
  const notInText = 'You can\'t open this space any more, so neither can your assistant.';
  function onAction(action: string) {
    if (action === 'join') void grantPerson(project.id, me.user.id, 'manager', crypto.randomUUID()).then(() => { setAskFailure(''); revalidateRef.current(); }, () => setAskFailure('You couldn’t be added. Try again.'));
    else if (action === 'connect') openDetails('connect-ai');
    else if (action === 'tell') void tellOperator(project.workspaceId, assistant.status?.setup.runtime.client).then(() => setAskFailure('Told whoever runs Flux.'), () => setAskFailure('Couldn’t tell them. Try again.'));
    else if (action === 'key') navigate('/settings/ai-connections?new=1');
    else navigate('/settings/agents');
  }
  return { state, error: notIn ? notInText : ask.askFailure, onAction };
}
