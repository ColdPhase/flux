/**
 * Better Auth names its cookies `<prefix>.session_token`, with `__Secure-` in front over https: Flux's session cookie is
 * `flux.session_token`. One place for the prefix, so what reads the cookie (the API rate limit, #838) cannot drift from what sets it.
 */
export const SESSION_COOKIE_PREFIX = 'flux';
/** Matches the session cookie in a `Cookie` header; group 2 is the token. */
export const SESSION_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)((?:__Secure-)?${SESSION_COOKIE_PREFIX}\\.session_token)=([^;]+)`);
