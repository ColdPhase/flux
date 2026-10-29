import http from 'node:http';

/**
 * TEST ONLY (#469): pages for the link card suite, run as the Compose `linkmock` service of `scripts/check_application.sh`.
 * The API reaches it as `public.test` (FLUX_TEST_LINK_PREVIEW_HOSTS), on the default port, so every rule except the address
 * check of that one name is the production rule. No real site is ever fetched.
 *
 *   GET /__hits[?prefix=/p]   what reached it (path and the request headers that matter), GET /__reset, GET /__health
 */

const hits: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
const html = (response: http.ServerResponse, body: string, type = 'text/html; charset=utf-8', status = 200) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
const redirect = (response: http.ServerResponse, location: string, status = 302) => { response.writeHead(status, { location }); response.end(); };
const page = (head: string) => `<!doctype html><html><head>${head}</head><body><h1>body</h1></body></html>`;

const ARTICLE = page(`<title>Fallback &amp; title</title>
<meta property="og:title" content="Harbour &amp; Co: the winter ferry timetable">
<meta property="og:description" content="Sailings move to the winter timetable on 3 November. Crossings run twice a day, and the last boat leaves the island at 17:40 &mdash; check the harbour board before you set out. &lt;b&gt;Bring&lt;/b&gt; a coat and <i>a flask</i> too.">
<script>var s = '<title>script title</title><meta property="og:title" content="from a script">';</script>`);
const LONG = 'x'.repeat(600);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://linkmock');
  const path = url.pathname;
  if (path === '/__health') return html(response, 'ok', 'text/plain');
  if (path === '/__reset') { hits.length = 0; return html(response, '{}', 'application/json'); }
  if (path === '/__hits') {
    const prefix = url.searchParams.get('prefix') ?? '';
    return html(response, JSON.stringify(hits.filter((hit) => hit.path.startsWith(prefix))), 'application/json');
  }
  hits.push({ path: request.url ?? '/', headers: { 'user-agent': request.headers['user-agent'], cookie: request.headers.cookie, referer: request.headers.referer,
    authorization: request.headers.authorization, 'accept-language': request.headers['accept-language'], host: request.headers.host, 'accept-encoding': request.headers['accept-encoding'] } });
  if (path === '/article') return html(response, ARTICLE);
  if (path === '/plain') return html(response, page('<title>Plain page</title><meta name="description" content="A plain description.">'));
  if (path === '/title-only') return html(response, page('<title>  Only a   title\n here </title>'));
  if (path === '/nothing') return html(response, '<html><body>no head at all</body></html>');
  if (path === '/png') return html(response, 'not really a png', 'image/png');
  if (path === '/json') return html(response, '{"title":"json"}', 'application/json');
  if (path === '/not-found') return html(response, ARTICLE, 'text/html', 404);
  if (path === '/secret') return html(response, page('<title>SECRET internal page</title><meta name="description" content="should never be fetched">'));
  if (path.startsWith('/page/')) return html(response, page(`<title>Page ${path.slice(6)}</title><meta name="description" content="Description of page ${path.slice(6)}.">`));
  if (path === '/long') return html(response, page(`<title>${LONG}${LONG}</title><meta name="description" content="${LONG}${LONG}">`));
  if (path === '/big') {
    // The real title is first; a decoy beyond the 256 KiB read comes after 300 KiB of padding and must never be seen.
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write(`<html><head><title>Big page start</title><meta name="description" content="Read from the first bytes.">${'<!-- pad -->'.repeat(26_000)}<meta property="og:title" content="LATE DECOY"></head>`);
    return response.end('<body>end</body></html>');
  }
  if (path === '/slow') return void setTimeout(() => { if (!response.destroyed) html(response, ARTICLE); }, 6_000);
  if (path === '/cookie') { response.writeHead(302, { location: '/echo', 'set-cookie': 'session=abc123; Path=/' }); return response.end(); }
  if (path === '/echo') return html(response, page('<title>Echo</title>'));
  if (path === '/redirect-ok') return redirect(response, '/article');
  if (path.startsWith('/hop/')) {
    const left = Number(path.slice(5));
    return left > 0 ? redirect(response, `/hop/${left - 1}`, 301 + (left % 2) * 6) : html(response, ARTICLE);
  }
  if (path === '/loop') return redirect(response, '/loop');
  if (path === '/redirect-private') return redirect(response, 'http://linkmock/secret');
  if (path === '/redirect-loopback') return redirect(response, 'http://127.0.0.1/secret');
  if (path === '/redirect-metadata') return redirect(response, 'http://169.254.169.254/latest/meta-data/');
  if (path === '/redirect-port') return redirect(response, 'http://public.test:8098/secret');
  if (path === '/redirect-credentials') return redirect(response, 'http://user:pw@public.test/secret');
  if (path === '/redirect-ftp') return redirect(response, 'ftp://public.test/secret');
  if (path === '/redirect-file') return redirect(response, 'file:///etc/passwd');
  if (path === '/redirect-empty') { response.writeHead(302); return response.end(); }
  html(response, 'not found', 'text/plain', 404);
});
server.listen(8098, '0.0.0.0', () => console.log('link mock listening on :8098'));
