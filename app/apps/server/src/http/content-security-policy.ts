import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The Content-Security-Policy of Flux's pages (#979). It is the second line behind React's escaping and the Markdown sanitizer: if a
 * stored-XSS bug ever existed, the browser would still refuse to run a script the page does not already carry, and refuse to send data
 * to another site. Without it an injected script runs with the signed-in person's full power, an agent's waiting changes included.
 *
 * The policy starts from `default-src 'self'` and opens only what Flux uses:
 * - scripts: Flux's own files and the SHA-256 of each inline script of the page (the theme read before the first paint, the offline
 *   page's button). Never `'unsafe-inline'` or `'unsafe-eval'`, and no inline event-handler attribute works.
 * - styles: `'unsafe-inline'` stays (React `style` attributes, the Wiki's table alignment, the editor's and terminal's own style
 *   elements). A style cannot run code; this is the one accepted risk, recorded in scripts/dast/zap-rules.conf.
 * - connections: the page's own origin, written out as ws:/wss: too because Safari does not match `'self'` for sockets everywhere. Live
 *   editing, the event stream, typing and the call's signalling (`<origin>/media`, docs/development/live-sessions.md) all go there; no
 *   other site is ever contacted from the browser.
 * - images `data:` (Kreska's SVG and inline icons) and `blob:` (a photo before it is sent, a thought's image); media `blob:` (a voice
 *   message); workers `blob:` (the call library) and Flux's service worker.
 * - no plugins, no frames of anything, `<base>` and forms only to Flux itself, and no framing of Flux (`frame-ancestors`, #287).
 *
 * A TEST DEPLOYMENT sends two headers (`loadDocumentPolicies`): the enforced policy adds `'unsafe-eval'`, because Playwright's
 * `waitForFunction`, which every browser test uses, evaluates its predicate with eval in the page; and the same policy WITHOUT it, as
 * `Content-Security-Policy-Report-Only` with a `report-uri`, so every browser of the test stack reports what the policy that ships
 * would refuse, eval included when it comes from a script of the app (a report with no source file is the test driver's own). The
 * service worker's policy goes out the same way, enforced and report-only with the `report-uri`.
 */
export function documentPolicy({ publicOrigin, scriptHashes, reportUri, allowEval }: { publicOrigin: string; scriptHashes: readonly string[]; reportUri?: string; allowEval?: boolean }): string {
  const sockets = socketOrigins(publicOrigin);
  const directives = [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((hash) => ` '${hash}'`).join('')}${allowEval ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    `connect-src 'self'${sockets.map((origin) => ` ${origin}`).join('')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (reportUri) directives.push(`report-uri ${reportUri}`);
  return directives.join('; ');
}

/**
 * The service worker runs no page: it fetches Flux's own files (the app shell, the offline page) and calls Flux's own API, and
 * `showNotification` loads the notification's icon under this policy too (Chromium), so `img-src 'self'` is open for `/icons/icon-192.png`.
 * `badge` and `image` are not used; nothing else is fetched.
 */
export const WORKER_POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'";

/** `wss://host` for an https origin, `ws://host` for http (a loopback install); nothing for anything else. */
export function socketOrigins(publicOrigin: string): string[] {
  const url = new URL(publicOrigin);
  if (url.protocol === 'https:') return [`wss://${url.host}`];
  if (url.protocol === 'http:') return [`ws://${url.host}`];
  return [];
}

// A script element with a body and no `src`, and a type a browser runs (none, a JavaScript type or a module). Data blocks
// (`application/json`, `importmap`) are not executed and need no hash.
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
const RUNS = /^(?:|module|(?:text|application)\/(?:javascript|ecmascript))$/i;

/** `sha256-<base64>` of each inline script's exact text, in document order, without repeats. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bsrc\s*=/i.test(attributes) || !body.trim()) continue;
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    if (!RUNS.test((type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim())) continue;
    const hash = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
    if (!hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/** An inline event-handler attribute (`onclick="..."`) in markup: a page that has one cannot run under this policy. */
export function inlineHandlers(html: string): string[] {
  return [...html.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)].map((match) => match[1]!.toLowerCase());
}

/** What a response carries: the enforced policy and, in a test deployment only, the one that ships, to report against. */
export interface PolicyHeaders { enforced: string; reportOnly?: string }

export interface DocumentPolicies {
  /** The headers for a built file served by @fastify/static, or null when the file is not one that needs a policy. */
  forFile(filePath: string): PolicyHeaders | null;
}

/**
 * Reads the built web app once at start: each `.html` file gets the policy with the hashes of its own inline scripts, so a script
 * that is not in the file the server holds does not run. A page added later with no entry here still gets the policy, with no hashes
 * (every inline script blocked): the failure is closed.
 */
export function loadDocumentPolicies(root: string, publicOrigin: string, test?: { reportUri: string; allowEval: boolean }): DocumentPolicies {
  const policies = new Map<string, PolicyHeaders>();
  const headers = (scriptHashes: readonly string[]): PolicyHeaders => test
    ? { enforced: documentPolicy({ publicOrigin, scriptHashes, allowEval: test.allowEval }), reportOnly: documentPolicy({ publicOrigin, scriptHashes, reportUri: test.reportUri }) }
    : { enforced: documentPolicy({ publicOrigin, scriptHashes }) };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) {
        policies.set(relative(root, path).split(sep).join('/'), headers(inlineScriptHashes(readFileSync(path, 'utf8'))));
      }
    }
  };
  if (existsSync(root)) walk(root);
  const bare = headers([]);
  return {
    forFile(filePath) {
      // A precompressed copy (`index.html.br`, #266) takes the policy of the file it stands for.
      const name = relative(root, filePath.replace(/\.(?:br|gz)$/, '')).split(sep).join('/');
      if (name === 'sw.js') return test ? { enforced: WORKER_POLICY, reportOnly: `${WORKER_POLICY}; report-uri ${test.reportUri}` } : { enforced: WORKER_POLICY };
      if (!name.endsWith('.html')) return null;
      return policies.get(name) ?? bare;
    },
  };
}
