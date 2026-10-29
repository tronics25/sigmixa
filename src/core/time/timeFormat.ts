/**
 * Where a log's timestamps sit on the clock it was recorded with. Every log format's parser gives one (or none, when its
 * file does not say); views, copies, CSV files and imports read only this. Timestamps themselves never change (Clips keep
 * them on disk); only how they are shown and exported does.
 *
 * Clock seconds are the local wall-clock time of the recording, counted like Unix time. The date and time are shown as
 * recorded, never converted to another time zone.
 */
export interface TimeReference {
  /** The measurement start, in clock seconds. */
  readonly start: number;
  /** Added to a timestamp to get clock seconds: 0 for BLF (its timestamps already are), the start for ASC. */
  readonly offset: number;
  /**
   * How far the clock is ahead of UTC, in minutes, when the file says (MDF4 does). BLF and ASC record no time zone:
   * undefined, and their clock seconds then also stand in for Unix seconds.
   */
  readonly utcOffsetMinutes?: number;
}

/** `datetime`: the recorded date and time. `relative`: seconds from the measurement start. `unix`: Unix seconds (UTC when the time zone is known). */
export type TimeDisplayMode = 'datetime' | 'relative' | 'unix';

export const TIME_DISPLAY_MODES: readonly TimeDisplayMode[] = ['datetime', 'relative', 'unix'];

export function isTimeDisplayMode(value: unknown): value is TimeDisplayMode {
  return value === 'datetime' || value === 'relative' || value === 'unix';
}

/** Without a known start only seconds can be shown, and they are the timestamps as they are. */
export function effectiveTimeMode(mode: TimeDisplayMode | undefined, reference: TimeReference | undefined): TimeDisplayMode {
  return reference ? mode ?? 'datetime' : 'relative';
}

/** What a mode adds to a timestamp to get the number it shows. */
function displayShift(mode: TimeDisplayMode, reference: TimeReference | undefined): number {
  if (!reference) return 0;
  if (mode === 'relative') return reference.offset - reference.start;
  return reference.offset - (mode === 'unix' ? (reference.utcOffsetMinutes ?? 0) * 60 : 0);
}

/** The number a mode shows for a timestamp: seconds from the start, clock seconds (`datetime`) or Unix seconds. */
export function displaySeconds(timestamp: number, mode: TimeDisplayMode, reference: TimeReference | undefined): number {
  return timestamp + displayShift(mode, reference);
}

/** The timestamp a shown number stands for: the inverse of `displaySeconds`. */
export function timestampFromDisplay(value: number, mode: TimeDisplayMode, reference: TimeReference | undefined): number {
  return value - displayShift(mode, reference);
}

/** `+09:00`, or undefined when the file does not say its time zone. */
export function formatUtcOffset(reference: TimeReference | undefined): string | undefined {
  const minutes = reference?.utcOffsetMinutes;
  if (minutes === undefined || !Number.isFinite(minutes)) return undefined;
  const magnitude = Math.abs(Math.round(minutes));
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

interface ClockParts { readonly date: string; readonly time: string }

/** Splits clock seconds into a date and a time rounded to `digits` decimals (rounding may carry into the next day). */
function clockParts(seconds: number, digits: number): ClockParts {
  const scale = 10 ** digits;
  const units = Math.round(seconds * scale);
  const perDay = 86_400 * scale;
  const day = Math.floor(units / perDay);
  let rest = units - day * perDay;
  const fraction = rest % scale; rest = (rest - fraction) / scale;
  const date = new Date(day * 86_400_000);
  const time = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}${digits ? `.${pad(fraction, digits)}` : ''}`;
  return { date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`, time };
}

/** `2024-12-31 14:09:43.491113`: what copies and CSV files hold, where width does not matter. */
export function formatClockDateTime(seconds: number, digits = 6): string {
  if (!Number.isFinite(seconds)) return '';
  const parts = clockParts(seconds, digits);
  return `${parts.date} ${parts.time}`;
}

/** `14:09:43.491113`: the time of day alone, for narrow places (table columns, graph labels). */
export function formatClockTime(seconds: number, digits = 6): string {
  return Number.isFinite(seconds) ? clockParts(seconds, digits).time : '';
}

/** `2024-12-31`: the date of the time written with `digits` decimals (which may round into the next day). */
export function formatClockDate(seconds: number, digits = 6): string {
  return Number.isFinite(seconds) ? clockParts(seconds, digits).date : '';
}

