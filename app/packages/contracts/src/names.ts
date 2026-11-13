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
const INVISIBLE_FORMAT = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const ANY_INVISIBLE_FORMAT = new RegExp(INVISIBLE_FORMAT.source);

export const hasInvisibleFormat = (text: string): boolean => ANY_INVISIBLE_FORMAT.test(text);

/** The text without its direction-control and invisible format characters. */
export const withoutInvisibleFormat = (text: string): string => text.replace(INVISIBLE_FORMAT, '');
