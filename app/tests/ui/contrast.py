"""Composited text and icon contrast in the running app (#338): the actual colours a person sees.

`page.evaluate(MEASURE, {"selector": ..., "property"?: ..., "pseudo"?: ..., "backgroundSelector"?: ...})`
returns the foreground and background after compositing every ancestor, and their WCAG ratio.
"""

MEASURE = r"""(spec) => {
  const el = document.querySelector(spec.selector);
  if (!el) throw new Error('Missing contrast target: ' + spec.selector);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  function rgba(value) {
    ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1);
    const p=ctx.getImageData(0,0,1,1).data; return [p[0],p[1],p[2],p[3]/255];
  }
  function over(a,b) { return [0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1); }
  function background(node) {
    const chain=[]; for(let n=node;n;n=n.parentElement) chain.unshift(n);
    return chain.reduce((bg,n)=>over(rgba(getComputedStyle(n).backgroundColor),bg), [255,255,255,1]);
  }
  const style=getComputedStyle(el,spec.pseudo||null);
  for(let n=el;n;n=n.parentElement) {
    if(Number(getComputedStyle(n).opacity)!==1) throw new Error('Contrast scope requires opaque target/ancestors: ' + spec.selector);
  }
  if(Number(style.opacity)!==1 || (spec.property==='stroke' && Number(style.strokeOpacity)!==1)) throw new Error('Contrast scope requires opaque pseudo/stroke: ' + spec.selector);
  let bg=background(spec.backgroundSelector ? document.querySelector(spec.backgroundSelector) : el);
  if(spec.pseudo) bg=over(rgba(style.backgroundColor),bg);
  const fg=over(rgba(style[spec.property||'color']),bg);
  function lum(p) { const c=p.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}); return c[0]*.2126+c[1]*.7152+c[2]*.0722; }
  const l=[lum(fg),lum(bg)].sort((a,b)=>b-a);
  return {selector:spec.selector,property:spec.property||'color',foreground:fg.slice(0,3),background:bg.slice(0,3),ratio:(l[0]+.05)/(l[1]+.05)};
}"""
