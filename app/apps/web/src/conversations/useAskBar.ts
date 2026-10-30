import { useNavigate } from 'react-router';
import { grantAgentProject } from '../agent-connection/api';
import { requestAssistantJoin } from '../agents/api';
import { tellOperator } from '../assistant/api';
import { askState } from '../assistant/format';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useShellActions } from '../app/shellContext';
import type { AssistantAsk } from './useAssistantAsk';
import type { PaneCore } from './paneCore';

/**
 * What the ask bar says and offers (#68): the assistant's state, and when it is not in this project (Journey 6) the
 * one step that changes that. A manager can let their own assistant read this project; anyone else asks a manager.
 */
export function useAskBar({ me, project, people, audienceShort }: PaneCore, assistant: ReturnType<typeof useConversationAssistant>, ask: AssistantAsk) {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  const { setAskFailure, setAskFailureCode } = ask;
  const state = askState(assistant.status, audienceShort);
  const ownAgent = assistant.status?.enablement?.agents.find((item) => item.workspaceId === project.workspaceId)?.agentId ?? null;
  // Not in the project (Journey 6): known up front from the project's Agents view, or learned from a refused ask.
  const notIn = ask.askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS' || assistant.member === false;
  const managers = people?.filter((person) => person.kind === 'human' && person.access === 'manager' && person.id !== me.user.id) ?? [];
  const managerName = managers.length === 1 ? managers[0]!.name.trim().split(/\s+/)[0]! : 'a manager';
  const joined = () => { assistant.refreshMembership(); setAskFailure(''); setAskFailureCode(null); };
  const grantAction = notIn && project.access !== 'manager' && !assistant.requested ? {
    label: `Ask ${managerName} to add me`,
    run: () => { void requestAssistantJoin(project.id).then(joined).catch(() => setAskFailure('Couldn\'t ask. Try again.')); },
  } : notIn && project.access === 'manager' && ownAgent ? {
    label: 'Add my assistant here',
    run: () => { void grantAgentProject(project.id, ownAgent, 'viewer').then(joined).catch(() => setAskFailure('Couldn’t give it access. Try again.')); },
  } : null;
  const notInText = assistant.requested ? `Asked ${managerName} to add me. I'll do this when they do.`
    : project.access === 'manager' ? 'I\'m not in this project yet.' : 'I\'m not in this project yet. A manager can add me.';
  function onAction(action: string) {
    if (action === 'connect') openDetails('connect-ai');
    else if (action === 'resume') void assistant.resume().catch(() => setAskFailure('Couldn’t resume. Try again.'));
    else if (action === 'tell') void tellOperator(project.workspaceId, assistant.status?.setup.runtime.client).then(() => setAskFailure('Told whoever runs Flux.'), () => setAskFailure('Couldn’t tell them. Try again.'));
    else if (action === 'key') navigate('/settings/ai-connections');
    else navigate('/settings/assistant');
  }
  return { state, error: notIn ? notInText : ask.askFailure, grantAction, onAction };
}
