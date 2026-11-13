import { NEEDS_YOU_REASONS, type NotificationLevel, type NotificationReason } from '@flux/contracts';

/**
 * Each reason a notification has, in the words of the line under a level (#1173). The line names exactly the reasons that reach the
 * person by push and email at that level (`channelsOf` in core), so it says what they will get; a reason without words does not build,
 * and `notification-level-words.test.ts` pins the lines against the reasons.
 */
export const REASON_WORDS: Record<NotificationReason, string> = {
  question: 'questions', mention: 'mentions', dm: 'messages to you', assigned: 'tasks that need you',
  review: 'decisions about your work', invitation: 'invitations to a call', approval: 'agents waiting for you',
  reply: 'every reply in conversations you are part of', call: 'calls started in your spaces',
};
/** The order a line names them in. */
const ORDER: readonly NotificationReason[] = ['question', 'mention', 'dm', 'assigned', 'review', 'invitation', 'approval', 'reply', 'call'];
const needsYou = new Set<NotificationReason>(NEEDS_YOU_REASONS);

/** What interrupts the person by push and email at each level. The Inbox keeps every reason at each. */
export const LEVEL_REASONS: Record<NotificationLevel, readonly NotificationReason[]> = {
  needsYou: ORDER.filter((reason) => needsYou.has(reason)),
  everything: ORDER,
  nothing: [],
};

const list = (reasons: readonly NotificationReason[]) => {
  const words = reasons.map((reason) => REASON_WORDS[reason]);
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
};
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Tell me about" (F-026 S22): the three levels, each with the line that says what it sends. */
export const LEVELS: readonly { id: NotificationLevel; label: string; detail: string }[] = [
  { id: 'needsYou', label: 'Only what needs me', detail: sentence(list(LEVEL_REASONS.needsYou)) },
  { id: 'everything', label: 'Everything', detail: `Also ${list(LEVEL_REASONS.everything.filter((reason) => !needsYou.has(reason)))}` },
  { id: 'nothing', label: 'Nothing', detail: 'No push or email. Everything still waits in the Inbox' },
];

const clock = (value: string) => value.replace(/^0(\d)/, '$1');

/**
 * The line under Notifications in Settings' list on the phone: what the person hears about and, only while quiet hours are on, when it is
 * quiet. A line that names quiet hours while they are off would say something that is not so (#1424).
 */
export function notificationSummary(prefs: { level: NotificationLevel; quietHours: { enabled: boolean; start: string; end: string } }): string {
  const level = LEVELS.find((option) => option.id === prefs.level)?.label ?? '';
  return prefs.quietHours.enabled ? `${level} · quiet ${clock(prefs.quietHours.start)}–${clock(prefs.quietHours.end)}` : level;
}
