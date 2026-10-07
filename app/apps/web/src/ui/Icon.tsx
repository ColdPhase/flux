import type { ReactNode, SVGProps } from 'react';

/** 16×16 line icons with a 1.5px stroke, drawn for direction C. Decorative unless labelled. */
const paths = {
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  panel: <><rect x="2" y="2.75" width="12" height="10.5" rx="2" /><path d="M10 3v10" /></>,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  'chevron-down': <path d="M4.5 6.5L8 10l3.5-3.5" />,
  'chevron-up': <path d="M4.5 9.5L8 6l3.5 3.5" />,
  'chevron-right': <path d="M6.5 4.5L10 8l-3.5 3.5" />,
  'chevron-left': <path d="M9.5 4.5L6 8l3.5 3.5" />,
  search: <><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5" /></>,
  send: <path d="M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25" />,
  inbox: <><path d="M2.5 9.5l1.7-5.2a1 1 0 01.95-.8h5.7a1 1 0 01.95.8l1.7 5.2v3a1 1 0 01-1 1h-9a1 1 0 01-1-1z" /><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" /></>,
  chat: <path d="M3 4.25A1.75 1.75 0 014.75 2.5h6.5A1.75 1.75 0 0113 4.25v4.5a1.75 1.75 0 01-1.75 1.75H7l-3 2.5V10.5a1.75 1.75 0 01-1-1.6z" />,
  tasks: <><path d="M2.75 4.5l1.25 1.25 2.25-2.5M2.75 10.5l1.25 1.25 2.25-2.5" /><path d="M8.5 4.75h5M8.5 10.75h5" /></>,
  map: <><circle cx="4" cy="4.5" r="1.75" /><circle cx="12" cy="4.5" r="1.75" /><circle cx="8" cy="11.5" r="1.75" /><path d="M5.5 5.5L7 10M10.5 5.5L9 10" /></>,
  doc: <><path d="M4 2.5h5l3 3v8H4z" /><path d="M6 8.5h4M6 11h3" /></>,
  book: <><path d="M3 12.75V3.5A1.5 1.5 0 014.5 2h8v9.75h-8A1.5 1.5 0 003 13.25 1.5 1.5 0 004.5 14.75h8" /><path d="M6 5h4" /></>,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06" /><circle cx="8" cy="8" r="4.25" /></>,
  clip: <path d="M11.25 7.25l-4.5 4.5a2.12 2.12 0 01-3-3l5.25-5.25a1.41 1.41 0 012 2L5.75 10.75" />,
  people: <><circle cx="6" cy="5.5" r="2.25" /><path d="M2 13c.5-2.2 2-3.5 4-3.5s3.5 1.3 4 3.5" /><path d="M10.5 3.5a2 2 0 010 4M12 9.75c1 .5 1.7 1.6 2 3.25" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.25a2.5 2.5 0 015 0V7" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2.5 4.5L8 8.75l5.5-4.25" /></>,
  alert: <><circle cx="8" cy="8" r="6" /><path d="M8 4.75v3.75" /><circle cx="8" cy="11" r=".6" fill="currentColor" /></>,
  /** A message waiting to send (#264, F-026). */
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.75V8l2.25 1.5" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  sun: <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  monitor: <><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 13.5h4M8 11v2.5" /></>,
  'sign-out': <><path d="M6.5 2.75h-2a1.5 1.5 0 00-1.5 1.5v7.5a1.5 1.5 0 001.5 1.5h2" /><path d="M10 5l3 3-3 3M13 8H6.5" /></>,
  refresh: <><path d="M12.75 5.5A5 5 0 103 8" /><path d="M13 2.5v3h-3" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  terminal: <><rect x="2" y="2.75" width="12" height="10.5" rx="2" /><path d="M5 6.25L7 8l-2 1.75M8.5 10.25h2.5" /></>,
  more: <><circle cx="3.5" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" /></>,
  minus: <path d="M3 8h10" />,
  edit: <><path d="M10.5 3.25l2.25 2.25L6 12.25H3.75V10z" /><path d="M9 4.75l2.25 2.25" /></>,
  /** Sketches (#69): connect two thoughts, undo, remove a thought from the map, change its shape. */
  image: <><rect x="2.25" y="3" width="11.5" height="10" rx="1.75" /><circle cx="6" cy="6.5" r="1.1" /><path d="M2.75 11.5l3.25-3 2.5 2.25 1.75-1.5 3 2.5" /></>,
  paste: <><rect x="3.5" y="3" width="9" height="11" rx="1.5" /><path d="M6 3V2.25h4V3M6 7.5h4M6 10h3" /></>,
  link: <><path d="M6.75 9.25l2.5-2.5" /><path d="M7.5 4.75l1.1-1.1a2.5 2.5 0 013.54 3.54l-1.1 1.1M8.5 11.25l-1.1 1.1a2.5 2.5 0 01-3.54-3.54l1.1-1.1" /></>,
  undo: <><path d="M5.5 3.5L2.75 6.25 5.5 9" /><path d="M3 6.25h6.25a3.75 3.75 0 010 7.5H7" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.25a1 1 0 001 .75h3.8a1 1 0 001-.75l.6-8.25" /></>,
  shape: <><rect x="2.5" y="2.5" width="6" height="6" rx="1.5" /><circle cx="10.5" cy="10.5" r="3" /></>,
  key: <><circle cx="5.5" cy="10.5" r="2.75" /><path d="M7.5 8.5L13 3M11 5l1.5 1.5" /></>,
  home: <path d="M2.75 7.25L8 2.75l5.25 4.5v5.5a1 1 0 01-1 1H10v-4H6v4H3.75a1 1 0 01-1-1z" />,
  bell: <><path d="M4 11.5V7a4 4 0 018 0v4.5l1 1H3z" /><path d="M6.75 13.5a1.25 1.25 0 002.5 0" /></>,
  /** "What matters" (#133): a private recap, no AI. */
  leaf: <><path d="M3.25 12.75C3.25 7 6.75 3.5 12.75 3.25 12.5 9.25 9 12.75 3.25 12.75z" /><path d="M3.25 12.75l5.5-5.5" /></>,
  /** The personal assistant (#57): a filled four-point spark. */
  spark: <><path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" fill="currentColor" stroke="none" /><path d="M12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" fill="currentColor" stroke="none" /></>,
  /** Work objects (#101): a decision (rule) and a result (checked document). */
  rule: <><path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" /><path d="M5.75 8.1l1.6 1.6 3-3.2" /></>,
  result: <><path d="M4 2.5h5l3 3v8H4z" /><path d="M6 9.25l1.5 1.5 2.75-3" /></>,
  flask: <><path d="M6.5 2.5h3M7 2.5v4L3.5 12.5a1 1 0 00.9 1.5h7.2a1 1 0 00.9-1.5L9 6.5v-4" /><path d="M5 10h6" /></>,
  /** Live sessions (#62): together, microphone, camera, screen, quiet, leave, zoom, show. */
  together: <><circle cx="5.25" cy="6" r="2" /><circle cx="10.75" cy="6" r="2" /><path d="M1.75 12.75c.4-1.9 1.75-3 3.5-3s3.1 1.1 3.5 3M7.25 12.75c.4-1.9 1.75-3 3.5-3s3.1 1.1 3.5 3" /></>,
  mic: <><rect x="6" y="2" width="4" height="7.5" rx="2" /><path d="M3.75 8a4.25 4.25 0 008.5 0M8 12.25V14" /></>,
  'mic-off': <><path d="M10 6.5V4a2 2 0 00-3.9-.6M6 6.5V7.5a2 2 0 003.2 1.6" /><path d="M3.75 8a4.25 4.25 0 007 3.25M12.25 8c0 .4-.05.8-.16 1.17M8 12.25V14M2.5 2.5l11 11" /></>,
  video: <><rect x="1.75" y="4.25" width="8.5" height="7.5" rx="1.5" /><path d="M10.25 7l4-2.25v6.5l-4-2.25" /></>,
  'video-off': <><path d="M5 4.25h3.75a1.5 1.5 0 011.5 1.5v3.5M10.25 11.2a1.5 1.5 0 01-1.5.55h-5.5a1.5 1.5 0 01-1.5-1.5v-4.5a1.5 1.5 0 01.9-1.37" /><path d="M10.25 7l4-2.25v6.5l-2.1-1.18M2 2l12 12" /></>,
  screen: <><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" /><path d="M5.5 13.75h5M8 11.25v2.5M8 8.75V5.25M6.25 6.75L8 5l1.75 1.75" /></>,
  quiet: <><path d="M3 6h2l3-2.75v9.5L5 10H3a.75.75 0 01-.75-.75v-2.5A.75.75 0 013 6z" /><path d="M11 6.25l3 3.5M14 6.25l-3 3.5" /></>,
  hearing: <><path d="M3 6h2l3-2.75v9.5L5 10H3a.75.75 0 01-.75-.75v-2.5A.75.75 0 013 6z" /><path d="M10.5 5.75a3 3 0 010 4.5M12.25 4a5.5 5.5 0 010 8" /></>,
  leave: <><path d="M2.25 9.5c3.3-3.3 8.2-3.3 11.5 0l-1.5 1.75-2.25-1v-1.5a7 7 0 00-4 0v1.5l-2.25 1z" /></>,
  'zoom-in': <><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5M5.25 7h3.5M7 5.25v3.5" /></>,
  'zoom-out': <><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5M5.25 7h3.5" /></>,
  show: <><rect x="2" y="2.75" width="12" height="8.5" rx="1.5" /><path d="M5.5 13.5h5M6.5 5.5l3 1.5-3 1.5z" /></>,
  follow: <><path d="M3 3l4.25 10 1.5-4.25L13 7.25z" /></>,
  pulse: <path d="M1.75 8h2.5l1.5-3.5 2.5 7 1.75-5 1 1.5h3.25" />,
  /** Tasks (#136): the Kanban and List views, "Mine" and an agent that owns a task. */
  board: <><rect x="2.25" y="2.5" width="3" height="11" rx="1" /><rect x="6.5" y="2.5" width="3" height="7" rx="1" /><rect x="10.75" y="2.5" width="3" height="9" rx="1" /></>,
  list: <><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" /><circle cx="3" cy="4.5" r=".8" fill="currentColor" stroke="none" /><circle cx="3" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="3" cy="11.5" r=".8" fill="currentColor" stroke="none" /></>,
  person: <><circle cx="8" cy="5.25" r="2.5" /><path d="M3.25 13.5c.55-2.5 2.4-3.9 4.75-3.9s4.2 1.4 4.75 3.9" /></>,
  agent: <><rect x="2.75" y="4.5" width="10.5" height="8.5" rx="2" /><path d="M8 4.5V2.5" /><circle cx="6" cy="8.5" r=".8" fill="currentColor" stroke="none" /><circle cx="10" cy="8.5" r=".8" fill="currentColor" stroke="none" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Accessible label; without it the icon is hidden from assistive technology. */
  label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

/** The Flux mark from flux-ux-v8.html: two slanted strokes. Decorative unless labelled. */
export function FluxMark({ size = 22, label }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={Math.round(size * 27 / 24)} viewBox="0 0 24 27" fill="none" aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined} aria-label={label} focusable="false">
      <path d="M3.6 21.2L10.4 6.2M14 9.2l4 8.4" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
    </svg>
  );
}
