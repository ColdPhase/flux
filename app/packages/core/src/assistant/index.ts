export { assistantSettingsUseCases, normalizeAssistantSettings } from './service.js';
export type { AssistantSettingsPort, AssistantIdentityPort, AssistantJoinPort } from './ports.js';
export { assistantChangeLine, classifyAssistantChange, type AssistantChangeFacts, type AssistantChangeLineInput, type AssistantChangeOutcome } from './changes.js';
export { changedParagraphs, fieldWords, restorableFields, undoSentence, type UndoPlan, type UndoRecord } from './undo.js';
