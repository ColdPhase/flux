// The `runtime` transport's internal protocol (F-022 AIM-3): names, the supervisor's closed request
// set, its answer frames, the bounded stream reader and the manager's API and client. Node built-ins
// only, so the slot image carries nothing else.
export * from './names.js';
export * from './shape.js';
export * from './requests.js';
export * from './frames.js';
export * from './ndjson.js';
export * from './supervisor-client.js';
export * from './manager-api.js';
export * from './redact.js';
export * from './manager-port.js';
