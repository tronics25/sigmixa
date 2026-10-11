import type { ClipDefinition, SigMixaProject } from './schema';

/** Clip edges are kept to the microsecond, the finest step a log's timestamps have. */
export function roundClipTime(seconds: number): number { return Math.round(seconds * 1e6) / 1e6; }

/** Why a start and an end do not make a Clip range, or undefined when they do. */
export function refuseClipRange(start: number, end: number): 'not-a-number' | 'negative' | 'empty' | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'not-a-number';
  if (start < 0) return 'negative';
  return end > start ? undefined : 'empty';
}

/** Reads "12.5 - 20" (also with –, —, ~, 〜 or a space between, and an optional "s"): the start and end in seconds. */
export function parseClipRangeInput(text: string): { start: number; end: number } | undefined {
  const match = /^\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*s?\s*(?:[-–—~〜～]|\s)\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*s?\s*$/i.exec(text.normalize('NFKC'));
  if (!match) return undefined;
  const range = { start: roundClipTime(Number(match[1])), end: roundClipTime(Number(match[2])) };
  return refuseClipRange(range.start, range.end) ? undefined : range;
}

/** The project with one Clip's time range replaced. Only the range changes; a range that is not valid changes nothing. */
export function withClipRange(project: SigMixaProject, clipId: string, start: number, end: number): SigMixaProject {
  const range = { start: roundClipTime(start), end: roundClipTime(end) };
  if (refuseClipRange(range.start, range.end) || !project.clips.some((clip) => clip.id === clipId)) return project;
  return { ...project, clips: project.clips.map((clip): ClipDefinition => clip.id === clipId ? { ...clip, startTimestamp: range.start, endTimestamp: range.end } : clip) };
}

/** While one edge of a Clip is dragged: the range with that edge at `time`, kept inside the log and at least `minimum` long. */
export function dragClipEdge(range: { start: number; end: number }, edge: 'start' | 'end', time: number, log: { start: number; end: number }, minimum: number): { start: number; end: number } {
  return edge === 'start'
    ? { start: roundClipTime(Math.max(log.start, Math.min(time, range.end - minimum))), end: range.end }
    : { start: range.start, end: roundClipTime(Math.min(log.end, Math.max(time, range.start + minimum))) };
}
