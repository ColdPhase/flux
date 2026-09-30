import { Icon, Spinner, type IconName } from '../ui';
import type { LiveValue } from './LiveProvider';
import type { DeviceKind, DeviceStatus } from './media';

const DEVICE: Record<DeviceKind, { on: IconName; off: IconName; name: string }> = {
  mic: { on: 'mic', off: 'mic-off', name: 'Microphone' },
  camera: { on: 'video', off: 'video-off', name: 'Camera' },
  screen: { on: 'screen', off: 'screen', name: 'Screen' },
};

/** What a device button says: never "on" unless it is really captured and published. */
function deviceLabel(kind: DeviceKind, status: DeviceStatus, sending: boolean) {
  const name = DEVICE[kind].name;
  if (status.state === 'starting') return `${name} is starting`;
  if (sending) return kind === 'screen' ? 'Stop sharing your screen' : `${name} on · turn off`;
  if (status.state === 'denied') return `${name} blocked by the browser · try again`;
  if (status.state === 'missing') return `No ${name.toLowerCase()} found`;
  if (status.state === 'busy') return `${name} is in use elsewhere · try again`;
  if (status.state === 'failed') return `${name} failed · try again`;
  if (status.state === 'unsupported') return `${name} not available in this browser`;
  return kind === 'screen' ? 'Share a window, tab or screen' : `${name} off · turn on`;
}

export function DeviceButton({ kind, live, compact = false }: { kind: DeviceKind; live: LiveValue; compact?: boolean }) {
  const status = live.media?.devices[kind] ?? { state: 'off', note: null };
  const me = live.media?.people.find((person) => person.local);
  const sending = kind === 'mic' ? !!me?.mic : kind === 'camera' ? !!me?.camera : !!me?.screen;
  const problem = ['denied', 'missing', 'busy', 'failed', 'unsupported'].includes(status.state);
  const label = deviceLabel(kind, status, sending);
  const connected = live.media?.connection === 'connected';
  return (
    <button type="button" className={`lv-dev lv-dev--${kind}${sending ? ' is-on' : ''}${problem ? ' is-problem' : ''}${compact ? ' lv-dev--compact' : ''}`}
      aria-pressed={sending} aria-label={label} data-tip={status.note ?? label} aria-disabled={!connected || status.state === 'starting' || undefined}
      onClick={() => { if (connected && status.state !== 'starting') void live.setDevice(kind, !sending); }}>
      {status.state === 'starting' ? <Spinner /> : <Icon name={sending ? DEVICE[kind].on : DEVICE[kind].off} size={16} />}
      {problem ? <span className="lv-dev__badge" aria-hidden="true">!</span> : null}
    </button>
  );
}
