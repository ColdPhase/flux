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

# Non-text parts of a control (#1238), measured like MEASURE: composited over every ancestor, WCAG ratio.
_PARTS = r"""
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
  function lum(p) { const c=p.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}); return c[0]*.2126+c[1]*.7152+c[2]*.0722; }
  function ratio(a,b) { const l=[lum(a),lum(b)].sort((x,y)=>y-x); return (l[0]+.05)/(l[1]+.05); }
  function find(selector) { const el=document.querySelector(selector); if(!el) throw new Error('Missing contrast target: '+selector); return el; }
"""

# The fill of a pseudo-element or of a part, against what is under it: {"selector", "pseudo"?, "underSelector"?}.
# Without `underSelector` the part sits on the element's own composited background (a knob on its track).
FILL = "(spec) => {" + _PARTS + r"""
  const el = find(spec.selector);
  const under = spec.underSelector ? background(find(spec.underSelector)) : background(el);
  const style = getComputedStyle(el, spec.pseudo || null);
  const fill = over(rgba(style.backgroundColor), under);
  return {selector: spec.selector, fill: fill.slice(0,3), under: under.slice(0,3), ratio: ratio(fill, under), lighter: lum(fill) > lum(under)};
}"""

# The 1 px inset edge of a control (a box-shadow with a 1 px spread and `inset`), composited over the control's own fill, against
# what is outside it: {"selector", "outsideSelector"}. `ratio` is 1 when there is no such edge.
RING = "(spec) => {" + _PARTS + r"""
  const el = find(spec.selector);
  const shadow = getComputedStyle(el).boxShadow;
  const parts = []; let depth = 0, from = 0;
  for (let i = 0; i < shadow.length; i++) {
    if (shadow[i] === '(') depth++; else if (shadow[i] === ')') depth--;
    else if (shadow[i] === ',' && depth === 0) { parts.push(shadow.slice(from, i)); from = i + 1; }
  }
  parts.push(shadow.slice(from));
  const edge = parts.find(p => /inset/.test(p) && /\b0px 0px 0px 1px\b/.test(p));
  const outside = background(find(spec.outsideSelector));
  if (!edge) return {selector: spec.selector, edge: null, ratio: 1, shadow};
  const colour = rgba(edge.match(/rgba?\([^)]*\)/)[0]);
  const own = background(el);
  const ring = over(colour, own);
  return {selector: spec.selector, edge: ring.slice(0,3), outside: outside.slice(0,3), ratio: ratio(ring, outside)};
}"""
