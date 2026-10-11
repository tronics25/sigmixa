import { brandMarkSvg, drawBrandMark } from './brandMark';

/** One graph's own export: its raster canvas, PNG data URL and SVG at the same pixel size. */

export interface SheetImage { readonly canvas: HTMLCanvasElement; readonly pngDataUrl: string; readonly svg: string; readonly width: number; readonly height: number }

const CELL_WIDTH = 800;
const GAP = 16;
const MARGIN = 24;
const HEADER = 72;

/**
 * Lays every graph of a screen out on one sheet: a heading, then the graphs two per row at half size.
 * The PNG draws the graphs' canvases; the SVG nests their SVGs, so it stays vector.
 */
export function composeImageSheet(heading: string, subtitle: string, images: readonly SheetImage[], colors: { readonly background: string; readonly foreground: string; readonly muted: string }): { pngDataUrl: string; svg: string } | undefined {
  if (!images.length) return undefined;
  const columns = images.length > 1 ? 2 : 1;
  const cells = images.map((image) => ({ image, scale: CELL_WIDTH / image.width, height: image.height * CELL_WIDTH / image.width }));
  const rows: (typeof cells)[] = []; for (let index = 0; index < cells.length; index += columns) rows.push(cells.slice(index, index + columns));
  const width = MARGIN * 2 + columns * CELL_WIDTH + (columns - 1) * GAP;
  const rowHeights = rows.map((row) => Math.max(...row.map((cell) => cell.height)));
  const height = Math.ceil(HEADER + rowHeights.reduce((sum, value) => sum + value, 0) + (rows.length - 1) * GAP + MARGIN);
  const positions = rows.flatMap((row, rowIndex) => row.map((cell, column) => ({ cell, x: MARGIN + column * (CELL_WIDTH + GAP), y: HEADER + rowHeights.slice(0, rowIndex).reduce((sum, value) => sum + value, 0) + rowIndex * GAP })));

  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) return undefined;
  context.fillStyle = colors.background; context.fillRect(0, 0, width, height);
  context.fillStyle = colors.foreground; context.font = '600 24px sans-serif'; context.fillText(heading, MARGIN, 40);
  context.fillStyle = colors.muted; context.font = '13px sans-serif'; context.fillText(subtitle, MARGIN, 60);
  // Draw the graphs' own canvases: the Webview CSP does not allow loading data: URLs as images.
  for (const { cell, x, y } of positions) context.drawImage(cell.image.canvas, x, y, CELL_WIDTH, cell.height);
  drawBrandMark(context, width, height, colors.foreground);

  const nested = positions.map(({ cell, x, y }, index) => embed(cell.image.svg, x, y, CELL_WIDTH, cell.height, `s${index}-`)).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${escape(colors.background)}"/><text x="${MARGIN}" y="40" font-family="sans-serif" font-size="24" font-weight="600" fill="${escape(colors.foreground)}">${escape(heading)}</text><text x="${MARGIN}" y="60" font-family="sans-serif" font-size="13" fill="${escape(colors.muted)}">${escape(subtitle)}</text>${nested}${brandMarkSvg(width, height, colors.foreground)}</svg>`;
  return { pngDataUrl: canvas.toDataURL('image/png'), svg };
}

/** Places a whole SVG document at (x, y); its IDs get a prefix so graphs' clip paths do not collide. */
function embed(svg: string, x: number, y: number, width: number, height: number, prefix: string): string {
  const body = svg.replace(/^<\?xml[^>]*>/, '').replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#/g, `url(#${prefix}`).replace(/href="#/g, `href="#${prefix}`);
  return body.replace(/^<svg\b([^>]*)>/, (_, attributes: string) => `<svg${attributes.replace(/\s(?:width|height|x|y)="[^"]*"/g, '')} x="${x}" y="${y}" width="${width}" height="${height}">`);
}

function escape(text: string): string { return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!); }
