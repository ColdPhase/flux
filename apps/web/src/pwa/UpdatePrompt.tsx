import { useEffect, useState, type CSSProperties } from 'react';
import { onServiceWorkerUpdate, type ServiceWorkerUpdate } from './register.js';

const bar: CSSProperties = {
  position: 'fixed',
  left: 'max(16px, env(safe-area-inset-left))',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(16px, env(safe-area-inset-bottom))',
  margin: '0 auto',
  maxWidth: 480,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 10px 10px 16px',
  borderRadius: 10,
  border: '1px solid #E7E7EA',
  background: '#FFFFFF',
  color: '#1B1C1F',
  boxShadow: '0 4px 16px rgba(16, 17, 19, 0.12)',
  font: '14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  zIndex: 1000,
};

const button: CSSProperties = {
  marginLeft: 'auto',
  minHeight: 44,
  minWidth: 44,
  padding: '0 16px',
  border: 0,
  borderRadius: 8,
  background: '#5159C8',
  color: '#FFFFFF',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
};

/**
 * Shows "A new version is available" while an updated service worker waits. Reloading is the
 * person's choice, so unsent input is never discarded by an automatic update.
 */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<ServiceWorkerUpdate | null>(null);
  useEffect(() => onServiceWorkerUpdate(setUpdate), []);
  if (!update) return null;
  return (
    <div role="status" aria-live="polite" style={bar} data-testid="flux-update-prompt">
      <span>A new version of Flux is available.</span>
      <button type="button" style={button} onClick={() => update.apply()}>Reload</button>
    </div>
  );
}
