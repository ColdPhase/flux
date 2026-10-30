import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import './ui/tokens.css';
import './ui/ui.css';
import './app/app.css';
import { applyStoredSmallMoments } from './app/smallMoments';
import { applyStoredTextSize } from './app/textSize';
import { installMotionGuards } from './ui/motion';
import { applyStoredReduceMotion } from './ui/motion-preference';
import { installPress } from './ui/press';
import { applyStoredTheme } from './app/theme';
import { registerServiceWorker, watchInstallPrompt } from './pwa';
import { router } from './router';

applyStoredTheme();
applyStoredSmallMoments();
applyStoredReduceMotion();
applyStoredTextSize();
// Motion pauses while the page is hidden, and every pressable control takes the one press (#593).
installMotionGuards();
installPress();
// Chromium offers installation once per load, possibly before Settings is open (#20 MOB-1).
watchInstallPrompt();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Registration waits for load so it never competes with the first render (#41).
window.addEventListener('load', () => { void registerServiceWorker(); });
