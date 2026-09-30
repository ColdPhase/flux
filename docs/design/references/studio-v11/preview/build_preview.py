"""Build the runnable refinement preview from the immutable supplied sources."""
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'supplied/src'
OUT=ROOT/'preview/flux-studio-v11-refined.html'
def change(s,old,new):
    assert s.count(old)==1, f'Expected exactly one source target: {old[:70]}'
    return s.replace(old,new)
app=(SRC/'app.js').read_text()
app=app.replace("accent:'iris'","accent:'mint'")
app=change(app,'<div class="toolbar"><select aria-label="Wybierz mapę"','<div class="toolbar map-toolbar"><select aria-label="Wybierz mapę"')
app=change(app,'class="replies-line" data-action="comments" data-id="${m.id}">${I(\'check\')} To pytanie ma rozwiązanie','class="replies-line resolution-status" data-action="comments" data-id="${m.id}">${I(\'check\')} To pytanie ma rozwiązanie')
ref=(SRC/'refinement.js').read_text()
a=ref.index('function paletteDefs()');b=ref.index('function seed()',a)
ref=ref[:a]+'''function paletteDefs(){const light=prefs().theme==='light';return [
 ['mint','Mięta',light?'#247358':'#8ed8b8'],
 ['iris','Irys',light?'#6742a6':'#b7a8ef'],
 ['sky','Błękit',light?'#2c609b':'#94bcf3']
];}
'''+ref[b:]
ref=change(ref,"p.visits=p.visits&&typeof p.visits==='object'?p.visits:{};","if(!['mint','iris','sky'].includes(p.accent))p.accent='mint';\n    p.visits=p.visits&&typeof p.visits==='object'?p.visits:{};")
intro='''<div class="row between"><span class="eyebrow">${I('lock')} Tylko dla Ciebie</span><span class="pill">AI · demo</span></div><h3>Wróć do rozmowy bez nadrabiania.</h3><p>Wybierz zakres. Skrót pojawi się tutaj — nikt nie dostanie wiadomości na czacie.</p>'''
ref=change(ref,intro,'''<div class="row between"><span class="eyebrow">${I('lock')} Skrót tylko dla Ciebie</span></div>''')
a=ref.index("${B(I('spark')+(ui.privateBusy?")
b=ref.index("${ui.privateBusy?'<div",a)
ref=ref[:a]+'''<div class="summary-tools">${B(I('spark')+(ui.privateBusy?' Przygotowuję…':s?' Odśwież skrót':' Zrób skrót'),'private-summary',ui.privateBusy?'disabled aria-busy="true"':'','summary-generate'+(ui.privateBusy?' busy':''))}<span class="summary-count">${count} ${plural(count,'wiadomość','wiadomości','wiadomości')} w okresie</span></div><details class="summary-about"><summary>${I('help')} Jak działa skrót?</summary><p>Wybór cytatów i zapisanych wyników, bez LLM. Wynik jest prywatny — nie wysyłamy wiadomości na czacie.</p></details>'''+ref[b:]
a=ref.index('function buildOutline(');b=ref.index('function mapMatches()',a)
ref=ref[:a]+(ROOT/'preview/outline.js').read_text()+'\n'+ref[b:]
app=change(app,'/* FLUX_EXPERIENCE */',(SRC/'experience.js').read_text()+'\n'+ref)
css='\n'.join((SRC/f).read_text() for f in ['style.css','experience.css','refinement.css'])+'\n'+(ROOT/'preview/refinements.css').read_text()
html=(SRC/'index.html').read_text().replace('data-accent="iris"','data-accent="mint"').replace('<title>Flux · razem od pomysłu do efektu</title>','<title>Flux Studio v11 · refined UX preview</title>')
html=html.replace('<!-- FLUX_CSS -->','<style>\n'+css+'\n</style>').replace('<!-- FLUX_JS -->','<script>\n'+app+'\n</script>')
OUT.write_text(html)
print(OUT.name, OUT.stat().st_size)
