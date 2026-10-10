/** A pending destination is named without depending on any of its downloaded route code. */
export function routeLabel(pathname: string): string {
  if (/^\/(login|sign-in)(\/|$)/.test(pathname)) return 'sign-in';
  if (pathname === '/sign-up') return 'account registration';
  if (pathname === '/sign-out') return 'sign-out';
  if (/^\/(forgot-password|reset-password)(\/|$)/.test(pathname)) return 'password reset';
  if (/^\/(connect-agent|consent)(\/|$)/.test(pathname)) return 'agent connection';
  if (pathname === '/settings/background-compute') return 'background suggestions';
  if (pathname === '/settings/assistant') return 'your assistant';
  if (pathname.startsWith('/settings/notifications')) return 'notification settings';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname === '/projects/new') return 'a new project';
  if (pathname === '/projects') return 'projects';
  if (/(?:\/map|\/sketches)(\/|$)/.test(pathname)) return 'the map';
  if (/(?:\/docs|\/materials)(\/|$)/.test(pathname)) return 'the wiki';
  if (/\/tasks(\/|$)/.test(pathname)) return 'tasks';
  if (/\/agents(\/|$)/.test(pathname)) return 'agents';
  if (/\/github(\/|$)/.test(pathname)) return 'GitHub settings';
  if (/\/live(\/|$)/.test(pathname)) return 'the live session';
  if (pathname.startsWith('/search')) return 'search';
  if (pathname.startsWith('/inbox')) return 'the inbox';
  if (pathname.startsWith('/dm')) return 'direct messages';
  if (pathname.startsWith('/projects/')) return 'the conversation';
  return 'Home';
}
