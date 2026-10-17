/** One stable colour per person, shared by the wiki's cursors and the map's cursors. */
/** Eight hues, each at least 4.5:1 with the white 11px name label in both themes (scripts/check_contrast.py). */
const PERSON_COLOURS = ['#365fba', '#93613c', '#a54b87', '#287c6a', '#b3402a', '#6b4fbb', '#0e7490', '#be185d'];
export function personColor(id: string) {
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return PERSON_COLOURS[Math.abs(hash) % PERSON_COLOURS.length]!;
}
