import { useEffect, useRef, type CSSProperties, type VideoHTMLAttributes } from 'react';
import type { VideoRef } from './media';

/** A muted, inline video bound to one live track; it detaches when it leaves the page. */
export function LiveVideo({ video, className, style, onDimensions, ...rest }: {
  video: VideoRef;
  className?: string;
  style?: CSSProperties;
  onDimensions?: (width: number, height: number) => void;
} & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'style'>) {
  const ref = useRef<HTMLVideoElement>(null);
  const attach = useRef(video.attach);
  const onDims = useRef(onDimensions);
  useEffect(() => { attach.current = video.attach; onDims.current = onDimensions; });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const detach = attach.current(element);
    const report = () => { if (element.videoWidth) onDims.current?.(element.videoWidth, element.videoHeight); };
    element.addEventListener('loadedmetadata', report);
    element.addEventListener('resize', report);
    return () => { element.removeEventListener('loadedmetadata', report); element.removeEventListener('resize', report); detach(); };
  }, [video.key]);
  return <video ref={ref} className={className} style={style} muted playsInline autoPlay disablePictureInPicture {...rest} />;
}
