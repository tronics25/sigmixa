import { chartTicks } from './chartAxes';
import { displaySeconds, effectiveTimeMode, formatClockDate, formatClockTime, formatExportTime, formatTimeRange, formatUtcOffset, timeColumnLabel, timestampFromDisplay, type TimeDisplayMode, type TimeReference } from '../../core/time/timeFormat';
import { t } from './i18n';
import type { ViewContextAction } from './viewContextAction';

/**
 * How one log screen shows times. Timestamps stay as they are everywhere; only text is made here, in three widths:
 * table cells (time of day to the µs), graph labels (to the ms) and copies (the full date and time).
 */
let reference: TimeReference | undefined;
let chosen: TimeDisplayMode | undefined;
const listeners = new Set<() => void>();

export function setTimeReference(next: TimeReference | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(reference)) return;
  reference = next; listeners.forEach((listener) => listener());
}
export function setTimeDisplayMode(next: TimeDisplayMode | undefined): void {
  if (next === chosen) return;
  chosen = next; listeners.forEach((listener) => listener());
}
export function onTimeDisplayChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

export function timeReference(): TimeReference | undefined { return reference; }
/**
 * The TIME heading's right-click menu (RAW Log and Signal Table): the date and time, or seconds from the start. The date
 * and time need the log's start. `choose` saves the choice with the log's view settings.
 */
export function timeFormatActions(choose: (mode: TimeDisplayMode) => void): ViewContextAction[] {
  const mode = timeMode();
  return [
    { label: t('Show as date and time', '日時で表示'), icon: 'blank', checked: mode === 'datetime', enabled: Boolean(reference), run: () => { setTimeDisplayMode('datetime'); choose('datetime'); } },
    { label: t('Show as seconds from start', '開始からの秒で表示'), icon: 'blank', checked: mode !== 'datetime', run: () => { setTimeDisplayMode('relative'); choose('relative'); } },
  ];
}

/** Views offer the date and time and seconds from the start; Unix seconds stay for External CSV import only. */
export function isShownTimeMode(value: unknown): value is 'datetime' | 'relative' { return value === 'datetime' || value === 'relative'; }

/** What the user chose, also while the log's start is not known (sent with copy and export requests). */
export function chosenTimeMode(): TimeDisplayMode | undefined { return chosen; }
/** What is shown: seconds only while the start is not known. */
export function timeMode(): TimeDisplayMode { return effectiveTimeMode(chosen, reference); }

/** The number shown for a timestamp in the current mode (clock seconds for `datetime`). */
export function shownSeconds(timestamp: number): number { return displaySeconds(timestamp, timeMode(), reference); }
/** The timestamp of a number typed in the current mode; date-time mode takes seconds from the start. */
export function timestampFromShownSeconds(value: number): number { const mode = timeMode(); return timestampFromDisplay(value, mode === 'datetime' ? 'relative' : mode, reference); }
/** The number typed for a timestamp in the current mode: the inverse of `timestampFromShownSeconds`. */
export function typedSecondsOf(timestamp: number): number { const mode = timeMode(); return displaySeconds(timestamp, mode === 'datetime' ? 'relative' : mode, reference); }
/** What typed seconds mean: seconds from the start, or Unix seconds. */
export function typedSecondsLabel(): string { return timeMode() === 'unix' ? t('Unix seconds', 'Unix秒') : reference ? t('Seconds from the measurement start', '計測開始からの秒') : t('Seconds', '秒'); }

/** Table cells: `14:09:43.491113`, or seconds with six decimals. */
export function timeCellText(timestamp: number): string {
  return timeMode() === 'datetime' ? formatClockTime(shownSeconds(timestamp)) : shownSeconds(timestamp).toFixed(6);
}
/** Copies and text exports made in the Webview: the full date and time. */
export function timeCopyText(timestamp: number): string { return formatExportTime(timestamp, timeMode(), reference, (value) => value.toFixed(6)); }
/** The time column's heading. */
export function timeColumnHeading(): string { return timeColumnLabel(timeMode(), reference); }
/** The time column's tooltip: the measurement start (with its UTC offset, only when the file records one). */
export function timeColumnTitle(): string {
  const heading = timeColumnHeading();
  if (!reference) return heading;
  const zone = formatUtcOffset(reference);
  return `${heading}\n${t('Measurement start', '計測開始')} ${formatClockDate(reference.start, 3)} ${formatClockTime(reference.start, 3)}${zone ? ` ${zone}` : ''}`;
}

/** Graph markers, cursors and readouts: `14:09:43.491`, or seconds in the caller's format followed by `s`. */
export function timeLabel(timestamp: number, seconds: (value: number) => string = (value) => value.toFixed(6)): string {
  return timeMode() === 'datetime' ? formatClockTime(shownSeconds(timestamp), 3) : `${seconds(shownSeconds(timestamp))} s`;
}
/** A time range, with the date once: `2024-12-31 14:09:43.491–14:09:53.000`, or `1.5–9.5 s`. */
export function timeRangeLabel(start: number, end: number, seconds: (value: number) => string = (value) => value.toFixed(6)): string {
  return formatTimeRange(start, end, timeMode(), reference, seconds);
}

/**
 * Time axis grid lines over a timestamp range: readable steps of the shown time (whole seconds of the clock, say), each
 * with its label. A date is added where the day differs from the range's first day.
 */
export function timeTicks(start: number, end: number, intervals: number): { readonly timestamp: number; readonly label: string }[] {
  const mode = timeMode();
  const values = chartTicks(shownSeconds(start), shownSeconds(end), intervals);
  if (mode !== 'datetime') return values.map((value) => ({ timestamp: timestampFromDisplay(value, mode, reference), label: `${value} s` }));
  const step = values.length > 1 ? values[1] - values[0] : Math.max(end - start, 1e-6);
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)));
  const firstDay = formatClockDate(shownSeconds(start), digits);
  return values.map((value) => {
    const day = formatClockDate(value, digits); const time = formatClockTime(value, digits);
    return { timestamp: timestampFromDisplay(value, mode, reference), label: day === firstDay ? time : `${day.slice(5)} ${time}` };
  });
}
