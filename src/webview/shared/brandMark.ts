/** The SigMixa mark (media/activity-icon.svg: viewBox 106 66 1041 1041, paths under translate(0,1254) scale(0.1,-0.1)). */
const ICON_PATHS: readonly string[] = ["M4708 10750 c-306 -28 -588 -162 -812 -385 -99 -99 -169 -201 -314 -455 -61 -107 -333 -584 -605 -1060 -272 -476 -558 -977 -637 -1115 -78 -137 -162 -284 -186 -325 -225 -391 -255 -845 -84 -1247 23 -53 121 -234 217 -402 97 -168 205 -358 241 -421 35 -63 68 -119 72 -125 4 -5 267 -464 585 -1020 317 -555 599 -1040 626 -1077 64 -86 216 -230 306 -291 180 -120 364 -191 563 -217 60 -8 543 -10 1640 -8 1553 4 1555 4 1645 25 172 41 295 95 446 194 112 74 265 223 336 329 27 41 296 505 596 1030 299 525 656 1149 792 1385 323 562 343 603 390 785 86 329 48 677 -106 982 -28 56 -1432 2517 -1566 2745 -216 368 -532 593 -933 664 -77 14 -3070 22 -3212 9z m3222 -628 c152 -55 290 -160 377 -287 11 -16 144 -246 295 -510 152 -264 378 -658 503 -875 125 -217 351 -611 503 -875 152 -264 291 -514 309 -557 82 -187 82 -455 1 -638 -14 -30 -216 -388 -449 -795 -233 -407 -597 -1043 -809 -1413 -222 -388 -406 -698 -435 -733 -60 -73 -142 -137 -231 -179 -136 -64 -38 -61 -1756 -58 l-1563 3 -67 26 c-132 51 -249 138 -321 237 -31 42 -219 365 -427 732 -42 74 -128 225 -192 335 -63 110 -231 403 -373 650 -142 248 -308 538 -370 645 -234 406 -279 487 -306 546 -82 181 -90 411 -20 604 16 43 130 254 263 485 130 226 349 608 488 850 139 242 383 667 542 945 160 278 306 529 325 559 101 155 276 279 448 316 48 11 359 13 1630 12 l1570 -2 65 -23z M6080 9450 c-555 -35 -1063 -223 -1503 -557 -140 -106 -383 -351 -493 -498 -304 -405 -482 -829 -561 -1335 -14 -92 -18 -176 -18 -420 0 -268 3 -323 23 -452 106 -681 424 -1312 902 -1788 408 -407 944 -694 1489 -795 336 -62 736 -60 1098 5 518 94 1030 339 1278 613 90 98 110 144 110 252 0 99 -17 146 -72 196 -100 93 -212 88 -358 -17 -292 -210 -632 -345 -1030 -411 -88 -14 -167 -18 -395 -18 -315 0 -369 6 -618 71 -775 201 -1399 801 -1651 1587 -81 254 -106 422 -105 707 1 197 5 244 28 372 102 574 389 1055 819 1375 281 209 609 340 971 388 158 21 440 16 586 -10 546 -99 956 -433 1115 -907 100 -301 84 -612 -50 -960 -46 -119 -51 -153 -31 -223 59 -200 315 -246 495 -89 83 72 190 263 250 444 176 532 75 1158 -263 1630 -33 47 -110 136 -170 198 -439 451 -1119 687 -1846 642z", "M6221 8019 c-77 -10 -159 -55 -200 -110 -25 -34 -78 -167 -201 -505 -391 -1073 -480 -1316 -490 -1334 -9 -17 -27 -19 -248 -22 -221 -3 -240 -4 -278 -25 -115 -62 -179 -205 -154 -345 18 -100 74 -182 154 -223 l60 -30 339 -3 c318 -3 344 -2 407 17 82 25 146 79 184 153 14 29 62 152 107 273 44 121 89 243 99 270 36 96 172 461 200 535 46 125 60 154 69 144 5 -5 34 -88 64 -184 31 -96 62 -195 70 -220 17 -52 53 -165 127 -400 44 -139 93 -295 209 -660 10 -30 42 -131 72 -224 61 -192 89 -236 181 -277 73 -33 193 -33 258 -1 89 43 112 78 218 332 l98 235 535 5 c597 6 568 2 652 79 122 112 128 346 13 464 -86 89 -15 82 -858 85 -572 2 -748 5 -756 15 -5 7 -19 41 -30 77 -11 36 -43 135 -70 220 -28 85 -82 256 -122 380 -39 124 -80 250 -90 280 -10 30 -51 156 -90 280 -202 634 -181 577 -231 627 -75 76 -176 108 -298 92z"];
const VIEW = { x: 106, y: 66, size: 1041 };

