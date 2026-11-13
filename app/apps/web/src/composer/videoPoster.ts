import { useEffect, useState } from 'react';
import { FILE_LIMITS } from '@flux/contracts';

/**
 * A video's poster, drawn in the sender's browser (C-61, #1352): a frame 0.1 s in (the first one, when the video is shorter), at most
 * {@link FILE_LIMITS.posterEdge} px on its longest side, as a JPEG. A browser that cannot decode the video (a codec it lacks) or does not
 * show a frame in time gives null, and the message simply shows the video's page icon. The server treats the picture as untrusted and
 * re-encodes it. One per File, so the thumbnail in the composer and the upload read the same one.
 */
const made = new WeakMap<File, Promise<Blob | null>>();
const WAIT_MS = 8000;

export function drawPoster(file: File): Promise<Blob | null> {
  let poster = made.get(file);
  if (!poster) { poster = draw(file); made.set(file, poster); }
  return poster;
}

/** Resolves on the first of `event` and the end of `ms`; rejects when the player errors. */
const once = (video: HTMLVideoElement, event: string, ms: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video error')); }, { once: true });
  video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** The engine has presented a frame (or half a second has passed): only then does a canvas see it. */
const presented = (video: HTMLVideoElement) => new Promise<void>((resolve) => {
  const later = setTimeout(resolve, 500);
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => { clearTimeout(later); resolve(); });
});

/** The frame on screen as a small JPEG; null when the engine painted nothing (a canvas of WebKit's GStreamer build stays black) or the picture is too big. */
function snapshot(video: HTMLVideoElement): Promise<Blob | null> {
  const { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, FILE_LIMITS.posterEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return Promise.resolve(null);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  // An entirely black picture says nothing about the video: the row keeps its icon instead.
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let lit = false;
  for (let at = 0; at < data.length && !lit; at += 16) lit = data[at]! > 12 || data[at + 1]! > 12 || data[at + 2]! > 12;
  if (!lit) return Promise.resolve(null);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.size > 0 && blob.size <= FILE_LIMITS.posterBytes ? blob : null), 'image/jpeg', 0.8));
}

async function draw(file: File): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  // In the page but out of sight and out of the way: some engines (WebKit) paint no frame of a video that is not in a document.
  Object.assign(video.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px', opacity: '0', pointerEvents: 'none' });
  video.setAttribute('aria-hidden', 'true');
  document.body.append(video);
  const work = (async (): Promise<Blob | null> => {
    const loaded = once(video, 'loadeddata', WAIT_MS);
    video.src = url;
    await loaded;
    if (video.readyState < 2) return null;
    const at = Math.min(0.1, (Number.isFinite(video.duration) ? video.duration : 0) / 2);
    if (at > 0) { const seeked = once(video, 'seeked', 2000); video.currentTime = at; await seeked; }
    await presented(video);
    const drawn = await snapshot(video);
    if (drawn) return drawn;
    // The seek painted nothing: let the engine play the first moments, muted, and take what it presents.
    video.currentTime = 0;
    await video.play();
    await presented(video);
    video.pause();
    return snapshot(video);
  })();
  try { return await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS))]); }
  catch { return null; }
  finally { video.remove(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

/** The poster of a local video as an object URL for its thumbnail in the composer; '' until it is drawn, or when it cannot be. */
export function useVideoPoster(file: File | undefined): string {
  const [shown, setShown] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    let url = '';
    let gone = false;
    void drawPoster(file).then((blob) => {
      if (gone || !blob) return;
      url = URL.createObjectURL(blob);
      setShown({ file, url });
    });
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [file]);
  return file && shown?.file === file ? shown.url : '';
}