/** A timestamp as one copy or CSV cell: the full date and time (with its UTC offset when known), or seconds. */
export function formatExportTime(timestamp: number, mode: TimeDisplayMode, reference: TimeReference | undefined, seconds: (value: number) => string): string {
  const effective = effectiveTimeMode(mode, reference);
  const value = displaySeconds(timestamp, effective, reference);
  return effective === 'datetime' ? `${formatClockDateTime(value)}${formatUtcOffset(reference) ?? ''}` : seconds(value);
}

/** A time range with the date once: `2024-12-31 14:09:43.491–14:09:53.000`, or `1.500–9.500 s`. */
export function formatTimeRange(start: number, end: number, mode: TimeDisplayMode | undefined, reference: TimeReference | undefined, seconds: (value: number) => string = (value) => value.toFixed(3)): string {
  const effective = effectiveTimeMode(mode, reference);
  const first = displaySeconds(start, effective, reference); const last = displaySeconds(end, effective, reference);
  if (effective !== 'datetime') return `${seconds(first)}–${seconds(last)} s`;
  const firstDay = formatClockDate(first, 3); const lastDay = formatClockDate(last, 3);
  return `${firstDay} ${formatClockTime(first, 3)}–${firstDay === lastDay ? '' : `${lastDay} `}${formatClockTime(last, 3)}`;
}

/** The time column's heading in tables, copies and CSV files. */
export function timeColumnLabel(mode: TimeDisplayMode, reference: TimeReference | undefined): string {
  const effective = effectiveTimeMode(mode, reference);
  return effective === 'datetime' ? 'TIME' : effective === 'unix' ? 'TIME (UNIX S)' : 'TIME(S)';
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // German logger installations write German abbreviations.
  jän: 1, mär: 3, mrz: 3, mai: 5, okt: 10, dez: 12,
};

/**
 * Reads an ASC `date` line (`date Sun Aug 30 12:00:00.000 2026`, also with `am`/`pm`) into clock seconds.
 * Undefined when it cannot be read with certainty: then the log keeps showing seconds only.
 */
export function parseAscDate(line: string): number | undefined {
  const match = /^\s*date\s+(?:\S+\s+)?(\p{L}{3})\p{L}*\.?\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:\s*(am|pm))?\s+(\d{4})\s*$/iu.exec(line);
  if (!match) return undefined;
  const [, monthText, dayText, hourText, minuteText, secondText, fractionText, meridiem, yearText] = match;
  const month = MONTHS[monthText.toLowerCase()];
  const day = Number(dayText); let hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText); const year = Number(yearText);
  if (!month || day < 1 || day > 31 || minute > 59 || second > 59) return undefined;
  if (meridiem) { if (hour < 1 || hour > 12) return undefined; hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0); } else if (hour > 23) return undefined;
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(milliseconds);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return milliseconds / 1000 + (fractionText ? Number(`0.${fractionText}`) : 0);
}

/**
 * Reads a date and time written like `formatExportTime` (`2024-12-31 14:09:43.491113`, also with `T`, `/` or a UTC offset
 * such as `+09:00` or `Z`) into seconds on the clock it was written with, and that clock's UTC offset when written.
 */
export function parseClockDateTime(text: string): { readonly seconds: number; readonly utcOffsetMinutes?: number } | undefined {
  const match = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i.exec(text);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zoneText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText); const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(milliseconds).getUTCDate() !== day) return undefined;
  const seconds = milliseconds / 1000 + (fractionText ? Number(`0.${fractionText}`) : 0);
  if (!zoneText) return { seconds };
  if (zoneText.toUpperCase() === 'Z') return { seconds, utcOffsetMinutes: 0 };
  const digits = zoneText.replace(':', ''); const sign = digits[0] === '-' ? -1 : 1;
  return { seconds, utcOffsetMinutes: sign * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))) };
}

/**
 * The timestamp of a written date and time, on a log's clock. A written UTC offset is converted to the log's when both are
 * known; otherwise the time is taken as written (BLF and ASC record no time zone).
 */
export function timestampFromClockText(text: string, reference: TimeReference): number | undefined {
  const parsed = parseClockDateTime(text);
  if (!parsed) return undefined;
  const shift = parsed.utcOffsetMinutes !== undefined && reference.utcOffsetMinutes !== undefined ? (reference.utcOffsetMinutes - parsed.utcOffsetMinutes) * 60 : 0;
  return parsed.seconds + shift - reference.offset;
}
