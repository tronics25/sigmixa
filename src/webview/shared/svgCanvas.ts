interface SvgState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  dash: number[];
  transform: string;
  clips: string[];
}

/** Records the Canvas subset used by SigMixa charts as genuine SVG vector elements. */
export function createSvgCanvas(width: number, height: number): { readonly context: CanvasRenderingContext2D; toSvg(): string } {
  const recorder = new SvgRecorder(width, height);
  return { context: recorder as unknown as CanvasRenderingContext2D, toSvg: () => recorder.toSvg() };
}

class SvgRecorder {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  private dash: number[] = [];
  private transform = '';
  private clips: string[] = [];
  private path = '';
  private hasPoint = false;
  private readonly elements: string[] = [];
  private readonly definitions: string[] = [];
  private readonly states: SvgState[] = [];
  private readonly measurement = document.createElement('canvas').getContext('2d')!;

  constructor(private readonly width: number, private readonly height: number) {}

  save(): void {
    this.states.push({ fillStyle: String(this.fillStyle), strokeStyle: String(this.strokeStyle), lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, globalAlpha: this.globalAlpha, dash: [...this.dash], transform: this.transform, clips: [...this.clips] });
  }
  restore(): void {
    const state = this.states.pop(); if (!state) return;
    this.fillStyle = state.fillStyle; this.strokeStyle = state.strokeStyle; this.lineWidth = state.lineWidth; this.font = state.font; this.textAlign = state.textAlign; this.textBaseline = state.textBaseline; this.globalAlpha = state.globalAlpha; this.dash = state.dash; this.transform = state.transform; this.clips = state.clips;
  }
  scale(x: number, y: number): void { this.transform += ` scale(${n(x)} ${n(y)})`; }
  translate(x: number, y: number): void { this.transform += ` translate(${n(x)} ${n(y)})`; }
  clearRect(): void {}
  beginPath(): void { this.path = ''; this.hasPoint = false; }
  closePath(): void { this.path += ' Z'; }
  moveTo(x: number, y: number): void { this.path += ` M${n(x)} ${n(y)}`; this.hasPoint = true; }
  lineTo(x: number, y: number): void { this.path += this.hasPoint ? ` L${n(x)} ${n(y)}` : ` M${n(x)} ${n(y)}`; this.hasPoint = true; }
  rect(x: number, y: number, width: number, height: number): void { this.path += ` M${n(x)} ${n(y)}h${n(width)}v${n(height)}h${n(-width)}Z`; this.hasPoint = true; }
  arc(x: number, y: number, radius: number, start: number, end: number, anticlockwise = false): void {
    if (!(radius >= 0)) return; const tau = Math.PI * 2; let span = anticlockwise ? start - end : end - start; while (span < 0) span += tau;
    const startX = x + Math.cos(start) * radius; const startY = y + Math.sin(start) * radius; this.path += this.hasPoint ? ` L${n(startX)} ${n(startY)}` : ` M${n(startX)} ${n(startY)}`;
    const sweep = anticlockwise ? 0 : 1;
    if (span >= tau - 1e-7) { const middle = start + (anticlockwise ? -Math.PI : Math.PI); const middleX = x + Math.cos(middle) * radius; const middleY = y + Math.sin(middle) * radius; this.path += ` A${n(radius)} ${n(radius)} 0 1 ${sweep} ${n(middleX)} ${n(middleY)} A${n(radius)} ${n(radius)} 0 1 ${sweep} ${n(startX)} ${n(startY)}`; }
    else { const endX = x + Math.cos(end) * radius; const endY = y + Math.sin(end) * radius; this.path += ` A${n(radius)} ${n(radius)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${n(endX)} ${n(endY)}`; }
    this.hasPoint = true;
  }
  fill(): void { if (this.path) this.push(`<path d="${this.path.trim()}" ${this.paint('fill')}/>`); }
  stroke(): void { if (this.path) this.push(`<path d="${this.path.trim()}" ${this.paint('stroke')}/>`); }
  clip(): void {
    if (!this.path) return; const id = `clip-${this.definitions.length + 1}`; const transform = this.transform ? ` transform="${escapeAttribute(this.transform.trim())}"` : '';
    this.definitions.push(`<clipPath id="${id}"><path d="${this.path.trim()}"${transform}/></clipPath>`); this.clips.push(id);
  }
  fillRect(x: number, y: number, width: number, height: number): void { this.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" ${this.paint('fill')}/>`); }
  strokeRect(x: number, y: number, width: number, height: number): void { this.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" ${this.paint('stroke')}/>`); }
  setLineDash(values: number[]): void { this.dash = [...values]; }
  getLineDash(): number[] { return [...this.dash]; }
  measureText(text: string): TextMetrics { this.measurement.font = this.font; return this.measurement.measureText(text); }
  fillText(text: string, x: number, y: number): void {
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start';
    const baseline = this.textBaseline === 'middle' ? 'middle' : this.textBaseline === 'top' || this.textBaseline === 'hanging' ? 'text-before-edge' : this.textBaseline === 'bottom' || this.textBaseline === 'ideographic' ? 'text-after-edge' : 'alphabetic';
    this.push(`<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" style="font:${escapeAttribute(this.font)}" fill="${escapeAttribute(String(this.fillStyle))}" opacity="${n(this.globalAlpha)}">${escapeText(text)}</text>`);
  }
  toSvg(): string {
    const definitions = this.definitions.length ? `<defs>${this.definitions.join('')}</defs>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">${definitions}${this.elements.join('')}</svg>`;
  }

  private paint(kind: 'fill' | 'stroke'): string {
    if (kind === 'fill') return `fill="${escapeAttribute(String(this.fillStyle))}" stroke="none" opacity="${n(this.globalAlpha)}"`;
    const dash = this.dash.length ? ` stroke-dasharray="${this.dash.map(n).join(' ')}"` : '';
    return `fill="none" stroke="${escapeAttribute(String(this.strokeStyle))}" stroke-width="${n(this.lineWidth)}"${dash} opacity="${n(this.globalAlpha)}"`;
  }
  private push(element: string): void {
    const transformed = this.transform ? `<g transform="${escapeAttribute(this.transform.trim())}">${element}</g>` : element;
    this.elements.push(this.clips.reduceRight((content, id) => `<g clip-path="url(#${id})">${content}</g>`, transformed));
  }
}

function n(value: number): string { return Number.isFinite(value) ? Number(value.toFixed(5)).toString() : '0'; }
function escapeText(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function escapeAttribute(value: string): string { return escapeText(value).replaceAll('"', '&quot;'); }