export interface BrandColors { readonly background: string; readonly foreground: string; readonly muted: string }

/** The SigMixa icon alone as inline SVG markup, drawn in the surrounding text colour. */
export function brandIconSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.size} ${VIEW.size}" fill="currentColor" role="img" aria-label="SigMixa"><g transform="translate(0,1254) scale(0.1,-0.1)">${ICON_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;
}

/** A small, quiet "SigMixa" mark for the bottom-right corner of exported images. */
const MARK = { icon: 20, gap: 6, font: 14, margin: 12, alpha: .7 };

function markWidth(context: CanvasRenderingContext2D): number { context.save(); context.font = `600 ${MARK.font}px sans-serif`; const width = MARK.icon + MARK.gap + context.measureText('SigMixa').width; context.restore(); return width; }

/** Draws the mark on a raster export. */
export function drawBrandMark(context: CanvasRenderingContext2D, width: number, height: number, color: string): void {
  const x = width - MARK.margin - markWidth(context); const y = height - MARK.margin - MARK.icon; const scale = MARK.icon / VIEW.size;
  context.save(); context.globalAlpha = MARK.alpha; context.fillStyle = color;
  context.save(); context.translate(x, y); context.scale(scale, scale); context.translate(-VIEW.x, -VIEW.y); context.translate(0, 1254); context.scale(.1, -.1);
  for (const d of ICON_PATHS) context.fill(new Path2D(d)); context.restore();
  context.font = `600 ${MARK.font}px sans-serif`; context.textBaseline = 'middle'; context.fillText('SigMixa', x + MARK.icon + MARK.gap, y + MARK.icon / 2 + .5);
  context.restore();
}

/** The same mark as SVG markup, to append inside an exported SVG of `width` × `height`. */
export function brandMarkSvg(width: number, height: number, color: string): string {
  const context = document.createElement('canvas').getContext('2d'); const textWidth = context ? markWidth(context) - MARK.icon - MARK.gap : 48;
  const x = width - MARK.margin - MARK.icon - MARK.gap - textWidth; const y = height - MARK.margin - MARK.icon; const fill = color.replace(/"/g, '');
  return `<g opacity="${MARK.alpha}" fill="${fill}"><svg x="${x}" y="${y}" width="${MARK.icon}" height="${MARK.icon}" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.size} ${VIEW.size}"><g transform="translate(0,1254) scale(0.1,-0.1)">${ICON_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g></svg><text x="${x + MARK.icon + MARK.gap}" y="${y + MARK.icon / 2 + 5}" font-family="sans-serif" font-size="${MARK.font}" font-weight="600">SigMixa</text></g>`;
}

/** Adds the mark to one graph's export (raster and vector). */
export function withBrandMark(image: { readonly canvas: HTMLCanvasElement; readonly svg: string; readonly width: number; readonly height: number }, color: string): { pngDataUrl: string; svg: string } {
  const context = image.canvas.getContext('2d');
  if (context) { context.save(); context.setTransform(image.canvas.width / image.width, 0, 0, image.canvas.height / image.height, 0, 0); drawBrandMark(context, image.width, image.height, color); context.restore(); }
  return { pngDataUrl: image.canvas.toDataURL('image/png'), svg: image.svg.replace(/<\/svg>$/, `${brandMarkSvg(image.width, image.height, color)}</svg>`) };
}
