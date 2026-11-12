import { useState } from 'react';
import { photoSources, usePhotoOf } from '../people/photos';

export function initials(name: string): string {
  // Only words that start with a letter or a digit: a "(you)" or "·" never becomes an initial (#763 H11-9).
  const parts = name.trim().split(/\s+/).filter((part) => /^[\p{L}\p{N}]/u.test(part));
  if (!parts.length) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

const PIXELS = { sm: 20, md: 26, lg: 32 } as const;

/**
 * A person's face: their photo when they have one (F-039, #1226), otherwise their initials. `id` is the person's user id; agents
 * never pass one, since an agent is Kreska and never has a photo. The initials stay under the photo, so they show while it loads and
 * whenever it cannot load. `photo` draws a chosen picture before it is saved (the preview in Settings).
 */
export function Avatar({ name, id, photo, size = 'md', tone = 'neutral' }: {
  name: string; id?: string | null; photo?: string; size?: 'sm' | 'md' | 'lg'; tone?: 'neutral' | 'me';
}) {
  const photoId = usePhotoOf(id);
  const [failed, setFailed] = useState<string | null>(null);
  const source = photo ?? (photoId && failed !== photoId ? photoId : null);
  return (
    <span className={`ui-avatar ui-avatar--${size} ui-avatar--${tone}`} aria-hidden="true">
      {initials(name)}
      {source ? (
        <img className="ui-avatar__photo" alt="" decoding="async" draggable={false}
          {...(photo ? { src: photo } : { srcSet: photoSources(source), sizes: `${PIXELS[size]}px` })}
          onError={() => { if (!photo) setFailed(source); }} />
      ) : null}
    </span>
  );
}
