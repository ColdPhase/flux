import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Icon, IconButton, duration, play } from '../ui';
import { useLive } from './LiveProvider';
import type { MediaPerson, VideoRef } from './media';
import { LiveVideo } from './Video';

type Zoom = { mode: 'fit' } | { mode: 'scale'; scale: number };
const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Screens and cameras over the work area, opened on request (#59 §3, AC-3). Each viewer
 * picks which screen to focus, fits it or reads it at 1:1 pixels and zooms and pans on their
 * own; nothing changes for anyone else. The strip stays above it, and “Back to work” or
 * Escape returns to exactly where you were.
 */
export function LiveStage() {
  const live = useLive();
  const people = live.media?.people ?? [];
  // One entry per shared track: two devices of one person are two screens (#128).
  const screens = live.media?.screens ?? [];
  const cameras = live.media?.cameras ?? [];
  const open = live.stage.open && (screens.length > 0 || cameras.length > 0) && live.phase !== 'idle';
  const focusId = screens.some((screen) => screen.key === live.stage.focus) ? live.stage.focus : screens[0]?.key ?? null;
  const focused = screens.find((screen) => screen.key === focusId) ?? null;
  const personOf = (video: VideoRef) => people.find((person) => person.userId === video.userId);
  const screenName = (screen: VideoRef) => {
    const same = screens.filter((other) => other.userId === screen.userId);
    const name = `${live.nameOf(screen.userId).split(' ')[0]}’s screen`;
    return same.length > 1 ? `${name} ${same.indexOf(screen) + 1}` : name;
  };
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [showCameras, setShowCameras] = useState(true);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const groupId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    void play(rootRef.current, [{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], duration('--dur-3'), '--ease-sheet', { fill: 'backwards' });
    rootRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [open]);
  // A different screen starts fitted again.
  const [zoomFor, setZoomFor] = useState(focusId);
  if (zoomFor !== focusId) { setZoomFor(focusId); setNatural(null); setZoom({ mode: 'fit' }); }

  if (!open) return null;

  const ratio = window.devicePixelRatio || 1;
  const scale = zoom.mode === 'scale' ? zoom.scale : null;
  const size = natural && scale !== null ? { width: (natural.w / ratio) * scale, height: (natural.h / ratio) * scale } : null;
  const step = (direction: 1 | -1) => {
    const current = scale ?? 1;
    const index = STEPS.findIndex((value) => value >= current - 0.001);
    const next = STEPS[Math.max(0, Math.min(STEPS.length - 1, (index === -1 ? STEPS.length - 1 : index) + direction))]!;
    setZoom({ mode: 'scale', scale: next });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); live.closeStage(); return; }
    if ((event.key === '+' || event.key === '=') && !event.metaKey && !event.ctrlKey) { event.preventDefault(); step(1); }
    if (event.key === '-' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); step(-1); }
    if (event.key === '0') { event.preventDefault(); setZoom({ mode: 'fit' }); }
    if (event.key === '1') { event.preventDefault(); setZoom({ mode: 'scale', scale: 1 }); }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || zoom.mode === 'fit' || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !drag.current) return;
    viewport.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
    viewport.scrollTop = drag.current.top - (event.clientY - drag.current.y);
  };
  const onPointerUp = () => { drag.current = null; };

  const cameraTiles = showCameras && cameras.length ? (
    <ul className="lv-cams" aria-label="Cameras">
      {cameras.map((video) => <CameraTile key={video.key} person={personOf(video)} video={video} name={video.local ? 'You' : live.nameOf(video.userId)} />)}
    </ul>
  ) : null;

  return (
    <div ref={rootRef} className={`lv-stage${focused ? '' : ' lv-stage--cams'}`} role="region" aria-label="Shared screens and cameras" onKeyDown={onKeyDown}>
      <div className="lv-stage__bar">
        {screens.length > 1 ? (
          <div className="seg lv-stage__pick" role="radiogroup" aria-labelledby={groupId}>
            <span id={groupId} className="ui-vh">Screen to focus</span>
            {screens.map((screen) => (
              <button key={screen.key} type="button" role="radio" className="seg__b" aria-checked={screen.key === focusId}
                onClick={() => live.openStage(screen.key)}>{screenName(screen)}</button>
            ))}
          </div>
        ) : focused ? <p className="lv-stage__title"><Icon name="screen" size={14} />{live.nameOf(focused.userId)}’s screen</p>
          : <p className="lv-stage__title"><Icon name="video" size={14} />Cameras</p>}
        {focused ? (
          <div className="lv-stage__zoom" role="group" aria-label="Zoom">
            <button type="button" className="ui-btn ui-btn--quiet" aria-pressed={zoom.mode === 'fit'} onClick={() => setZoom({ mode: 'fit' })} aria-keyshortcuts="0">Fit</button>
            <button type="button" className="ui-btn ui-btn--quiet" aria-pressed={scale === 1} onClick={() => setZoom({ mode: 'scale', scale: 1 })} aria-keyshortcuts="1" data-tip="One screen pixel per display pixel">1:1</button>
            <IconButton icon="zoom-out" label="Zoom out" onClick={() => step(-1)} aria-keyshortcuts="-" />
            <span className="lv-stage__pct" aria-live="polite">{scale === null ? <span className="ui-vh">Fitted to the window</span> : `${Math.round(scale * 100)}%`}</span>
            <IconButton icon="zoom-in" label="Zoom in" onClick={() => step(1)} aria-keyshortcuts="+" />
          </div>
        ) : null}
        <span className="lv-stage__end">
          {cameras.length && focused ? <Button variant="quiet" icon="video" aria-pressed={showCameras} onClick={() => setShowCameras((v) => !v)}>{showCameras ? 'Hide cameras' : 'Show cameras'}</Button> : null}
          <Button variant="secondary" icon="chevron-left" onClick={live.closeStage} data-autofocus>Back to work</Button>
        </span>
      </div>
      <div className="lv-stage__body">
        {focused ? (
          <div ref={viewportRef} className={`lv-stage__view${zoom.mode === 'fit' ? ' is-fit' : ' is-zoomed'}`} tabIndex={0}
            aria-label={`${live.nameOf(focused.userId)}’s screen${natural ? `, ${natural.w} by ${natural.h} pixels` : ''}. Plus and minus zoom, 0 fits, 1 shows actual pixels.`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <LiveVideo key={focused.key} video={focused} className="lv-stage__video"
              style={size ? { width: size.width, height: size.height, maxWidth: 'none', maxHeight: 'none' } : undefined}
              onDimensions={(w, h) => setNatural({ w, h })} />
          </div>
        ) : null}
        {cameraTiles}
      </div>
      {focused && natural ? <p className="lv-stage__foot">{natural.w}×{natural.h} received · automatic quality{zoom.mode === 'fit' ? ' · drag to pan after zooming' : ' · drag to pan'}</p> : null}
    </div>
  );
}

function CameraTile({ person, video, name }: { person: MediaPerson | undefined; video: VideoRef; name: string }) {
  return (
    <li className={`lv-cam${person?.speaking ? ' is-speaking' : ''}`}>
      <LiveVideo video={video} className={`lv-cam__video${video.local ? ' is-mirror' : ''}`} aria-label={`${name === 'You' ? 'Your' : `${name}’s`} camera`} />
      <span className="lv-cam__name">{name}{!person?.mic ? <Icon name="mic-off" size={11} /> : null}</span>
    </li>
  );
}
