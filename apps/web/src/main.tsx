import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@fontsource-variable/inter';
import './ui/tokens.css';
import './ui/ui.css';
import './app/app.css';
import { applyStoredTheme } from './app/theme';
import { registerServiceWorker } from './pwa';
import { router } from './router';

applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Registration waits for load so it never competes with the first render (#41).
window.addEventListener('load', () => { void registerServiceWorker(); });
