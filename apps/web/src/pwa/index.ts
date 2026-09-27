// PWA building blocks for the app shell (issue #41). main.tsx registers the service worker,
// the router root renders <UpdatePrompt />, the account menu renders <NotificationsButton />,
// the app shell refreshes the push subscription and sign-out calls signOutDevice().
export { registerServiceWorker, onServiceWorkerUpdate, serviceWorkerSupported, type ServiceWorkerUpdate } from './register.js';
export { getPushState, enablePushNotifications, disablePushNotifications, syncPushSubscription, INBOX_URL, type PushState, type EnableResult } from './push.js';
export { signOutDevice } from './session.js';
export { UpdatePrompt } from './UpdatePrompt.js';
export { NotificationsButton } from './NotificationsButton.js';
