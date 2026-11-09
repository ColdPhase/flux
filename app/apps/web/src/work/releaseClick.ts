/**
 * A long press opens its sheet while the finger is still down, and lifting the finger sends a click to whatever is then under it: the
 * scrim, which would close the sheet again, or a row, which would run an action nobody chose (#1013). This swallows that one click.
 * It ends at the first click it swallows, at the next touch, and a second after the finger lifts. A keyboard's click has no `detail`,
 * so it is never swallowed.
 */
export function swallowReleaseClick(): void {
  let lifted = 0;
  const end = () => {
    window.clearTimeout(lifted);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerdown', end, true);
    window.removeEventListener('pointerup', onLift, true);
    window.removeEventListener('pointercancel', onLift, true);
  };
  function onClick(event: MouseEvent) {
    if (event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
    end();
  }
  function onLift() {
    window.clearTimeout(lifted);
    lifted = window.setTimeout(end, 1000);
  }
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerdown', end, true);
  window.addEventListener('pointerup', onLift, true);
  window.addEventListener('pointercancel', onLift, true);
}
