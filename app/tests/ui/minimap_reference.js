// TEST ONLY: the previous native SVG marks, reconstructed independently from the live plane/camera.
// Compare rendered SVG screenshots; WebKit SVG-data-URI -> Canvas conversion is not a pixel oracle.
globalThis.minimapReference = async function () {
  const { document, requestAnimationFrame, DOMMatrix, getComputedStyle, devicePixelRatio } = globalThis;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const drawing = document.querySelector('.sk-minimap__drawing');
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
  const expected = boxes.map(b => {
    const p = at(b.x, b.y);
    return {x: p.x, y: p.y, w: Math.max(3, b.w * frame.k), h: Math.max(2, b.h * frame.k)};
  });
  const marks = [...drawing.querySelectorAll('rect')], root = drawing.getBoundingClientRect();
  const color = getComputedStyle(marks[0]).fill;
  let geometryError = marks.length === expected.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(marks.length, expected.length); i++) {
    const el = marks[i], box = el.getBBox(), matrix = el.getScreenCTM(), style = getComputedStyle(el), b = expected[i];
    const radius = parseFloat(style.rx), rx = Math.min(radius, box.width / 2) * matrix.a, ry = Math.min(radius, box.height / 2) * matrix.d;
    geometryError = Math.max(geometryError, Math.abs(matrix.a*box.x+matrix.e-root.left-b.x),
      Math.abs(matrix.d*box.y+matrix.f-root.top-b.y), Math.abs(box.width*matrix.a-b.w), Math.abs(box.height*matrix.d-b.h),
      Math.abs(rx-Math.min(1.5,b.w/2)), Math.abs(ry-Math.min(1.5,b.h/2)));
  }
  // Original JSX: per-rect displayed coordinates, max(3,w*k), max(2,h*k), rx=1.5,
  // fill:var(--t3), opacity:.6. Keep both deliberate negative controls.
  const reference = ({radius = 1.5, minimum = true} = {}) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="172" height="112">${boxes.map((b,i) => {
      const p = at(b.x,b.y);
      return `<rect x="${p.x}" y="${p.y}" width="${minimum?expected[i].w:b.w*k}" height="${minimum?expected[i].h:b.h*k}" rx="${radius}" fill="${color}" opacity=".6"/>`;
    }).join('')}</svg>`;
  const overlay = document.querySelector('.sk-minimap__view'), shown = at(left,top);
  const overlayError = Math.max(Math.abs(parseFloat(overlay.style.left)-shown.x), Math.abs(parseFloat(overlay.style.top)-shown.y),
    Math.abs(parseFloat(overlay.style.width)-vw*k), Math.abs(parseFloat(overlay.style.height)-vh*k));
  return {count:boxes.length,geometryError,overlayError,frame,color,dpr:devicePixelRatio,
    clamped:expected.filter(b=>b.w===3).length,
    fills:[...new Set(marks.map(el=>getComputedStyle(el).fill))],alphas:[...new Set(marks.map(el=>getComputedStyle(el).opacity))],
    markup:{actual:drawing.outerHTML,reference:reference(),square:reference({radius:0}),minimum:reference({minimum:false})}};
};

// Decode actual browser screenshots through the public image API. This compares the native
// rendered SVGs, avoiding SVG-image raster backend differences and host imaging dependencies.
globalThis.minimapComparePNGs = async function ({actual, reference}) {
  const { Image, document } = globalThis;
  async function pixels(src) {
    const image = new Image(); image.src = src; await image.decode();
    const canvas = document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {data:ctx.getImageData(0,0,canvas.width,canvas.height).data,width:canvas.width,height:canvas.height};
  }
  const [a,b] = await Promise.all([pixels(actual),pixels(reference)]);
  let error=0,ink=0,colorError=0;
  for (let i=0;i<a.data.length;i+=4) {
    error+=Math.abs(a.data[i+3]-b.data[i+3]);ink+=b.data[i+3];
    if(a.data[i+3]>100&&b.data[i+3]>100)
      for(let c=0;c<3;c++)colorError=Math.max(colorError,Math.abs(a.data[i+c]-b.data[i+c]));
  }
  return {relativeAlphaError:error/Math.max(1,ink),colorError,ink,pixels:[a.width,a.height]};
};
// Playwright evaluates a returned function as a callable; installation must return no function.
void 0;
