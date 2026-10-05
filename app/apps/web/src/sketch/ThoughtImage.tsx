import { useEffect, useState, type CSSProperties } from 'react';
import { imageTypeOf } from '@flux/contracts';
import { fileBytes } from '../api/files';

// Images of map thoughts (#252). Stored files always download as attachments, so the bytes are fetched with the
// session, accepted only as PNG, JPEG, GIF or WebP by their own signature (never SVG) and shown from a local object
// URL. Stored files never change, so one URL serves every view of the same file in this visit.

const LIMIT = 60;
const urls = new Map<string, Promise<string | null>>();

function imageUrl(fileId: string): Promise<string | null> {
  let url = urls.get(fileId);
  if (!url) {
    url = fileBytes(fileId).then((bytes) => {
      const type = bytes ? imageTypeOf(bytes) : null;
      if (!bytes || !type) { urls.delete(fileId); return null; }
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    });
    urls.set(fileId, url);
    // Keep the newest images of this visit; an image already on screen stays decoded.
    for (const [old, pending] of urls) {
      if (urls.size <= LIMIT) break;
      urls.delete(old);
      void pending.then((value) => { if (value) URL.revokeObjectURL(value); });
    }
  }
  return url;
}

/** Signing out drops this visit's images with the account's other local state. */
export function forgetThoughtImages() {
  for (const pending of urls.values()) void pending.then((value) => { if (value) URL.revokeObjectURL(value); });
  urls.clear();
}

export function ThoughtImage({ fileId, name, className, style }: { fileId: string; name: string; className: string; style?: CSSProperties }) {
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void imageUrl(fileId).then((url) => { if (live) setLoaded({ id: fileId, url }); });
    return () => { live = false; };
  }, [fileId]);
  const current = loaded?.id === fileId ? loaded : null;
  if (!current) return <span className={`${className} is-loading`} style={style} aria-hidden="true" />;
  if (!current.url) return <span className={`${className} is-missing`} style={style}>Image unavailable</span>;
  return <img className={className} style={style} src={current.url} alt={name} draggable={false} />;
}
