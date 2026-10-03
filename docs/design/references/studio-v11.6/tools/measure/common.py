import sys, json, hashlib
sys.path.insert(0, '/out/pylib')
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT = Path('/out')
HTML = OUT / 'supplied/flux-studio-v11.6.html'
SOURCE_HASH = hashlib.sha256(HTML.read_bytes()).hexdigest()
assert SOURCE_HASH == '5c0f26dd05709d18d0a8c28bfa412bc29948f4b49f2738ac5c537ddbe4f943e7', SOURCE_HASH
class Q(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
def start_server():
    s = ThreadingHTTPServer(('127.0.0.1', 0), partial(Q, directory=str(OUT / 'supplied')))
    Thread(target=s.serve_forever, daemon=True).start()
    return s
class Session:
    def __init__(self, p, server, width=1440, height=900):
        self.browser = p.chromium.launch(args=['--no-sandbox'])
        self.ctx = self.browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install(time=datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc))
        self.url = f'http://127.0.0.1:{server.server_port}/{HTML.name}'
        self.page.goto(self.url)
        self.page.wait_for_function('window.Flux && window.FluxCoop')
    def act(self, a, **data):
        self.page.evaluate('([a,data])=>Flux.action(a,{dataset:data})', [a, data])
        self.page.clock.run_for(400)
    def co(self, a, **data):
        self.page.evaluate('([a,data])=>FluxCoop.action(a,data)', [a, data])
        self.page.clock.run_for(400)
    def fresh(self, width=1440, height=900, theme='dark'):
        # A new browser context per scenario: no persisted demo state can leak between scenarios.
        self.ctx.close()
        self.ctx = self.browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
        self.page = self.ctx.new_page()
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install(time=datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc))
        self.page.goto(self.url)
        self.page.wait_for_function('window.Flux && window.FluxCoop')
        self.act('theme-set', value=theme)
        st = self.page.evaluate('({theme:document.documentElement.dataset.theme,accent:document.documentElement.dataset.accent})')
        assert st['theme'] == theme and st['accent'] == {'light': 'sky', 'dark': 'mint'}[theme], st
    def shot(self, name):
        self.page.evaluate("document.querySelector('#toasts') && (document.querySelector('#toasts').innerHTML='')")
        self.page.screenshot(path=str(OUT / 'shots' / name), animations='disabled')
