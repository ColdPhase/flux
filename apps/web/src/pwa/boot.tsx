import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './register.js';
import { syncPushSubscription } from './push.js';
import { UpdatePrompt } from './UpdatePrompt.js';

// Separate entry so the PWA pieces do not depend on the app shell's own root. Registration
// waits for load so it never competes with the first render.
const host = document.createElement('div');
host.id = 'flux-pwa';
document.body.append(host);
createRoot(host).render(<UpdatePrompt />);
window.addEventListener('load', () => {
  void registerServiceWorker().then((registration) => {
    // Refresh an existing subscription (never prompts); ignored when signed out.
    if (registration) void syncPushSubscription().catch(() => undefined);
  });
});
