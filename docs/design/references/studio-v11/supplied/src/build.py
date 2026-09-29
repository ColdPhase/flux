from pathlib import Path
root=Path(__file__).resolve().parent
out=root.parent/'flux-studio-v11.html'
s=(root/'index.html').read_text()
css=(root/'style.css').read_text()+'\n'+(root/'experience.css').read_text()+'\n'+(root/'refinement.css').read_text()
js=(root/'app.js').read_text().replace('/* FLUX_EXPERIENCE */',(root/'experience.js').read_text()+'\n'+(root/'refinement.js').read_text())
s=s.replace('<!-- FLUX_CSS -->','<style>\n'+css+'\n</style>')
s=s.replace('<!-- FLUX_JS -->','<script>\n'+js+'\n</script>')
out.write_text(s)
print(out, out.stat().st_size)
