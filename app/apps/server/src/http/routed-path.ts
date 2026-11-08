/**
 * What decides which part of the API a request belongs to (#1047). Never `request.url`: the router percent-decodes the path before it
 * matches a route, so `/%61pi/v1/me` runs the route `/api/v1/me`, `/%6dcp` runs `/mcp`, `/health#x` runs `/health`, and a check made on
 * the raw text of the URL (a rate limit, `no-store`, the compression rule) never sees them. A request is judged by what the router decided
 * about it, in two ways at once, and a check applies when either says so:
 * - the route that answers it (`request.routeOptions.url`, a pattern such as `/api/v1/channels/:id`), which is exactly what ran and cannot
 *   drift from the router; it is absent when nothing matched;
 * - the path as the router reads it, for a request nothing matched (a 404 under `/api/` is API traffic too) and for a file the static
 *   handler answers under a name such as `/.well-known/…`.
 * Over-counting is harmless (a path that only looks like API traffic is a request nobody makes); a request that reaches the API unseen is not.
 */
export interface RoutedRequest {
  url: string;
  routeOptions?: { url?: string | undefined } | undefined;
}

/**
 * A request target as the path find-my-way routes (`find`, `getPathFromAbsoluteUrl`): `GET http://host/api/v1/me?x` (absolute-form, which a
 * server must accept) is `/api/v1/me?x`, and `http://host` is `/`; a target that is neither that nor origin-form has its first character
 * skipped by the router, so `*api/v1/me` is `/api/v1/me` and is written so. The lone `*` and an absolute-form that does not parse (the
 * router answers it a 400 before any hook or route) are returned as they are.
 */
export function originFormTarget(url: string): string {
  if (url.charCodeAt(0) === 47 || url === '*') return url;
  const schemeEnd = url.indexOf('://');
  const scheme = schemeEnd === -1 ? '' : url.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return `/${url.slice(1)}`;
  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  const pathStart = url.indexOf('/', authorityStart);
  if (pathStart !== -1) authorityEnd = pathStart;
  const queryStart = url.indexOf('?', authorityStart);
  if (queryStart !== -1 && queryStart < authorityEnd) authorityEnd = queryStart;
  // A fragment is no part of an HTTP request target, and a slash after one is not the start of the path.
  if (url.indexOf('#', authorityStart) !== -1 || authorityEnd === authorityStart) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${scheme}:` || parsed.host.length === 0) return url;
  } catch { return url; }
  if (authorityEnd === url.length) return '/';
  if (authorityEnd === queryStart) return `/${url.slice(queryStart)}`;
  return url.slice(pathStart);
}

/**
 * The path as Fastify's router (find-my-way, `Router.sanitizeUrlPath`) reads it: the target made a path (`originFormTarget`), cut before the
 * first `?` or `#` and percent-decoded once with `decodeURI`. A letter written as `%61` is that letter, and so is a dot (`%2e`), a hyphen or a space; the characters that mean
 * something in a URL (`%2F`, `%3F`, `%23`, `%3A`, `%40`, `%26`, `%3D`, `%2B`, `%24`, `%2C`, `%3B`) and `%25` itself stay as written, so a
 * double-encoded `%2561` is `%61`, never `a`. Dot segments, `//` and a trailing slash are left alone (Flux sets none of the router's
 * `ignore…` options), which is why `/api/v1/../v1/me` matches no route. A path that does not decode is a 400 before any route, so it stays as written.
 */
export function decodedPath(target: string): string {
  let url = originFormTarget(target);
  if (url.charCodeAt(0) !== 47) url = `/${url.slice(1)}`;
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  try { return decodeURI(path.replaceAll('%25', '%2525')); } catch { return path; }
}

/**
 * The path of a WebSocket upgrade request as the router will read it, for the gates that own an upgrade before Fastify sees it: the URL is
 * parsed (a gate is stricter than the router about dot segments, so `/api/v1/./editing` is still the editing socket), then decoded as the
 * router decodes, so `/api/v1/%65diting` is the editing socket too and cannot take the generic fallback past the gate's origin and
 * admission checks (#1047). Null for a URL that does not parse.
 */
export function upgradePath(url: string | undefined): string | null {
  try { return decodedPath(new URL(url ?? '/', 'http://upgrade.invalid').pathname); } catch { return null; }
}

const known = new WeakMap<object, readonly string[]>();

/** Every path this request is judged by, decided once per request: the route that answers it (when one does) and its decoded path. */
export function routedPaths(request: RoutedRequest): readonly string[] {
  let paths = known.get(request);
  if (!paths) {
    const route = request.routeOptions?.url;
    const path = decodedPath(request.url);
    paths = typeof route === 'string' && route && route !== path ? [route, path] : [path];
    known.set(request, paths);
  }
  return paths;
}

/** Whether the request belongs where `where` says (a path prefix such as `/api/`, or a pattern), by the route that answers it or by its decoded path. */
export function isRouted(request: RoutedRequest, where: string | RegExp): boolean {
  return routedPaths(request).some((path) => typeof where === 'string' ? path.startsWith(where) : where.test(path));
}
