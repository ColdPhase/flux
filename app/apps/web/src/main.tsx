import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { pageLeaving } from './api/pageLeaving';
import { RouterProvider } from 'react-router/dom';
import './ui/tokens.css';
import './ui/ui.css';
import './app/app.css';
import { applyStoredSmallMoments } from './app/smallMoments';
import { installMotionGuards } from './ui/motion';
import { installPress } from './ui/press';
import { installInputMode } from './ui/inputMode';
import { applyStoredTheme } from './app/theme';
import { registerServiceWorker, watchInstallPrompt } from './pwa';
import { router } from './router';

// The app scrolls in its panes, which keep and restore their own places (#592). A Back or Forward with the browser’s restoration on
// also made WebKit scroll to the address's fragment: a message link's #message-… went to the top of the stream and took the focus (#1530).
window.history.scrollRestoration = 'manual';
applyStoredTheme();
applyStoredSmallMoments();
// Motion pauses while the page is hidden, and every pressable control takes the one press (#593).
installMotionGuards();
installPress();
// Only the keyboard draws a focus ring: a tap or a click turns the rings off until the next key (#1424).
installInputMode();
// Chromium offers installation once per load, possibly before Settings is open (#20 MOB-1).
watchInstallPrompt();

// A render that failed and was recovered while the page is being left (its code download cut off by the leave, #471) is not
// an error of the page the person sees next; any other recovered error is still reported as React reports it.
createRoot(document.getElementById('root')!, {
  onRecoverableError: (error) => { if (!pageLeaving()) reportError(error); },
}).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Registration waits for load so it never competes with the first render (#41).
window.addEventListener('load', () => { void registerServiceWorker(); });
