import type { LastFrameDto, TraceSort } from '../../extension/editors/rawLogProtocol';

export const traceCanIdKey = (item: LastFrameDto): string => `${item.row.extended ? 'e' : 's'}:${item.row.canIdValue}`;

function sortValue(item: LastFrameDto, sort: TraceSort, content: (item: LastFrameDto) => string): string | number | undefined {
  switch (sort) {
    case 'canId': return item.row.canIdValue;
    case 'name': return item.row.name;
    case 'multiplexer': return item.multiplexer?.value;
    case 'channel': return item.row.channel < 0 ? undefined : item.row.channel;
    case 'direction': return item.row.channel < 0 ? undefined : item.row.direction;
    case 'receivedAt': return item.count ? item.row.time : undefined;
    case 'age': return item.age;
    case 'count': return item.count;
    case 'interval': return item.intervalMs;
    case 'minInterval': return item.minIntervalMs;
    case 'maxInterval': return item.maxIntervalMs;
    case 'lastChange': return item.lastChangeAt;
    case 'expected': return item.multiplexer ? undefined : item.expectedPeriodMs;
    case 'deviation': return item.multiplexer ? undefined : item.deviationMs;
    case 'content': return content(item);
  }
}

/** Pins stay first in either direction; absent values stay last within each pin group. */
export function compareTraceRows(a: LastFrameDto, b: LastFrameDto, sort: TraceSort, descending: boolean, pinned: ReadonlySet<string>, content: (item: LastFrameDto) => string): number {
  const priority = Number(pinned.has(traceCanIdKey(b))) - Number(pinned.has(traceCanIdKey(a)));
  if (priority) return priority;
  const left = sortValue(a, sort, content); const right = sortValue(b, sort, content);
  if (left === undefined && right !== undefined) return 1;
  if (left !== undefined && right === undefined) return -1;
  const order = left === undefined || right === undefined ? 0 : typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
  if (order) return order * (descending ? -1 : 1);
  return a.row.canIdValue - b.row.canIdValue || Number(a.row.extended) - Number(b.row.extended) || a.row.channel - b.row.channel || a.row.direction.localeCompare(b.row.direction) || (a.multiplexer?.value ?? -1) - (b.multiplexer?.value ?? -1);
}
