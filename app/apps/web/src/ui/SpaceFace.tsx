import type { SpaceIcon } from '@flux/contracts';
import { picturePath, PICTURE_SIZES } from '@flux/contracts';

/** A space's letter: the first character of its name, as every tile drew it before icons (F-026 §4). */
export const spaceLetter = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

/**
 * What a space's tile holds (F-040, #1227): its emoji, its picture, or its letter. The caller keeps its own tile (size, radius 6,
 * fill and hairline), so an icon never changes the tile's size or place. `size` is the tile's width in CSS pixels, for the picture's
 * rendition.
 */
export function SpaceFace({ name, icon, size = 20 }: { name: string; icon?: SpaceIcon | null; size?: number }) {
  if (icon?.emoji) return <span className="space-face space-face--emoji">{icon.emoji}</span>;
  if (icon?.picture) {
    return <img className="space-face space-face--pic" alt="" decoding="async" draggable={false} sizes={`${size}px`}
      srcSet={PICTURE_SIZES.map((width) => `${picturePath(icon.picture!, width)} ${width}w`).join(', ')} />;
  }
  return <>{spaceLetter(name)}</>;
}
