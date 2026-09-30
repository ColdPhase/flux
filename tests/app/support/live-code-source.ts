/** Deterministic original pixels, shared by the source and receiver audit only.
 * The receiver video itself always comes from actual decoded TURN media. */
export function drawCodeSource(canvas: HTMLCanvasElement, frame: number, share: number): void {
  const g = canvas.getContext('2d')!;
  const width = 2560, height = 1440;
  g.fillStyle = '#101827';
  g.fillRect(0, 0, width, height);
  // Four sync cells and 24 little-endian frame bits survive lossy coding.
  for (let bit = 0; bit < 28; bit++) {
    const on = bit < 4 ? bit % 2 === 0 : ((frame >>> (bit - 4)) & 1) === 1;
    g.fillStyle = on ? '#ffffff' : '#000000';
    g.fillRect(8 + bit * 16, 8, 16, 24);
  }
  g.fillStyle = '#edf3fa';
  g.font = '16px monospace';
  g.fillText(`Flux #63 · share ${share} · source frame ${frame} · 2560×1440`, 512, 28);
  g.fillText('review.ts — 14px code / 16px terminal — scroll 30px per source second', 64, 66);
  g.fillStyle = '#33455c';
  g.fillRect(1280, 88, 1, 1270);
  const scroll = (frame * 2) % 440;
  g.save();
  g.beginPath();
  g.rect(0, 96, width, 1240);
  g.clip();
  for (let row = 0; row < 84; row++) {
    const y = 118 + row * 22 - scroll;
    const n = String(row + 1).padStart(3, '0');
    g.font = '14px monospace';
    g.fillStyle = '#acc7e0';
    g.fillText(`${n}  const revision${row} = await readRevision("share-${share}", ${row});`, 64, y);
    g.font = '16px monospace';
    g.fillStyle = '#92e1bd';
    g.fillText(`${n}  $ flux check --revision=${row} --scope=source-${share}`, 1344, y);
  }
  g.restore();
  g.fillStyle = '#edf3fa';
  g.font = '14px monospace';
  g.fillText('const expected = "0O 1lI {} [] () => != ==="; // natural pixel text reference', 64, 1380);
  g.font = '16px monospace';
  g.fillText('$ git diff --check && pnpm typecheck  # text readability reference', 1344, 1380);
}
