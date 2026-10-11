export interface ClipSpan { readonly id: string; readonly name: string; readonly start: number; readonly end: number }
/** Where one Clip's span marker was drawn, in the canvas's CSS pixels. */
export interface ClipSpanMarker extends ClipSpan { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly startsHere: boolean; readonly endsHere: boolean }

/**
 * Where a log's Clips are: a faint band over each one's time range, and above the plot a span marker |← name →|.
 * Marks only; no value is changed. Clips that overlap in time get separate rows, and a name never leaves its own span,
 * so names cannot run into each other. Returns where each marker is, for pointing at it.
 */
export function drawClipSpans(context: CanvasRenderingContext2D, clips: readonly ClipSpan[], view: { readonly start: number; readonly end: number }, x: (time: number) => number, laneTop: number, laneHeight: number, color: string): ClipSpanMarker[] {
  const markers: ClipSpanMarker[] = []; const rows: number[] = [];
  for (const clip of [...clips].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const from = Math.max(view.start, clip.start); const to = Math.min(view.end, clip.end); if (!(to > from)) continue;
    let row = rows.findIndex((end) => end <= clip.start); if (row < 0) row = rows.length; rows[row] = clip.end;
    const bandLeft = x(from); const bandRight = x(to); const bandWidth = bandRight - bandLeft;
    context.save(); context.globalAlpha = 0.08; context.fillStyle = color; context.fillRect(bandLeft, laneTop, bandWidth, laneHeight);
    context.globalAlpha = 0.8; context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1; context.setLineDash([]);
    // Two rows fit above the plot; when more Clips overlap at one time, the further rows go just inside its top.
    const y = row < 2 ? laneTop - 9 - row * 12 : laneTop + 9 + (row - 2) * 12; const startsHere = clip.start >= view.start; const endsHere = clip.end <= view.end;
    context.font = '11px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    // The name is shortened to fit between the arrows; a span too narrow for any name shows the marker alone.
    const room = bandWidth - 28; let label = clip.name;
    if (context.measureText(label).width > room) { while (label.length > 1 && context.measureText(`${label}…`).width > room) label = label.slice(0, -1); label = room > 14 && label.length ? `${label}…` : ''; if (label && context.measureText(label).width > room) label = ''; }
    const half = label ? context.measureText(label).width / 2 + 5 : 0; const middle = bandLeft + bandWidth / 2;
    const line = (a: number, b: number) => { if (b - a > 1) { context.beginPath(); context.moveTo(Math.round(a) + .5, Math.round(y) + .5); context.lineTo(Math.round(b) + .5, Math.round(y) + .5); context.stroke(); } };
    const head = (tip: number, direction: 1 | -1) => { if (bandWidth < 14) return; context.beginPath(); context.moveTo(tip, y + .5); context.lineTo(tip + direction * 5, y - 3); context.lineTo(tip + direction * 5, y + 4); context.closePath(); context.fill(); };
    if (label) { line(bandLeft + 1, middle - half); line(middle + half, bandRight - 1); context.fillText(label, middle, y + .5); } else line(bandLeft + 1, bandRight - 1);
    markers.push({ id: clip.id, name: clip.name, left: bandLeft, right: bandRight, top: y - 6, bottom: y + 6, start: clip.start, end: clip.end, startsHere, endsHere });
    if (startsHere) { context.fillRect(Math.round(bandLeft), y - 5, 1, 11); head(bandLeft + 1, 1); }
    if (endsHere) { context.fillRect(Math.round(bandRight) - 1, y - 5, 1, 11); head(bandRight - 1, -1); }
    context.restore();
  }
  return markers;
}
