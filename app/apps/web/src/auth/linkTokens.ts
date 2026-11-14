// The links an account comes from (#1471): the setup link `/setup#<token>` and an invite link `/join#<token>`. Each token stays in the
// fragment (never sent in a request line) and, once read, in this tab's session storage, so the sign-up form can send it; the address
// and the browser's history lose it at once.

export type LinkKind = 'setup' | 'invite';
const STORE: Record<LinkKind, string> = { setup: 'flux.setup-token', invite: 'flux.invite-token' };

/** The token in the address's fragment (kept for this tab and taken out of the address), else the one this tab kept. */
export function takeLinkToken(kind: LinkKind): string {
  const fromHash = window.location.hash.replace(/^#/, '').trim();
  try {
    if (fromHash) sessionStorage.setItem(STORE[kind], fromHash);
  } catch { /* storage off: the fragment is all there is */ }
  if (fromHash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return fromHash || keptLinkToken(kind);
}

/** The token this tab kept, or ''. */
export function keptLinkToken(kind: LinkKind): string {
  try { return sessionStorage.getItem(STORE[kind]) ?? ''; } catch { return ''; }
}

export function forgetLinkToken(kind: LinkKind) {
  try { sessionStorage.removeItem(STORE[kind]); } catch { /* nothing kept */ }
}
