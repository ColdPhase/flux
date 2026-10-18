// TEST ONLY: preserve the previous SVG marks as an independent browser raster reference.
// Geometry comes from the rendered plane/camera, not the new canvas drawing's arguments.
window.minimapReference = async function () {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const canvas = document.querySelector('.sk-minimap__drawing');
  const view = document.querySelector('.sk-canvas');
  const plane = document.querySelector('.sk-plane');
  const zoom = new DOMMatrix(plane.style.transform || undefined).a;
  const boxes = [...plane.querySelectorAll('.sk-node')].map(node => {
    const position = new DOMMatrix(node.style.transform);
    return {x: position.e, y: position.f, w: parseFloat(node.style.width), h: node.offsetHeight};
  });
  const left = view.scrollLeft / zoom, top = view.scrollTop / zoom;
  const vw = view.clientWidth / zoom, vh = view.clientHeight / zoom;
  const x0 = Math.min(left, ...boxes.map(b => b.x - 24));
  const y0 = Math.min(top, ...boxes.map(b => b.y - 24));
  const x1 = Math.max(left + vw, ...boxes.map(b => b.x + b.w + 24));
  const y1 = Math.max(top + vh, ...boxes.map(b => b.y + b.h + 24));
  const k = Math.min(172 / Math.max(1, x1 - x0), 112 / Math.max(1, y1 - y0));
  const frame = {x0, y0, k, dx: (172 - (x1 - x0) * k) / 2, dy: (112 - (y1 - y0) * k) / 2};
  const at = (x, y) => ({x: frame.dx + (x - frame.x0) * frame.k, y: frame.dy + (y - frame.y0) * frame.k});
  const color = getComputedStyle(canvas).color;
  const colorProbe = document.createElement('canvas').getContext('2d');
  colorProbe.fillStyle = color;
  const drawColor = colorProbe.fillStyle;
  const expected = boxes.map(b => {
    const p = at(b.x, b.y);
    return {x: p.x, y: p.y, w: Math.max(3, b.w * frame.k), h: Math.max(2, b.h * frame.k)};
  });
  const draws = canvas.__marks || [];
  let geometryError = draws.length === expected.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(draws.length, expected.length); i++) {
    const a = draws[i], b = expected[i];
    geometryError = Math.max(geometryError, Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.w-b.w), Math.abs(a.h-b.h),
      Math.abs(a.rx-Math.min(1.5,b.w/2)), Math.abs(a.ry-Math.min(1.5,b.h/2)));
  }
  // Original JSX: <rect x={p.x} y={p.y} width={Math.max(3,b.w*k)}
  // height={Math.max(2,b.h*k)} rx={1.5}/>, fill:var(--t3), opacity:.6 PER rectangle.
  async function raster({radius = 1.5, minimum = true} = {}) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="172" height="112">${boxes.map((b,i) => {
      const p = at(b.x,b.y);
      return `<rect x="${p.x}" y="${p.y}" width="${minimum?expected[i].w:b.w*k}" height="${minimum?expected[i].h:b.h*k}" rx="${radius}" fill="${color}" opacity=".6"/>`;
    }).join('')}</svg>`;
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + btoa(svg);
    await image.decode();
    const reference = document.createElement('canvas');
    reference.width = canvas.width; reference.height = canvas.height;
    reference.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    if (radius === 1.5 && minimum) {
      window.__minimapReferencePNG = reference.toDataURL();
      window.__minimapActualPNG = canvas.toDataURL();
    }
    const a = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const b = reference.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let error = 0, ink = 0, colorError = 0;
    for (let i = 0; i < a.length; i += 4) {
      error += Math.abs(a[i+3]-b[i+3]); ink += b[i+3];
      if (a[i+3] > 100 && b[i+3] > 100)
        for (let c=0;c<3;c++) colorError=Math.max(colorError,Math.abs(a[i+c]-b[i+c]));
    }
    return {relativeAlphaError:error/Math.max(1,ink),colorError,ink};
  }
  const overlay = document.querySelector('.sk-minimap__view');
  const shown = at(left,top);
  const overlayError = Math.max(Math.abs(parseFloat(overlay.style.left)-shown.x), Math.abs(parseFloat(overlay.style.top)-shown.y),
    Math.abs(parseFloat(overlay.style.width)-vw*k), Math.abs(parseFloat(overlay.style.height)-vh*k));
  return {count:boxes.length,geometryError,overlayError,frame, color, drawColor,
    drawColors:[...new Set(draws.map(d=>d.color))],alphas:[...new Set(draws.map(d=>d.alpha))],
    backing:[canvas.width,canvas.height],dpr:devicePixelRatio,
    clamped:expected.filter(b=>b.w===3).length,
    raster:await raster(),squareControl:await raster({radius:0}),minimumControl:await raster({minimum:false})};
};
