export type Place = 'home' | 'inbox' | 'dm' | 'project';

/** Which part of Flux a path belongs to: Home, the Inbox (#116), direct messages or a project. */
export function placeOf(pathname: string): Place {
  if (pathname === '/dm' || pathname.startsWith('/dm/')) return 'dm';
  if (pathname === '/inbox' || pathname.startsWith('/inbox/') || pathname.startsWith('/settings/notifications')) return 'inbox';
  if (pathname.startsWith('/projects/')) return 'project';
  return 'home';
}
