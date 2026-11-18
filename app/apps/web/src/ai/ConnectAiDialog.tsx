import { useEffect, useState } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import type { AgentRuntimeStatus, BackgroundComputeConnection } from '@flux/contracts';
import { getRuntime } from '../agent-runtime/api';
import { getAssistantStatus } from '../assistant/api';
import { refreshAssistantModel } from '../assistant/model';
import { useShellData } from '../app/data';
import { isManagerRole } from '../people/api';
import { listBackgroundConnections } from './api';
import { connectionLines } from './connections';
import { ConnectAiWindow } from './ConnectAiWindow';
import { AI_CONNECTED_EVENT } from './connected';

/**
 * The Connect AI window opened where the person is (#1424): the composer's "Connect your AI" (after `/ai` without an assistant) opens the same
 * window as Settings › AI and Home's Connect AI, not a page or panel of its own. It reads what Settings › AI reads first (the server's plans, the
 * person's keys and whether this server runs agents on API keys), so the window offers exactly what it offers there.
 */
export default function ConnectAiDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { workspace } = useShellData();
  const [runtime, setRuntime] = useState<AgentRuntimeStatus | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [keys, setKeys] = useState<BackgroundComputeConnection[] | null>(null);
  const [apiKeys, setApiKeys] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    getRuntime(signal).then(setRuntime, () => { if (!signal.aborted) setRuntimeFailed(true); });
    listBackgroundConnections(signal).then(setKeys, () => { if (!signal.aborted) setKeys([]); });
    getAssistantStatus(signal).then((status) => setApiKeys(status.setup.provider === 'on'), () => { if (!signal.aborted) setApiKeys(true); });
    return () => controller.abort();
  }, []);
  // The window opens once it knows what to offer, so a plan's row never appears under the person's pointer a moment later.
  if ((runtime === null && !runtimeFailed) || keys === null || apiKeys === null) return null;
  const have = new Set(connectionLines(runtime, keys).map((line) => line.kind));
  return (
    <ConnectAiWindow runtime={runtime} runtimeFailed={runtimeFailed} apiKeys={apiKeys} manager={isManagerRole(workspace?.role)} have={have} onClose={onClose}
      onLocalClient={() => { onClose(); void navigate('/settings/agents/connect'); }}
      onConnected={() => {
        onClose();
        // The first connection gives the person their Assistant on the server: the shell's agents, the models and the ask bar are read again.
        void revalidator.revalidate(); void refreshAssistantModel();
        window.dispatchEvent(new Event(AI_CONNECTED_EVENT));
      }} />
  );
}
