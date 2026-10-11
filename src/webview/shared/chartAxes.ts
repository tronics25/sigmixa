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
