// PWA building blocks for the app shell (issue #41). boot.tsx wires the update prompt today;
// the shell can render <UpdatePrompt /> and <NotificationsButton /> itself instead.
export { registerServiceWorker, onServiceWorkerUpdate, serviceWorkerSupported, type ServiceWorkerUpdate } from './register.js';
export { getPushState, enablePushNotifications, disablePushNotifications, syncPushSubscription, INBOX_URL, type PushState, type EnableResult } from './push.js';
export { signOutDevice } from './session.js';
export { UpdatePrompt } from './UpdatePrompt.js';
export { NotificationsButton } from './NotificationsButton.js';
