"""Diagnostic control for #526; run in the pinned UI-test Docker image (see README)."""

import json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

received = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, body, content_type):
        body = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        received.append(('GET', self.path))
        self.reply('<div id="result"></div>' if self.path == '/' else '{"ok":true}', 'text/html' if self.path == '/' else 'application/json')
    def do_PATCH(self):
        received.append(('PATCH', self.path))
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.reply('{"status":"in_progress"}', 'application/json')
server = ThreadingHTTPServer(('127.0.0.1', 26102), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    print('Browser', browser.version, flush=True)
    for mode in ['remove', 'retain']:
        failed = 0
        for iteration in range(30):
            page = browser.new_page()
            server_start = len(received)
            page.goto('http://127.0.0.1:26102/')
            held = []
            network = []
            def record(event): network.append({'ms':time.monotonic_ns() // 1_000_000, **event})
            page.on('request', lambda r: record({'event':'request','method':r.method,'url':r.url}))
            page.on('response', lambda r: record({'event':'response','method':r.request.method,'url':r.url,'status':r.status}))
            page.on('requestfinished', lambda r: record({'event':'finished','method':r.method,'url':r.url}))
            page.on('requestfailed', lambda r: record({'event':'failed','method':r.method,'url':r.url,'failure':r.failure}))
            def hold(route, *, held=held, page=page):
                if route.request.method == 'PATCH' and not held:
                    held.append((route, route.fetch()))
                    page.evaluate("window.__held = true")
                else:
                    route.continue_()
            page.route('**/patch', hold)
            page.evaluate('''() => {
                window.events = [];
                void (async () => {
                    events.push('patch-start');
                    try {
                        const patch = await fetch('/patch', {method:'PATCH'});
                        events.push('patch-headers');
                        await patch.text();
                        events.push('patch-body');
                    } catch (e) { events.push('patch-error'); }
                    events.push('me-start');
                    const me = await fetch('/me');
                    events.push('me-headers');
                    await me.text();
                    events.push('me-body');
                    document.querySelector('#result').textContent = 'done';
                })();
            }''')
            page.wait_for_function('window.__held === true')
            held[0][0].fulfill(response=held[0][1])
            if mode == 'remove': page.unroute('**/patch', hold)
            try:
                expect(page.locator('#result')).to_have_text('done', timeout=8000)
            except AssertionError:
                failed += 1
                print(json.dumps({'mode':mode,'iteration':iteration,'phases':page.evaluate('events'),'network':network,'server_since_navigation':received[server_start:]}), flush=True)
            page.close()
        print(json.dumps({'mode':mode,'failed':failed,'total':30}), flush=True)
    browser.close()
server.shutdown()
