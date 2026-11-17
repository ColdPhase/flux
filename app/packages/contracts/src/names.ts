/**
 * Names of people and agents (#1347, the audits of #1270): a name is text that is drawn beside other text, so it may not carry a character
 * that changes how that text is ordered or hides itself. The bidirectional controls (U+202A-202E, U+2066-2069, U+200E, U+200F, U+061C)
 * would reverse or reorder what follows the name (an agent called "RLO + TNATSISSA S'TREBUH" is drawn "Ada's HUBERT'S ASSISTANT"), and the
 * zero-width space, word joiner and byte-order mark (U+200B, U+2060, U+FEFF) would let two names look alike. The zero-width joiners
 * (U+200C, U+200D) stay: emoji and several scripts need them.
 *
 * A name that is typed or sent is refused with `INVALID_NAME`; a name that comes from outside (an identity provider's claim, an OAuth
 * client's) or was stored before is cleaned when it is read (`withoutInvisibleFormat`).
 */
/** The characters as one bracket expression, for a database's regular expression too (a raw SQL select of a name, `cleanName` in @flux/db). */
export const INVISIBLE_FORMAT_CLASS = '[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]';
const INVISIBLE_FORMAT = new RegExp(INVISIBLE_FORMAT_CLASS, 'g');
const ANY_INVISIBLE_FORMAT = new RegExp(INVISIBLE_FORMAT_CLASS);

export const hasInvisibleFormat = (text: string): boolean => ANY_INVISIBLE_FORMAT.test(text);

/** The text without its direction-control and invisible format characters. */
export const withoutInvisibleFormat = (text: string): string => text.replace(INVISIBLE_FORMAT, '');

const REMOVED = ' (removed)';
/**
 * How a person who left the company or was removed from it, and has not come back, is named wherever their name is already in a space's
 * history (founder decision, Hubert, 2026-11-17, #1424): "Stefan Kowal (removed)", for people and agents alike, in messages, threads, a
 * decision's discussion, a task and its history, Search and People. Restore takes the mark off. One helper for every reader of it.
 */
export const removedName = (name: string): string => `${name}${REMOVED}`;

/**
 * How an agent's one label names its owner: by first name, "Planner · Ada's agent"; and an owner who left the company or was removed by the
 * whole marked name, "Planner · Stefan Kowal (removed)'s agent" (founder decision, Hubert, 2026-11-17, #1424), as their messages name them.
 * The caller gives such an owner as `removedName(name)`. One rule for the app's label, its text form and what agents read.
 */
export function ownerInLabel(ownerName: string): string {
  const name = ownerName.trim();
  return name.endsWith(REMOVED) ? name : name.split(/\s+/)[0] || name;
}
