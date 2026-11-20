// PWA building blocks for the app shell (issue #41). main.tsx registers the service worker,
// the router root renders <UpdatePrompt />, the app shell refreshes the push subscription and sign-out
// calls signOutDevice(). <NotificationsButton /> and <InstallFlux /> are imported from their own files by
// the notification settings (a route of its own), so the first screen does not carry them.
export { registerServiceWorker, onServiceWorkerUpdate, serviceWorkerSupported, type ServiceWorkerUpdate } from './register.js';
export { getPushState, enablePushNotifications, disablePushNotifications, syncPushSubscription, type PushState, type EnableResult } from './push.js';
export { signOutDevice } from './session.js';
export { UpdatePrompt } from './UpdatePrompt.js';
export { watchInstallPrompt, onInstallState, installState, isStandalone, type InstallState } from './install.js';
