/** One stable colour per person, shared by the wiki's cursors and the map's cursors. */
export function personColor(id: string) {
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return ['#365fba', '#93613c', '#a54b87', '#287c6a'][Math.abs(hash) % 4]!;
}
