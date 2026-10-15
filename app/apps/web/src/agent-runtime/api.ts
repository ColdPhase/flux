import {
  AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_NOTICE_PATH, AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH,
  type AgentRuntimeClient, type AgentRuntimeConsoleTicket, type AgentRuntimeStatus, type ClaudeCodeSignInMethod,
} from '@flux/contracts';
import { request } from '../api/client';

// The owner's agent runtime (F-022 AIM-3). Every call acts as the signed-in person: the server names
// the slot from the session, never from these bodies, and no body carries a token, key or login.

export const getRuntime = (signal?: AbortSignal) => request<AgentRuntimeStatus>(AGENT_RUNTIME_PATH, { signal });
export const removeRuntime = () => request<AgentRuntimeStatus>(AGENT_RUNTIME_BINDING_PATH, { method: 'DELETE' });
export const consoleTicket = (method: ClaudeCodeSignInMethod) =>
  request<AgentRuntimeConsoleTicket>(AGENT_RUNTIME_CONSOLE_PATH, { method: 'POST', body: { client: 'claude_code', method } });
export const signOutRuntime = (client: AgentRuntimeClient) => request<AgentRuntimeStatus>(AGENT_RUNTIME_SIGN_OUT_PATH, { method: 'POST', body: { client } });
export const checkRuntime = (client: AgentRuntimeClient) => request<AgentRuntimeStatus>(AGENT_RUNTIME_CHECK_PATH, { method: 'POST', body: { client } });
export const dismissNotice = (client: AgentRuntimeClient) => request<AgentRuntimeStatus>(AGENT_RUNTIME_NOTICE_PATH, { method: 'POST', body: { client } });

export function consoleSocketUrl(): string {
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${AGENT_RUNTIME_CONSOLE_PATH}`;
}
