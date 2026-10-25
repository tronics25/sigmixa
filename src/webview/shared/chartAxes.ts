import { tickStep, tickValue } from '../../core/chart/axisTicks';

/** Shared by rendering, cursor hit testing and image export. Axis 0/1 are L1/R1. */
export function chartAxisGeometry(width: number, axisCount: number): { left: number; right: number; plotWidth: number; axisWidth: number } {
  const count = Math.max(1, axisCount);
  const leftCount = Math.ceil(count / 2);
  const rightCount = Math.max(1, Math.floor(count / 2));
  // Keep a usable plot when many unit systems are selected in a narrow view.
  const plotMinimum = width * .5;
  const axisWidth = Math.min(92, Math.max(0, width - plotMinimum) / (leftCount + rightCount));
  const left = leftCount * axisWidth;
  const right = rightCount * axisWidth;
  return { left, right, plotWidth: Math.max(1, width - left - right), axisWidth };
}

/** Readable grid positions inside the exact data range; never changes the data or the viewport. */
export function chartTicks(minimum: number, maximum: number, intervals = 5): number[] {
  const span = maximum - minimum;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !Number.isFinite(span) || span <= 0) return [];
  const step = tickStep(span / Math.max(1, intervals), [1.5, 3.5, 7.5]);
  if (!step || step.size === 0) return [minimum, maximum];
  const start = Math.ceil(minimum / step.size);
  const end = Math.floor(maximum / step.size);
  const ticks: number[] = [];
  for (let index = 0; index <= Math.min(100, end - start); index++) {
    const value = tickValue(start + index, step);
    if (value >= minimum && value <= maximum && ticks.at(-1) !== value) ticks.push(value);
  }
  return ticks;
}
