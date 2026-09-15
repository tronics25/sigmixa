import type { ManualDerivedOperation, ManualLookupPoint } from '../../core/manual/manualDefinition';
import { t } from '../shared/i18n';

export interface PreviewPoint { readonly input: number; readonly output: number; readonly index?: number }
export interface PreviewLine { readonly points: readonly PreviewPoint[]; readonly dashed?: boolean }

/** A unit step illustrates the parameter's effect; this is not a preview of recorded data. */
export function filterStepPreview(operation: Extract<ManualDerivedOperation, { type: 'filter' }>): readonly PreviewLine[] {
  const tau = operation.timeSeconds;
  if (!Number.isFinite(tau) || tau <= 0) return [];
  const input: PreviewPoint[] = []; const output: PreviewPoint[] = [];
  for (let i = -10; i <= 120; i++) {
    const time = i * tau / 40;
    input.push({ input: time, output: i < 0 ? 0 : 1 });
    output.push({ input: time, output: i < 0 ? 0 : operation.filter === 'low-pass' ? 1 - Math.exp(-time / tau) : Math.min(1, time / tau) });
  }
  return [{ points: input, dashed: true }, { points: output }];
}

/** Preserve editor row identity while drawing the mathematical input order. */
export function lookupPreviewPoints(points: readonly ManualLookupPoint[]): readonly PreviewPoint[] {
  if (points.length < 2 || points.some((point) => !Number.isFinite(point.input) || !Number.isFinite(point.output)) || new Set(points.map((point) => point.input)).size !== points.length) return [];
  return points.map((point, index) => ({ ...point, index })).sort((a, b) => a.input - b.input);
}

export function createCurvePreview(options: { title: string; xLabel: string; yLabel: string; lines: readonly PreviewLine[]; onSelect?: (index: number) => void; clamp?: boolean }): {
  element: HTMLElement; dispose(): void; select(index: number | undefined): void; update(lines: readonly PreviewLine[]): void;
} {
  const NS = 'http://www.w3.org/2000/svg';
  const element = document.createElement('div'); element.className = 'definition-preview';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', options.title); element.appendChild(svg);
  let lines = options.lines; let active: number | undefined;
  const node = <T extends keyof SVGElementTagNameMap>(tag: T, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[T] => {
    const result = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, String(value)); if (text !== undefined) result.textContent = text; return result;
  };
  const draw = () => {
    svg.replaceChildren(); svg.appendChild(node('title', {}, options.title));
    const width = Math.max(200, element.clientWidth || 260); const height = 150;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const points = lines.flatMap((line) => line.points);
    if (!points.length) { svg.appendChild(node('text', { x: width / 2, y: 75, 'text-anchor': 'middle' }, t('Check input values', '入力値を確認してください'))); return; }
    const xs = points.map((point) => point.input); const ys = points.map((point) => point.output);
    let xmin = Math.min(...xs); let xmax = Math.max(...xs); let ymin = Math.min(...ys); let ymax = Math.max(...ys);
    const xpad = (xmax - xmin) * .07 || 1; const ypad = (ymax - ymin) * .08 || 1;
    xmin -= xpad; xmax += xpad; ymin -= ypad; ymax += ypad;
    const left = 48; const right = width - 14; const top = 22; const bottom = height - 30;
    const x = (value: number) => left + (value - xmin) / (xmax - xmin) * (right - left);
    const y = (value: number) => bottom - (value - ymin) / (ymax - ymin) * (bottom - top);
    const number = (value: number) => String(Number(value.toPrecision(3)));
    for (let i = 0; i <= 2; i++) {
      const xv = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * i / 2;
      const yv = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * i / 2;
      svg.append(node('path', { d: `M${left},${y(yv)}H${right}`, class: 'preview-grid' }), node('text', { x: left - 6, y: y(yv) + 4, 'text-anchor': 'end' }, number(yv)), node('text', { x: x(xv), y: bottom + 15, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle' }, number(xv)));
    }
    svg.append(node('text', { x: left, y: 12 }, options.yLabel), node('text', { x: right, y: height - 1, 'text-anchor': 'end' }, options.xLabel));
    for (const line of lines) {
      svg.appendChild(node('path', { d: line.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.input)},${y(point.output)}`).join(''), class: line.dashed ? 'preview-input' : 'preview-output' }));
      if (options.clamp && line.points.length) {
        const first = line.points[0]; const last = line.points.at(-1)!;
        svg.appendChild(node('path', { d: `M${left},${y(first.output)}H${x(first.input)}M${x(last.input)},${y(last.output)}H${right}`, class: 'preview-extension' }));
      }
      for (const point of line.points) {
        if (point.index === undefined) continue;
        const circle = node('circle', { cx: x(point.input), cy: y(point.output), r: active === point.index ? 5 : 3, class: 'preview-point', 'data-point-index': point.index });
        if (options.onSelect) {
          circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button');
          circle.setAttribute('aria-label', `${point.input} → ${point.output}`);
          const select = () => { active = point.index; options.onSelect?.(point.index!); draw(); };
          circle.addEventListener('click', select); circle.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
        }
        svg.appendChild(circle);
      }
    }
  };
  const observer = new ResizeObserver(draw); observer.observe(element); draw();
  return { element, dispose: () => observer.disconnect(), select: (index) => { active = index; draw(); }, update: (next) => { lines = next; draw(); } };
}
