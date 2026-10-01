"""Selected computed color pairs, not a full WCAG audit."""
from browser_support import launch
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
ROOT=Path(__file__).resolve().parents[1]
results=[]
def rgb(h):
 h=h.strip();h=h[1:];h=''.join(c*2 for c in h) if len(h)==3 else h;return [int(h[i:i+2],16)/255 for i in [0,2,4]]
def lum(c):
 c=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in c];return sum(x*y for x,y in zip(c,[.2126,.7152,.0722]))
def ratio(a,b):
 x,y=sorted([lum(rgb(a)),lum(rgb(b))]);return (y+.05)/(x+.05)
with sync_playwright() as p:
 b=launch(p);page=b.new_page();page.set_content((ROOT/'flux-studio-v11.html').read_text())
 names=page.evaluate('Flux11.paletteDefs().map(p=>p[0])')
 for theme in ['light','dark']:
  for name in names:
   page.evaluate('([theme,name])=>{Flux.action("theme-set",{dataset:{value:theme}});Flux.action("accent-set",{dataset:{value:name}})}',[theme,name])
   colors=page.evaluate("()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(['bg','surface','text','muted','dim','accent','on-accent','own','accent-soft'].map(k=>[k,s.getPropertyValue('--'+k).trim()]))}")
   for fg,bg in [('text','bg'),('text','surface'),('muted','surface'),('accent','surface'),('on-accent','accent'),('text','own')]:
    r=ratio(colors[fg],colors[bg]);results.append({'theme':theme,'accent':name,'foreground':fg,'background':bg,'ratio':round(r,2),'target':4.5,'passed':r>=4.5})
 b.close()
report={'scope':'108 selected computed color pairs across 18 combinations. Not all components/states, not full WCAG compliance.','passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results),'tests':results}
(ROOT/'tests/contrast-v11.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(report['passed'],'passed',report['failed'],'failed');print([x for x in results if not x['passed']])
if report['failed']:raise SystemExit(1)
