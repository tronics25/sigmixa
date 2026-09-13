export type ChartGroupLayout = readonly (readonly string[])[];

export interface ChartLayoutGroup {
  readonly key: string;
}

export function arrangeChartGroups<T extends ChartLayoutGroup>(groups: readonly T[], layout?: ChartGroupLayout): readonly (readonly T[])[] {
  if (!layout?.length) return chunkPairs(groups);
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const used = new Set<string>();
  const result: T[][] = [];
  for (const row of layout) {
    const graph: T[] = [];
    for (const key of row.slice(0, 2)) {
      const group = byKey.get(key);
      if (group && !used.has(key)) { graph.push(group); used.add(key); }
    }
    if (graph.length) result.push(graph);
  }
  result.push(...chunkPairs(groups.filter((group) => !used.has(group.key))));
  return result;
}

export function moveChartGroup(layout: ChartGroupLayout, groupKey: string, targetGraph: number, targetAxis: 0 | 1): string[][] {
  const result = layout.map((graph) => [...graph.slice(0, 2)]);
  const sourceGraph = result.findIndex((graph) => graph.includes(groupKey));
  if (sourceGraph < 0 || targetGraph < 0 || targetGraph >= result.length) return result.filter((graph) => graph.length);
  const sourceAxis = result[sourceGraph].indexOf(groupKey);
  const targetKey = result[targetGraph][targetAxis];
  if (targetKey === groupKey) return result.filter((graph) => graph.length);
  if (targetKey) {
    result[targetGraph][targetAxis] = groupKey;
    result[sourceGraph][sourceAxis] = targetKey;
  } else {
    result[sourceGraph].splice(sourceAxis, 1);
    result[targetGraph].splice(Math.min(targetAxis, result[targetGraph].length), 0, groupKey);
  }
  return result.filter((graph) => graph.length);
}

export function moveChartGroupToNewGraph(layout: ChartGroupLayout, groupKey: string): string[][] {
  const result = layout.map((graph) => graph.filter((key) => key !== groupKey).slice(0, 2)).filter((graph) => graph.length);
  result.push([groupKey]);
  return result;
}

/** Finds the graph that still contains one of the Signals captured when an overlay was created. */
export function findGraphIndexBySignals(graphSignalIds: readonly (readonly string[])[], preferredSignalIds: readonly string[]): number | undefined {
  for (const signalId of preferredSignalIds) {
    const index = graphSignalIds.findIndex((ids) => ids.includes(signalId));
    if (index >= 0) return index;
  }
  return undefined;
}

function chunkPairs<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 2) result.push(items.slice(index, index + 2));
  return result;
}
