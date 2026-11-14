import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { CanFrame } from '../../core/frame/canFrame';
import type { TimeReference } from '../../core/time/timeFormat';
import { closeSync, openSync, readSync } from 'fs';
import { MdfReader, type MdfBlock } from './mdfReader';
import { ByteGather, ReadBudget } from '../readBudget';
import { parseMdf3File } from './parseMdf3';

/**
 * ASAM MDF 4.x bus logging (CAN_DataFrame, CAN_RemoteFrame, CAN_ErrorFrame, CAN_OverloadFrame), as CANedge, Vector
 * and others write it: sorted or unsorted data groups, record IDs, VLSD payloads (in a channel group or signal data
 * blocks), DZ compression and unfinalized CANedge files; and measured signals (channel groups that are not bus events)
 * with numeric values, given as series. Not read: arrays, structures, text, byte arrays and variable-length values of
 * measured signals, other buses (LIN, FlexRay, Ethernet), MDF 4.2 remote time masters, MDF 3.
 */

export interface MdfParseProgress {
  readonly framesParsed: number;
  readonly bytesRead: number;
  readonly totalBytes: number;
}

export interface MdfParseSummary {
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly linesRead: 0;
  readonly framesParsed: number;
  readonly diagnostics: number;
  readonly cancelled: boolean;
  readonly timeReference?: TimeReference;
}

export interface MdfParseOptions {
  readonly sourceId: string;
  readonly signal?: AbortSignal;
  /** May return a promise: reading waits for it (the caller holds back while its pieces are decoded elsewhere). */
  onFrames(frames: readonly CanFrame[]): void | Promise<void>;
  onDiagnostics(diagnostics: readonly Diagnostic[]): void;
  onProgress?(progress: MdfParseProgress): void;
  onTimeReference?(reference: TimeReference): void;
  /** Called once, at the end, with the file's measured signals (channel groups that are not bus logging). */
  onSignals?(series: readonly MdfSignalSeries[]): void;
}

/** A measured signal: its samples on the same time base as the frames (seconds from the measurement start). */
export interface MdfSignalSeries {
  /** The channel group's name (or its acquisition source), for grouping in the Signal list. */
  readonly group: string;
  readonly channel: string;
  readonly unit?: string;
  /** The structure or array the value is part of, and its own part of the name (`X` of `Pos.X`, `[0][1]` of `Map`). */
  readonly parent?: { readonly name: string; readonly label: string; readonly member: string };
  readonly times: Float64Array;
  /** NaN where the value is invalid. */
  readonly values: Float64Array;
  /**
   * Texts of a value-to-text or range-to-text conversion, chosen from each raw value as it was read (a converted value
   * may equal another entry's key): `indexes[i]` is sample i's text in `texts`, -1 for none. Plain data, so it crosses threads.
   */
  readonly labels?: { readonly texts: readonly string[]; readonly indexes: Int32Array };
}

/** Sample `index`'s text, if its conversion gives it one. */
export function seriesLabel(series: MdfSignalSeries, index: number): string | undefined {
  const at = series.labels?.indexes[index] ?? -1;
  return at >= 0 ? series.labels!.texts[at] || undefined : undefined;
}

/**
 * Value texts: `ranges` [min, max, text] match a raw value; `exact` (value to text) matches min only, otherwise (range
 * to text, as asammdf) min..max, max excluded for floating-point values; `fallback` the rest.
 */
export interface ValueLabels { readonly ranges: readonly (readonly [number, number, string | undefined])[]; readonly floating: boolean; readonly exact?: boolean; readonly fallback?: string }

/** The place of the entry a raw value matches (ranges.length for the fallback), as `texts` of a series list them. */
const exactKeys = new WeakMap<ValueLabels, Map<number, number>>();
export function labelIndex(labels: ValueLabels, raw: number): number {
  let hit: number;
  if (labels.exact) {
    // Value-to-text keys are looked up, not searched: tables may hold tens of thousands of them. The first key wins.
    let keys = exactKeys.get(labels);
    if (!keys) { keys = new Map(); labels.ranges.forEach(([key], i) => { if (!Number.isNaN(key) && !keys!.has(key)) keys!.set(key, i); }); exactKeys.set(labels, keys); }
    // NaN equals nothing (as in asammdf), though a Map would match it.
    hit = Number.isNaN(raw) ? -1 : keys.get(raw) ?? -1;
  } else hit = labels.ranges.findIndex(([min, max]) => raw >= min && (labels.floating ? raw < max : raw <= max));
  const text = hit >= 0 ? labels.ranges[hit][2] : labels.fallback;
  return text ? (hit >= 0 ? hit : labels.ranges.length) : -1;
}

/** The texts of a table, made once per table: elements of an array share theirs. */
const textLists = new WeakMap<ValueLabels, string[]>();
export function labelTexts(labels: ValueLabels): string[] {
  let texts = textLists.get(labels);
  if (!texts) { texts = [...labels.ranges.map(([, , text]) => text ?? ''), labels.fallback ?? '']; textLists.set(labels, texts); }
  return texts;
}

export function isMdfFileName(name: string): boolean { return /\.(mf4|mdf)$/i.test(name); }

/** The version number in an MDF file's identification block (0 when it has none). */
function mdfVersion(filePath: string): number {
  const fd = openSync(filePath, 'r');
  try { const id = Buffer.alloc(32); readSync(fd, id, 0, 32, 0); return id.readUInt16LE(28); } finally { closeSync(fd); }
}

type Report = (code: string, severity: Diagnostic['severity'], message: string, offset?: number, details?: Diagnostic['details']) => void;
type FrameFields = Omit<CanFrame, 'id' | 'sourceId'>;

const CG_VLSD = 0x1;
const CG_BUS_EVENT = 0x2;
const CN_VLSD = 1;
const CN_MASTER = 2;
const CN_VIRTUAL_MASTER = 3;
const CN_VIRTUAL = 6;
const SYNC_TIME = 1;
const CN_ALL_INVALID = 0x1;
const CN_INVALID_BIT = 0x2;
const BYTE_ARRAY = 10;
const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const BATCH = 1000;
const LOOKAHEAD = 1 << 16;
const VLSD_WINDOW = 1 << 16;
/** Values one channel group may give (array elements count one each). */
const MAX_SIGNALS = 65_536;
/** A CAN payload is at most 64 bytes; a larger SD value is not one. */
const MAX_PAYLOAD = 1 << 20;

/** A numeric conversion (CC block); text conversions leave the raw value. Undefined: a formula SigMixa cannot evaluate. */
type Conversion = (raw: number) => number;

interface Channel {
  readonly name: string;
  readonly type: number;
  readonly syncType: number;
  readonly dataType: number;
  readonly bitOffset: number;
  readonly byteOffset: number;
  readonly bitCount: number;
  readonly flags: number;
  readonly invalidBit: number;
  readonly dataLink: number;
  readonly convert: Conversion;
  /** False when its conversion is a formula that could not be read. */
  readonly convertible: boolean;
  /**
   * An element of an array whose size is given per record (dynamic size): the element holds a value only while each of
   * its indexes is below its dimension's size, read from `sizes` (channels of the same record).
   */
  readonly dynamic?: { readonly indexes: readonly number[]; readonly sizes: readonly Channel[] };
}

type BusKind = 'data' | 'remote' | 'error' | 'overload';

interface BusGroup {
  readonly kind: BusKind;
  readonly name: string;
  readonly time: Channel;
  readonly members: ReadonlyMap<string, Channel>;
  /** The members a frame is read from, looked up once. */
  readonly fields: Readonly<Record<'ID' | 'IDE' | 'DLC' | 'EDL' | 'BusChannel' | 'Dir' | 'DataLength' | 'DataBytes', Channel | undefined>>;
  readonly frame?: Channel;
  /** Where DataBytes is stored when it is not in the record. */
  readonly payload?: VlsdSource;
}

interface Group {
  readonly address: number;
  readonly recordId: number;
  readonly vlsd: boolean;
  readonly recordBytes: number;
  readonly invalidBytes: number;
  readonly dataBytes: number;
  readonly name: string;
  readonly bus?: BusGroup;
  readonly signals?: SignalGroup;
  /** The time of each record, kept when another group takes its time from this one. */
  times?: SampleColumn;
  cycle: number;
}

/** Growing sample columns of one measured signal. */
class SampleColumn {
  times = new Float64Array(16); values = new Float64Array(16); length = 0;
  /** Each sample's text (labelIndex), for a signal with value texts. */
  labels?: Int32Array;
  push(time: number, value: number, label = -1): void {
    if (this.length === this.times.length) {
      const times = new Float64Array(this.length * 2); times.set(this.times); this.times = times;
      const values = new Float64Array(this.length * 2); values.set(this.values); this.values = values;
      if (this.labels) { const labels = new Int32Array(this.length * 2); labels.set(this.labels); this.labels = labels; }
    }
    if (label >= 0 && !this.labels) this.labels = new Int32Array(this.times.length).fill(-1, 0, this.length);
    if (this.labels) this.labels[this.length] = label;
    this.times[this.length] = time; this.values[this.length++] = value;
  }
}

interface SignalGroup {
  readonly name: string;
  /** Undefined when the time comes from another group (`master`, the address of its CG block). */
  readonly time?: Channel;
  readonly master?: number;
  readonly channels: readonly { readonly channel: Channel; readonly unit?: string; readonly labels?: ValueLabels; readonly parent?: MdfSignalSeries['parent']; readonly column: SampleColumn }[];
}

type VlsdSource = { readonly kind: 'group'; readonly group: number } | { readonly kind: 'signal'; readonly address: number };

export async function parseMdfFile(filePath: string, options: MdfParseOptions): Promise<MdfParseSummary> {
  if (options.signal?.aborted) return summary(0, 0, 0, 0, true);
  // MDF 2 and 3 have another block layout: they are read by their own reader.
  if (mdfVersion(filePath) < 400) return parseMdf3File(filePath, options);
  const reader = new MdfReader(filePath, new ReadBudget(options.signal));
  try { return await parseMdf(reader, options); } finally { reader.close(); }
}

async function parseMdf(reader: MdfReader, options: MdfParseOptions): Promise<MdfParseSummary> {
  let diagnostics = 0; let framesParsed = 0; let sequence = 0; let bytesRead = 0;
  const report: Report = (code, severity, message, offset, details) => {
    diagnostics++;
    options.onDiagnostics([{
      id: `${options.sourceId}:mdf:${code}:${offset ?? diagnostics}`,
      source: 'parser', code, severity, message, location: { sourceId: options.sourceId },
      details: { ...(offset === undefined ? {} : { byteOffset: offset }), ...details },
    }]);
  };
  const header = reader.block(64, '##HD');
  const timeReference = readTimeReference(reader.body(header));
  if (timeReference) options.onTimeReference?.(timeReference);
  if (reader.unfinished) report('MDF_UNFINALIZED', 'info', 'The MDF file was not finalized by its writer (UnFinMF); its data was read up to the end of the file.', 0);

  // Each data group with bus frames is read as a stream; the streams are merged by time.
  const streams: AsyncIterator<FrameFields[]>[] = [];
  const skipped = new Map<string, number>();
  const measured: Group[] = [];
  const dataGroups: { readonly dg: MdfBlock; groups: Group[] }[] = [];
  const visited = new Set<number>();
  for (let address = header.links[0], seen = 0; address && !reader.budget.cancelled; seen++) {
    if (seen > 100_000) throw new Error('Too many MDF data groups.');
    if (visited.has(address)) throw new Error('Cyclic MDF data group list.');
    visited.add(address);
    const dg = reader.block(address, '##DG');
    dataGroups.push({ dg, groups: readGroups(reader, dg, report) });
    address = dg.links[0];
  }
  // A group that takes its time from another one (MDF 4.2, in any data group) needs that group's record times.
  const all = dataGroups.flatMap((item) => item.groups);
  for (const item of dataGroups) item.groups = item.groups.map((group): Group => {
    const master = group.signals?.master;
    if (master === undefined) return group;
    const target = all.find((other) => other.address === master);
    if (target?.signals?.time || target?.bus) { target.times ??= new SampleColumn(); return group; }
    report('MDF_REMOTE_MASTER', 'warning', `Channel group ${group.signals!.name} takes its time from a channel group without a time channel; its signals were not imported.`, group.address);
    const { signals, ...rest } = group;
    return rest;
  });
  for (const { dg, groups } of dataGroups) {
    const reading = groups.filter((group) => group.bus || group.signals);
    for (const group of groups) {
      if (group.signals) measured.push(group);
      else if (!group.bus && !group.vlsd) skipped.set(group.name || `#${group.recordId}`, group.address);
    }
    if (reading.length) streams.push(readDataGroup(reader, dg, groups, report, () => { bytesRead = reader.dataRead; })[Symbol.asyncIterator]());
  }
  if (!streams.length) {
    report('MDF_NOTHING_TO_IMPORT', 'error', 'The MDF file has neither CAN bus logging (CAN_DataFrame channel groups) nor measured signals SigMixa can read.', 0);
    return summary(reader.size, 0, 0, diagnostics, false, timeReference);
  }

  const pending: CanFrame[] = [];
  const flush = async () => { if (pending.length) await options.onFrames(pending.splice(0)); };
  // Each stream gives out its frames in time order, a batch at a time.
  const heads: { batch: FrameFields[]; at: number }[] = [];
  const advance = async (i: number): Promise<void> => {
    for (;;) {
      const next = await streams[i].next();
      if (next.done) { heads[i] = { batch: [], at: 0 }; return; }
      if (next.value.length) { heads[i] = { batch: next.value, at: 0 }; return; }
    }
  };
  for (let i = 0; i < streams.length; i++) await advance(i);
  let lastProgress = 0;
  while (!reader.budget.cancelled) {
    let next = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (head.at < head.batch.length && (next < 0 || head.batch[head.at].timestamp < heads[next].batch[heads[next].at].timestamp)) next = i;
    }
    if (next < 0) break;
    const head = heads[next];
    pending.push({ ...head.batch[head.at++], id: `${options.sourceId}:mdf:${sequence++}`, sourceId: options.sourceId });
    framesParsed++;
    if (pending.length >= BATCH) await flush();
    if (head.at >= head.batch.length) {
      await advance(next);
      if (bytesRead - lastProgress >= 1 << 16) { lastProgress = bytesRead; options.onProgress?.({ framesParsed, bytesRead: Math.min(bytesRead, reader.size), totalBytes: reader.size }); }
    }
  }
  await flush();
  for (const stream of streams) await stream.return?.();
  const cancelled = reader.budget.cancelled;
  if (!cancelled) {
    for (const [name, address] of skipped) report('MDF_GROUP_UNSUPPORTED', 'info', `Channel group ${name} is bus logging other than CAN, or has no readable time, and was not imported.`, address, { channelGroup: name });
    const series = measured.flatMap(({ signals }) => signals!.channels.filter((item) => item.column.length).map((item): MdfSignalSeries => {
      let times = item.column.times.slice(0, item.column.length);
      if (signals!.master !== undefined) {
        // Record numbers become the master group's record times.
        const master = all.find((other) => other.address === signals!.master)?.times;
        times = times.map((index) => master && index < master.length ? master.times[index] : Number.NaN);
      }
      return { group: signals!.name, channel: item.channel.name, ...(item.unit ? { unit: item.unit } : {}), ...(item.parent ? { parent: item.parent } : {}), times, values: item.column.values.slice(0, item.column.length), ...(item.labels && item.column.labels ? { labels: { texts: labelTexts(item.labels), indexes: item.column.labels.slice(0, item.column.length) } } : {}) };
    }));
    if (series.length) options.onSignals?.(series);
    else if (!framesParsed) report('MDF_NOTHING_TO_IMPORT', 'error', 'The MDF file has neither CAN frames nor measured values SigMixa can read.', 0);
  }
  return summary(reader.size, cancelled ? Math.min(bytesRead, reader.size) : reader.size, framesParsed, diagnostics, cancelled, timeReference);
}

/** HD start time: UTC nanoseconds, with the writer's time zone when it says; or the local clock (no zone known). */
function readTimeReference(body: Buffer): TimeReference | undefined {
  const nanoseconds = body.readBigUInt64LE(0);
  if (!nanoseconds) return undefined;
  const seconds = Number(nanoseconds) / 1e9;
  const flags = body[12];
  if (flags & 0x1) return { start: seconds, offset: seconds };
  const minutes = flags & 0x2 ? body.readInt16LE(8) + body.readInt16LE(10) : 0;
  const start = seconds + minutes * 60;
  return { start, offset: start, utcOffsetMinutes: minutes };
}

function readGroups(reader: MdfReader, dg: MdfBlock, report: Report): Group[] {
  const groups: Group[] = [];
  const seen = new Set<number>();
  for (let address = dg.links[1]; address; ) {
    if (groups.length > 65_536) throw new Error('Too many MDF channel groups.');
    // A list that runs back on itself would be read again and again.
    if (seen.has(address)) throw new Error('Cyclic MDF channel group list.');
    seen.add(address);
    const cg = reader.block(address, '##CG'); const body = reader.body(cg);
    const recordId = Number(body.readBigUInt64LE(0));
    if (!Number.isSafeInteger(recordId)) throw new Error(`MDF record ID of channel group at ${address} is too large.`);
    const flags = body.readUInt16LE(16);
    if (flags & CG_VLSD) { groups.push({ address, recordId, vlsd: true, recordBytes: 0, invalidBytes: 0, dataBytes: 0, name: '', cycle: 0 }); address = cg.links[0]; continue; }
    const dataBytes = body.readUInt32LE(24); const invalidBytes = body.readUInt32LE(28);
    const name = reader.text(cg.links[2]);
    const group: Group = { address, recordId, vlsd: false, recordBytes: dataBytes + invalidBytes, invalidBytes, dataBytes, name, cycle: 0 };
    const bus = busGroup(reader, cg, name, report);
    // A group that is not a bus event holds measured signals.
    const signals = bus || flags & CG_BUS_EVENT ? undefined : signalGroup(reader, cg, name || reader.text(cg.links[3] ? reader.block(cg.links[3]).links[0] : 0) || `Group ${recordId}`, report);
    groups.push({ ...group, ...(bus ? { bus } : {}), ...(signals ? { signals } : {}) });
    address = cg.links[0];
  }
  // A VLSD payload stored in a channel group names that group by its block address.
  const resolved = groups.map((group): Group => {
    const payload = group.bus?.payload;
    if (payload?.kind !== 'signal') return group;
    const target = groups.find((other) => other.address === payload.address);
    if (!target) return group;
    if (!target.vlsd) throw new Error(`MDF DataBytes of ${group.name} points to a channel group that is not VLSD.`);
    return { ...group, bus: { ...group.bus!, payload: { kind: 'group', group: target.recordId } } };
  });
  return resolved;
}

const KINDS: Readonly<Record<string, BusKind>> = { CAN_DataFrame: 'data', CAN_RemoteFrame: 'remote', CAN_ErrorFrame: 'error', CAN_OverloadFrame: 'overload' };

function busGroup(reader: MdfReader, cg: MdfBlock, name: string, report: Report): BusGroup | undefined {
  let time: Channel | undefined; let frame: Channel | undefined; let kind: BusKind | undefined;
  const members = new Map<string, Channel>();
  const seen = new Set<number>();
  const visit = (address: number, parent: string | undefined, depth: number) => {
    for (let count = 0; address; count++) {
      // Cycles are caught below; the depth only keeps the walk off the edge of the call stack.
      if (depth > 64 || count > 65_536) throw new Error('MDF channel structure is too deep or too long.');
      // A channel listed twice (a list that runs back on itself) would be read again and again.
      if (seen.has(address)) throw new Error('Cyclic MDF channel list.');
      seen.add(address);
      const cn = reader.block(address, '##CN'); const channel = readChannel(reader, cn);
      const composition = cn.links[1] && reader.block(cn.links[1]).type === '##CN' ? cn.links[1] : 0;
      if (!parent && (channel.type === CN_MASTER || channel.type === CN_VIRTUAL_MASTER) && channel.syncType === SYNC_TIME) time = channel;
      const dot = channel.name.lastIndexOf('.');
      const root = (parent ?? (dot > 0 ? channel.name.slice(0, dot) : channel.name));
      const own = KINDS[channel.name];
      if (own && !parent) { kind = own; frame = channel; }
      else if (KINDS[root] && (parent || dot > 0)) { kind ??= KINDS[root]; members.set(dot >= 0 ? channel.name.slice(dot + 1) : channel.name, channel); }
      if (composition) visit(composition, own ? channel.name : parent, depth + 1);
      address = cn.links[0];
    }
  };
  visit(cg.links[1], undefined, 0);
  if (!kind) return undefined;
  if (!time && cg.links[6]) { report('MDF_REMOTE_MASTER', 'warning', `Channel group ${name} takes its time from another channel group (MDF 4.2 remote master), which is not supported yet; it was not imported.`, cg.address); return undefined; }
  if (!time) { report('MDF_NO_TIME', 'warning', `Channel group ${name} has no time master channel and was not imported.`, cg.address); return undefined; }
  const unreadable = [time, ...members.values()].find((channel) => !channel.convertible);
  if (unreadable) { report('MDF_CONVERSION_UNSUPPORTED', 'warning', `Channel group ${name} was not imported: the conversion of ${unreadable.name} is a formula SigMixa cannot read.`, cg.address); return undefined; }
  if (kind !== 'error' && kind !== 'overload' && !members.has('ID')) { report('MDF_BUS_LAYOUT', 'warning', `Channel group ${name} has no ID channel and was not imported.`, cg.address); return undefined; }
  const bytes = members.get('DataBytes');
  const payload: VlsdSource | undefined = bytes?.type === CN_VLSD && bytes.dataLink ? { kind: 'signal', address: bytes.dataLink } : undefined;
  if (bytes?.type === CN_VLSD && !bytes.dataLink) throw new Error(`MDF DataBytes of ${name} has no data.`);
  const fields = Object.fromEntries((['ID', 'IDE', 'DLC', 'EDL', 'BusChannel', 'Dir', 'DataLength', 'DataBytes'] as const).map((key) => [key, members.get(key)])) as BusGroup['fields'];
  return { kind, name, time, members, fields, ...(frame ? { frame } : {}), ...(payload ? { payload } : {}) };
}

const NUMERIC_TYPES: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5]);

/** The numeric channels of a measured-signal group; channels SigMixa cannot show are reported once for the group. */
function signalGroup(reader: MdfReader, cg: MdfBlock, name: string, report: Report): SignalGroup | undefined {
  let time: Channel | undefined;
  const channels: { channel: Channel; unit?: string; labels?: ValueLabels; parent?: MdfSignalSeries['parent']; column: SampleColumn }[] = [];
  const unsupported: string[] = [];
  const recordBytes = reader.body(cg).readUInt32LE(24);
  const add = (cn: MdfBlock, channel: Channel, parent?: MdfSignalSeries['parent']) => {
    const floating = channel.dataType === 4 || channel.dataType === 5;
    // A value must lie inside the record (an array element past its end is a malformed layout).
    if (channel.type === 0 && (channel.byteOffset < 0 || channel.byteOffset + Math.ceil((channel.bitOffset + channel.bitCount) / 8) > recordBytes)) { unsupported.push(channel.name); return; }
    // A virtual channel holds no bits: its value is the record number, converted.
    const readable = channel.type === CN_VIRTUAL ? channel.convertible : channel.type === 0 && NUMERIC_TYPES.has(channel.dataType)
      && channel.bitCount > 0 && channel.bitCount <= 64 && (!floating || channel.bitCount === 32 || channel.bitCount === 64) && channel.convertible;
    if (!readable) { unsupported.push(channel.name); return; }
    if (channels.length >= MAX_SIGNALS) throw new Error(`MDF channel group ${name} has more than ${MAX_SIGNALS} values.`);
    const labels = readLabels(reader, cn.links[4] ?? 0, floating);
    // The conversion's unit is the physical value's: a text conversion has none of its own.
    const unit = unitText(reader, cn.links[6] ?? 0) || (labels ? '' : unitText(reader, cn.links[4] ? reader.block(cn.links[4]).links[1] ?? 0 : 0));
    channels.push({ channel, ...(unit ? { unit } : {}), ...(labels ? { labels } : {}), ...(parent ? { parent } : {}), column: new SampleColumn() });
  };
  // A structure's members are channels of their own; an array's elements are too, named by their indexes.
  const seen = new Set<number>();
  const visit = (address: number, depth: number, structure?: string) => {
    for (let count = 0; address; count++) {
      if (count > 65_536 || depth > 64) throw new Error('MDF channel list is too long or too deep.');
      // A channel listed twice (a list that runs back on itself) would be read again and again.
      if (seen.has(address)) throw new Error('Cyclic MDF channel list.');
      seen.add(address);
      const cn = reader.block(address, '##CN'); const channel = readChannel(reader, cn);
      address = cn.links[0];
      if ((channel.type === CN_MASTER || channel.type === CN_VIRTUAL_MASTER) && channel.syncType === SYNC_TIME) { if (!depth) time = channel; continue; }
      if (channel.type === CN_MASTER || channel.type === CN_VIRTUAL_MASTER) continue;
      const composition = cn.links[1] ? reader.block(cn.links[1]) : undefined;
      // Members of a structure are listed under it by their own names (`X` of `Pos.X`).
      const member = structure ? { name: structure, label: structure, member: channel.name.startsWith(`${structure}.`) ? channel.name.slice(structure.length + 1) : channel.name } : undefined;
      if (composition?.type === '##CN') visit(composition.address, depth + 1, channel.name);
      else if (composition?.type === '##CA') {
        const elements = arrayElements(reader, composition, channel, cg.address);
        // Elements are listed under their array, named by their indexes, with its shape: `Map [2×2]`.
        const shape = elements && elements.length ? elements[elements.length - 1].name.slice(channel.name.length).match(/\d+/g)!.map((last) => Number(last) + 1).join('×') : '';
        if (elements) for (const element of elements) add(cn, element, { name: channel.name, label: `${channel.name} [${shape}]`, member: element.name.slice(channel.name.length) });
        else unsupported.push(channel.name);
      } else if (composition) unsupported.push(channel.name);
      else add(cn, channel, member);
    }
  };
  visit(cg.links[1], 0);
  // MDF 4.2: a group may take its time from another group's record of the same number (cg_cg_master).
  const remote = !time && cg.links[6] ? cg.links[6] : undefined;
  if (time && !time.convertible) { report('MDF_CONVERSION_UNSUPPORTED', 'warning', `Channel group ${name} was not imported: the conversion of its time channel ${time.name} is a formula SigMixa cannot read.`, cg.address); return undefined; }
  if (!time && !remote) { report('MDF_NO_TIME', 'warning', `Channel group ${name} has no time channel; its signals were not imported.`, cg.address); return undefined; }
  if (unsupported.length) report('MDF_CHANNEL_UNSUPPORTED', 'info', `${unsupported.length} channel(s) of ${name} hold text, byte arrays or variable-length values, which are not numbers, and were not imported: ${unsupported.slice(0, 5).join(', ')}${unsupported.length > 5 ? ', …' : ''}`, cg.address, { channelGroup: name, channels: unsupported.length });
  // A group with a time but no values is still read: another group may take its time from it.
  if (!channels.length && !time) return undefined;
  return { name, ...(time ? { time } : { master: remote! }), channels };
}

/** The elements of a fixed array (CA block with the channel as template), or undefined for arrays stored elsewhere. */
/** The element names are taken from the file's read budget, so all arrays of the file together stay within it. */
function arrayElements(reader: MdfReader, ca: MdfBlock, channel: Channel, group: number, depth = 0): Channel[] | undefined {
  const body = reader.body(ca);
  if (depth > 8) throw new Error('MDF arrays are nested too deep.');
  const storage = body[1]; const dimensions = body.readUInt16LE(2); const byteStep = body.readInt32LE(8); const bitStep = body.readUInt32LE(12);
  if (storage !== 0 || !dimensions || 16 + 8 * dimensions > body.length) return undefined;
  const sizes = Array.from({ length: dimensions }, (_, i) => Number(body.readBigUInt64LE(16 + 8 * i)));
  // Dynamic size (flag bit 0): each dimension's size is a channel, named by DG/CG/CN links after the first link; the
  // record holds room for the largest size given above.
  let sizeChannels: Channel[] | undefined;
  if (body.readUInt32LE(4) & 0x1) {
    sizeChannels = [];
    for (let d = 0; d < dimensions; d++) {
      const cnLink = ca.links[1 + 3 * d + 2]; const cgLink = ca.links[1 + 3 * d + 1];
      // Only a size in the same record can be read with each element.
      if (!cnLink || (cgLink && cgLink !== group)) return undefined;
      sizeChannels.push(readChannel(reader, reader.block(cnLink, '##CN')));
    }
  }
  const total = sizes.reduce((product, size) => product * size, 1);
  // Each element is named by all its indexes: the names together must fit in memory (a few tens of MB), whatever the dimensions.
  // Elements are apart in the record: a step of 0 would read one value as many (a malformed layout).
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_SIGNALS || (total > 1 && byteStep === 0)) return undefined;
  // Each element gets its own name: the channel's (with the indexes of arrays this one is chained under) and its indexes,
  // each up to 22 characters. Read in constant time, so even a huge name is weighed before anything is made.
  const characters = total * (channel.name.length + 22 * dimensions);
  if (!reader.budget.takeNames(characters)) return undefined;
  // Stored row by row (the last index fastest), or with the inverse layout flag (bit 6) column by column (the first fastest).
  const inverse = (body.readUInt32LE(4) & 0x40) !== 0;
  const elements = Array.from({ length: total }, (_, linear): Channel => {
    const indexes: number[] = new Array(dimensions); let rest = linear;
    if (inverse) for (let d = 0; d < dimensions; d++) { indexes[d] = rest % sizes[d]; rest = Math.floor(rest / sizes[d]); }
    else for (let d = dimensions - 1; d >= 0; d--) { indexes[d] = rest % sizes[d]; rest = Math.floor(rest / sizes[d]); }
    // An element of a nested array keeps the outer array's size condition too.
    const dynamic = sizeChannels ? { indexes: [...channel.dynamic?.indexes ?? [], ...indexes], sizes: [...channel.dynamic?.sizes ?? [], ...sizeChannels] } : channel.dynamic;
    return { ...channel, name: `${channel.name}${indexes.map((index) => `[${index}]`).join('')}`, byteOffset: channel.byteOffset + linear * byteStep, invalidBit: channel.invalidBit + linear * bitStep, ...(dynamic ? { dynamic } : {}) };
  });
  // A CA block may name another (ca_composition): each element is then an array of its own, its indexes added after.
  const inner = ca.links[0] ? reader.block(ca.links[0]) : undefined;
  if (inner?.type !== '##CA') return elements;
  const nested: Channel[] = [];
  for (const element of elements) {
    const parts = arrayElements(reader, inner, element, group, depth + 1);
    if (!parts || nested.length + parts.length > MAX_SIGNALS) return undefined;
    nested.push(...parts);
  }
  return nested;
}

function sampleRecord(group: Group, signals: SignalGroup, record: Buffer, index: number): void {
  // A group whose time comes from another group keeps the record number for now; it becomes that record's time at the end.
  const time = signals.time ? signals.time.convert(signals.time.type === CN_VIRTUAL_MASTER ? index : readNumber(record, signals.time)) : index;
  const valid = Number.isFinite(time) && (!signals.time || isValid(signals.time, group, record));
  // Record numbers index this list: a record without a usable time keeps its place, as NaN.
  group.times?.push(valid ? time : Number.NaN, 0);
  if (!valid) return;
  // An invalid value, or one a conversion cannot give (division by zero), is kept as NaN: a break in the line.
  for (const { channel, column, labels } of signals.channels) {
    // An element past its array's size in this record holds no value.
    const present = !channel.dynamic || channel.dynamic.indexes.every((at, d) => at < channel.dynamic!.sizes[d].convert(readNumber(record, channel.dynamic!.sizes[d])));
    if (!present || !isValid(channel, group, record)) { column.push(time, NaN); continue; }
    const raw = channel.type === CN_VIRTUAL ? index : readNumber(record, channel);
    column.push(time, channel.convert(raw), labels ? labelIndex(labels, raw) : -1);
  }
}

function unitText(reader: MdfReader, address: number): string {
  if (!address) return '';
  // An MD unit is XML; its text is the unit.
  return reader.text(address).replace(/<[^>]*>/g, '').trim();
}

/** Text for values, from a value-to-text (CC 7) or value-range-to-text (CC 8) conversion; their numeric value is the raw value. */
/** Value-text tables read so far, by block: the elements of an array (and channels sharing a table) share one. */
const labelTables = new WeakMap<MdfReader, Map<string, ValueLabels | undefined>>();

function readLabels(reader: MdfReader, address: number, floating: boolean): ValueLabels | undefined {
  if (!address) return undefined;
  let cache = labelTables.get(reader); if (!cache) { cache = new Map(); labelTables.set(reader, cache); }
  const key = `${address}:${floating}`;
  if (!cache.has(key)) cache.set(key, readLabelTable(reader, address, floating));
  return cache.get(key);
}

function readLabelTable(reader: MdfReader, address: number, floating: boolean): ValueLabels | undefined {
  const cc = reader.block(address, '##CC'); const body = reader.body(cc);
  const type = body[0]; const count = body.readUInt16LE(6);
  if (type !== 7 && type !== 8) return undefined;
  const p = Array.from({ length: count }, (_, i) => body.readDoubleLE(24 + 8 * i));
  const texts = cc.links.slice(4).map((link) => link && ['##TX', '##MD'].includes(reader.block(link).type) ? reader.text(link) : undefined);
  const fallback = texts[type === 7 ? count : count >> 1];
  // A value-to-text key matches its value only.
  const ranges = type === 7 ? p.map((key, i) => [key, key, texts[i]] as const) : Array.from({ length: count >> 1 }, (_, i) => [p[2 * i], p[2 * i + 1], texts[i]] as const);
  if (!texts.some(Boolean)) return undefined;
  return { ranges, floating, ...(type === 7 ? { exact: true } : {}), ...(fallback !== undefined ? { fallback } : {}) };
}

function readChannel(reader: MdfReader, cn: MdfBlock): Channel {
  const body = reader.body(cn);
  const convert = readConversion(reader, cn.links[4] ?? 0, body[2] === 4 || body[2] === 5);
  return {
    name: reader.text(cn.links[2]), type: body[0], syncType: body[1], dataType: body[2], bitOffset: body[3],
    byteOffset: body.readUInt32LE(4), bitCount: body.readUInt32LE(8), flags: body.readUInt32LE(12), invalidBit: body.readUInt32LE(16),
    dataLink: cn.links[5] ?? 0, convert: convert ?? ((raw) => raw), convertible: convert !== undefined,
  };
}

/** Conversions read so far, by block and number kind: a block named many times (also inside tables) is read once. */
const conversions = new WeakMap<MdfReader, Map<string, Conversion | undefined>>();

function readConversion(reader: MdfReader, address: number, floating: boolean, depth = 0): Conversion | undefined {
  if (!address) return (raw) => raw;
  let cache = conversions.get(reader); if (!cache) { cache = new Map(); conversions.set(reader, cache); }
  const key = `${address}:${floating}`;
  if (cache.has(key)) return cache.get(key);
  const conversion = readConversionBlock(reader, address, floating, depth);
  cache.set(key, conversion);
  return conversion;
}

function readConversionBlock(reader: MdfReader, address: number, floating: boolean, depth: number): Conversion | undefined {
  const identity: Conversion = (raw) => raw;
  if (depth > 8) throw new Error('MDF conversions are nested too deep.');
  const cc = reader.block(address, '##CC'); const body = reader.body(cc);
  const type = body[0]; const count = body.readUInt16LE(6);
  if (24 + 8 * count > body.length) throw new Error(`Invalid MDF conversion at ${address}.`);
  const p = Array.from({ length: count }, (_, i) => body.readDoubleLE(24 + 8 * i));
  if (type === 1 && count >= 2) return (raw) => p[0] + p[1] * raw;
  if (type === 3) return algebraic(reader.text(cc.links[4] ?? 0));
  // Value (7) or value range (8) to text: an entry may name a numeric conversion (a CC block) instead of a text; such
  // values are converted by it (as asammdf does), the others keep their raw value and get the text as a label.
  if ((type === 7 || type === 8) && cc.links.length > 4) {
    const refs = cc.links.slice(4).map((link) => link && reader.block(link).type === '##CC' ? readConversion(reader, link, floating, depth + 1) ?? null : undefined);
    if (refs.includes(null)) return undefined;
    if (refs.every((ref) => ref === undefined)) return identity;
    const keys = type === 7 ? p.map((key) => [key, key] as const) : Array.from({ length: count >> 1 }, (_, i) => [p[2 * i], p[2 * i + 1]] as const);
    const fallback = refs[keys.length];
    return (raw) => {
      const hit = keys.findIndex(([min, max]) => type === 7 ? raw === min : raw >= min && (floating ? raw < max : raw <= max));
      const ref = hit >= 0 ? refs[hit] : fallback;
      return ref ? ref(raw) : raw;
    };
  }
  if (type === 2 && count >= 6) return (raw) => (p[0] * raw * raw + p[1] * raw + p[2]) / (p[3] * raw * raw + p[4] * raw + p[5]);
  if ((type === 4 || type === 5) && count >= 2) {
    const keys = Array.from({ length: count >> 1 }, (_, i) => p[2 * i]); const values = Array.from({ length: count >> 1 }, (_, i) => p[2 * i + 1]);
    return (raw) => {
      if (raw <= keys[0]) return values[0];
      const last = keys.length - 1;
      if (raw >= keys[last]) return values[last];
      let i = 1; while (keys[i] < raw) i++;
      if (keys[i] === raw) return values[i];
      // Between two keys: interpolated (4), or the nearer key's value, the lower one when halfway (5).
      if (type === 4) return values[i - 1] + (values[i] - values[i - 1]) * (raw - keys[i - 1]) / (keys[i] - keys[i - 1]);
      return raw - keys[i - 1] <= keys[i] - raw ? values[i - 1] : values[i];
    };
  }
  // Value range to value: [min, max, value] triples, then the default.
  if (type === 6 && count >= 1 && count % 3 === 1) {
    const ranges = Array.from({ length: (count - 1) / 3 }, (_, i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    // Integer values match up to and including max; floating-point ones up to max only.
    return (raw) => ranges.find(([min, max]) => raw >= min && (floating ? raw < max : raw <= max))?.[2] ?? p[count - 1];
  }
  return identity;
}

/** An algebraic conversion (CC type 3) in X: numbers, + - * / ^ and parentheses. Undefined for anything else. */
export function algebraic(formula: string): Conversion | undefined {
  const tokens = formula.match(/\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[xX]|\*\*|[-+*/^()]|\S/g) ?? [];
  type Node = (x: number) => number;
  let at = 0;
  const peek = () => tokens[at];
  const sum = (): Node | undefined => {
    let left = product();
    while (left && (peek() === '+' || peek() === '-')) { const op = tokens[at++]; const right = product(); if (!right) return undefined; const l = left; left = op === '+' ? (x) => l(x) + right(x) : (x) => l(x) - right(x); }
    return left;
  };
  const product = (): Node | undefined => {
    let left = unary();
    while (left && (peek() === '*' || peek() === '/')) { const op = tokens[at++]; const right = unary(); if (!right) return undefined; const l = left; left = op === '*' ? (x) => l(x) * right(x) : (x) => l(x) / right(x); }
    return left;
  };
  // As in mathematics: -3^2 is -9, and 2^3^2 is 2^9.
  const unary = (): Node | undefined => {
    if (peek() === '-') { at++; const value = unary(); return value && ((x) => -value(x)); }
    if (peek() === '+') { at++; return unary(); }
    return power();
  };
  const power = (): Node | undefined => {
    const base = primary();
    if (base && (peek() === '^' || peek() === '**')) { at++; const exponent = unary(); if (!exponent) return undefined; return (x) => base(x) ** exponent(x); }
    return base;
  };
  const primary = (): Node | undefined => {
    const token = tokens[at++];
    if (token === undefined) return undefined;
    if (token === 'x' || token === 'X') return (x) => x;
    if (token === '(') { const inner = sum(); if (!inner || tokens[at++] !== ')') return undefined; return inner; }
    const value = Number(token);
    return Number.isFinite(value) ? () => value : undefined;
  };
  const result = sum();
  return result && at === tokens.length ? result : undefined;
}

interface VlsdStream { offset: number; readonly records: Map<number, Uint8Array> }
/** A frame read from its record; `need`: its data bytes are in a VLSD record that may come after it. */
interface Pending { frame: FrameFields; readonly lane: number; readonly length: number; readonly need?: { readonly stream: VlsdStream; readonly offset: number } }

/** Reads one data group's records, in order, as bus frames (and reports error and overload frames). */
async function* readDataGroup(reader: MdfReader, dg: MdfBlock, groups: readonly Group[], report: Report, consumed: (bytes: number) => void): AsyncGenerator<FrameFields[]> {
  const idSize = reader.body(dg)[0];
  if (![0, 1, 2, 4, 8].includes(idSize)) throw new Error(`MDF record ID size ${idSize} is not valid.`);
  if (!idSize && groups.length !== 1) throw new Error('A sorted MDF data group has more than one channel group.');
  const byId = new Map(groups.map((group) => [group.recordId, group]));
  // VLSD payloads by their place in their group's stream, until the frame that refers to them is read.
  const vlsd = new Map<number, VlsdStream>();
  for (const group of groups) if (group.bus?.payload?.kind === 'group') vlsd.set(group.bus.payload.group, { offset: 0, records: new Map() });
  const signals = new Map<number, SignalData>();
  // Frames are given out in record order; one whose payload is still to come holds back those after it.
  const waiting: Pending[] = []; let head = 0; let missing = 0;
  let out: FrameFields[] = [];
  const order = new TimeOrder(groups.filter((group) => group.bus?.kind === 'data' || group.bus?.kind === 'remote').map((group) => group.recordId));
  function ready(final: boolean): void {
    while (head < waiting.length) {
      const item = waiting[head];
      if (item.need) {
        const { stream, offset } = item.need;
        const bytes = stream.records.get(offset);
        if (!bytes) {
          // Written past it without it (or the data ended): it never comes.
          if (stream.offset > offset || final) { missing++; head++; continue; }
          break;
        }
        item.frame = withData(item.frame, bytes, item.length);
      }
      head++;
      order.push(item.frame, item.lane);
    }
    if (head >= 4096 && head * 2 >= waiting.length) { waiting.splice(0, head); head = 0; }
    if (waiting.length - head > 1_000_000) throw new Error('Too many MDF frames wait for VLSD data that has not been written.');
  }
  const data = reader.data(dg.links[2]);
  // A record that continues in the next pieces is gathered until it is whole (`need`: bytes from its start).
  const carry = new ByteGather();
  try {
    for await (const chunk of data) {
      consumed(chunk.length);
      const buffer = carry.add(chunk);
      if (!buffer) { if (carry.length > 64 << 20) throw new Error('An MDF record is larger than 64 MiB.'); continue; }
      let at = 0; let need = idSize;
      for (;;) {
        need = idSize;
        if (at + idSize > buffer.length) break;
        const id = idSize ? readRecordId(buffer, at, idSize) : groups[0].recordId;
        const group = byId.get(id);
        if (!group) {
          // Unfinalized files end in the space the writer had reserved; anything else is a broken record.
          if (!(reader.unfinished && buffer.subarray(at).every((byte) => byte === 0))) report('MDF_RECORD_ID', 'error', `Unknown MDF record ID ${id}; the rest of this data group was not read.`, undefined, { recordId: id });
          ready(true); order.release(true, out); yield out;
          return;
        }
        let size: number;
        if (group.vlsd) {
          need = idSize + 4;
          if (at + idSize + 4 > buffer.length) break;
          size = 4 + buffer.readUInt32LE(at + idSize);
        } else size = group.recordBytes;
        if (!idSize && !size) throw new Error(`MDF channel group ${group.name || group.recordId} has records of 0 bytes.`);
        need = idSize + size;
        if (at + idSize + size > buffer.length) break;
        const record = buffer.subarray(at + idSize, at + idSize + size);
        at += idSize + size;
        if (group.vlsd) {
          const stream = vlsd.get(group.recordId);
          if (stream) {
            // A CAN payload is at most 64 bytes: no more than that is kept of a value. The latest VLSD_WINDOW values are
            // kept, so frames may refer to a value more than once or out of order (as they do near each other).
            stream.records.set(stream.offset, Uint8Array.from(record.subarray(4, 4 + Math.min(size - 4, 64))));
            if (stream.records.size > VLSD_WINDOW) stream.records.delete(stream.records.keys().next().value!);
            stream.offset += size;
            if (head < waiting.length) { ready(false); order.release(false, out); }
          }
          continue;
        }
        const index = group.cycle++;
        if (group.signals) { sampleRecord(group, group.signals, record, index); continue; }
        const bus = group.bus;
        if (!bus) continue;
        // Another group takes its time from these records (MDF 4.2): each record's time, by its number.
        if (group.times) { const time = bus.time.convert(bus.time.type === CN_VIRTUAL_MASTER ? index : readNumber(record, bus.time)); group.times.push(isValid(bus.time, group, record) ? time : Number.NaN, 0); }
        let read = busFrame(reader, group, bus, record, index, vlsd, signals, report);
        // Only a payload in signal data blocks is waited for: the rest is read at once.
        if (read instanceof Promise) read = await read;
        const item = read;
        if (item === null) missing++;
        else if (item) {
          if (!item.need && head === waiting.length) order.push(item.frame, item.lane);
          else { waiting.push(item); ready(false); }
          order.release(false, out);
        }
      }
      if (out.length) { yield out; out = []; }
      carry.keep(buffer.subarray(at), need);
      if (carry.length > 64 << 20) throw new Error('An MDF record is larger than 64 MiB.');
    }
    if (reader.budget.cancelled) return;
    ready(true); order.release(true, out); yield out;
    if (order.late) report('MDF_TIME_ORDER', 'info', `${order.late} frame(s) were written more than ${LOOKAHEAD} frames after later ones and stay out of time order.`, dg.address, { frames: order.late });
    const rest = carry.take();
    if (rest.length && !(reader.unfinished && rest.every((byte) => byte === 0))) report('MDF_RECORD_TRUNCATED', reader.unfinished ? 'info' : 'warning', 'The last record of an MDF data group is incomplete and was not imported.', undefined, { remainingBytes: rest.length });
  } finally {
    if (missing) report('MDF_PAYLOAD_MISSING', 'warning', `The data bytes of ${missing} CAN frame(s) could not be found; those frames were not imported.`, dg.address, { frames: missing });
    for (const source of signals.values()) await source.close();
  }
}

function readRecordId(buffer: Buffer, at: number, size: number): number {
  if (size === 1) return buffer[at];
  if (size === 2) return buffer.readUInt16LE(at);
  if (size === 4) return buffer.readUInt32LE(at);
  // Larger than any channel group's ID (those are checked when read), so it is reported as unknown.
  const id = buffer.readBigUInt64LE(at);
  return id > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(id);
}

/** The frame in `record`: undefined when it is not imported, null when its data bytes cannot be found. */
function busFrame(reader: MdfReader, group: Group, bus: BusGroup, record: Buffer, index: number, vlsd: Map<number, VlsdStream>, signals: Map<number, SignalData>, report: Report): Pending | undefined | null | Promise<Pending | null> {
  const { ID, IDE, DLC, EDL, BusChannel, Dir, DataLength, DataBytes } = bus.fields;
  const value = (channel: Channel | undefined): number | undefined => {
    if (!channel || !isValid(channel, group, record)) return undefined;
    return channel.convert(channel.type === CN_VIRTUAL ? index : readNumber(record, channel));
  };
  const timestamp = bus.time.convert(bus.time.type === CN_VIRTUAL_MASTER ? index : readNumber(record, bus.time));
  if (bus.frame && !isValid(bus.frame, group, record)) return undefined;
  // A frame whose time the logger marked invalid (or that converts to no number) has no place in time: it is reported, not imported.
  if (!Number.isFinite(timestamp) || !isValid(bus.time, group, record)) {
    report('MDF_TIME_INVALID', 'warning', 'A CAN frame has no valid time and was not imported.', undefined, { channelGroup: bus.name, record: index });
    return undefined;
  }
  if (bus.kind === 'error' || bus.kind === 'overload') {
    report(bus.kind === 'error' ? 'MDF_ERROR_FRAME' : 'MDF_OVERLOAD_FRAME', 'warning', `CAN ${bus.kind} frame was not imported.`, undefined, { channelGroup: bus.name, timestamp });
    return undefined;
  }
  const rawId = value(ID);
  if (rawId === undefined) return undefined;
  const extended = (value(IDE) ?? 0) !== 0 || rawId >= 0x80000000;
  const canId = rawId % 0x80000000;
  if (canId > (extended ? 0x1fffffff : 0x7ff)) { report('MDF_CAN_ID', 'warning', `CAN ID ${canId} is outside its range and the frame was not imported.`, undefined, { channelGroup: bus.name, timestamp }); return undefined; }
  const dlcCode = Math.min(15, Math.max(0, Math.trunc(value(DLC) ?? 0)));
  const fd = (value(EDL) ?? 0) !== 0;
  const channel = Math.max(0, Math.trunc(value(BusChannel) ?? 1));
  const direction = (value(Dir) ?? 0) !== 0 ? 'Tx' : 'Rx';
  const frame: FrameFields = { timestamp, canId, extended, direction, channel, dlcCode, dataLength: 0, data: new Uint8Array(0) };
  const lane = group.recordId;
  if (bus.kind !== 'data') return { frame, lane, length: 0 };
  const declared = value(DataLength);
  const length = Math.min(64, Math.max(0, Math.trunc(declared ?? (fd ? FD_LENGTHS[dlcCode] : Math.min(dlcCode, 8)))));
  const bytes = DataBytes;
  if (!bytes || !isValid(bytes, group, record)) return { frame: withData(frame, new Uint8Array(0), length), lane, length };
  if (bytes.type !== CN_VLSD) {
    const start = bytes.byteOffset; const end = start + Math.ceil((bytes.bitOffset + bytes.bitCount) / 8);
    return end <= group.dataBytes ? { frame: withData(frame, record.subarray(start, end), length), lane, length } : null;
  }
  const offset = readNumber(record, { ...bytes, dataType: 0 });
  const source = bus.payload!;
  if (source.kind === 'group') return { frame, lane, length, need: { stream: vlsd.get(source.group)!, offset } };
  let data = signals.get(source.address);
  if (!data) { data = new SignalData(reader, source.address); signals.set(source.address, data); }
  return data.at(offset).then((found) => found ? { frame: withData(frame, found, length), lane, length } : null);
}

/**
 * Puts an unsorted data group's frames in time order. Writers such as CANedge keep each channel group (bus, frame type)
 * in order but write the groups a little apart (under a second); a frame is given out once every group has reached its
 * time. A group that is rare or never written would hold everything back, so at most LOOKAHEAD frames wait.
 */
class TimeOrder {
  private readonly heap: { readonly frame: FrameFields; readonly order: number }[] = [];
  private readonly lanes: Map<number, number>;
  private count = 0;
  private last = -Infinity;
  /** Frames given out after a later one (their group lagged more than LOOKAHEAD frames). */
  late = 0;
  constructor(lanes: readonly number[]) { this.lanes = new Map(lanes.map((lane) => [lane, -Infinity])); }
  push(frame: FrameFields, lane: number): void {
    this.lanes.set(lane, frame.timestamp);
    const heap = this.heap; const item = { frame, order: this.count++ };
    let i = heap.push(item) - 1;
    while (i > 0) { const parent = (i - 1) >> 1; if (!this.before(item, heap[parent])) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = item;
  }
  release(all: boolean, out: FrameFields[]): void {
    let mark = Infinity;
    if (!all) for (const time of this.lanes.values()) if (time < mark) mark = time;
    while (this.heap.length && (all || this.heap.length > LOOKAHEAD || this.heap[0].frame.timestamp <= mark)) {
      const frame = this.pop();
      if (frame.timestamp < this.last) this.late++; else this.last = frame.timestamp;
      out.push(frame);
    }
  }
  private pop(): FrameFields {
    const heap = this.heap; const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1; if (left >= heap.length) break;
        const child = left + 1 < heap.length && this.before(heap[left + 1], heap[left]) ? left + 1 : left;
        if (!this.before(heap[child], last)) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return top.frame;
  }
  private before(a: { readonly frame: FrameFields; readonly order: number }, b: { readonly frame: FrameFields; readonly order: number }): boolean {
    return a.frame.timestamp < b.frame.timestamp || (a.frame.timestamp === b.frame.timestamp && a.order < b.order);
  }
}

/** `length` bytes of `bytes`, zero-filled when fewer were recorded. */
function withData(frame: FrameFields, bytes: Uint8Array, length: number): FrameFields {
  const data = new Uint8Array(length);
  data.set(bytes.subarray(0, length));
  return { ...frame, dataLength: length, data };
}

/** Signal data (SD, or a list of them) read forward as frames refer to it: offsets mostly ascend, so it is read once. */
class SignalData {
  private iterator: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private start = 0;
  constructor(private readonly reader: MdfReader, private readonly address: number) { this.iterator = reader.data(address)[Symbol.asyncIterator](); }
  async at(offset: number): Promise<Uint8Array | undefined> {
    if (offset < this.start) { await this.close(); this.iterator = this.reader.data(this.address)[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.start = 0; }
    // Later offsets are at or after this one: what comes before it is let go.
    const drop = Math.min(offset - this.start, this.buffer.length); this.buffer = this.buffer.subarray(drop); this.start += drop;
    if (!(await this.fill(offset, offset + 4))) return undefined;
    const length = this.buffer.readUInt32LE(0);
    if (length > MAX_PAYLOAD || !(await this.fill(offset, offset + 4 + length))) return undefined;
    return Uint8Array.from(this.buffer.subarray(4, 4 + length));
  }
  /** Reads on until `end`, keeping nothing before `from`. */
  private async fill(from: number, end: number): Promise<boolean> {
    while (this.start + this.buffer.length < end) {
      const next = await this.iterator.next();
      if (next.done) return false;
      const chunkStart = this.start + this.buffer.length; const chunk = next.value;
      if (chunkStart + chunk.length <= from) { this.start = chunkStart + chunk.length; this.buffer = Buffer.alloc(0); continue; }
      if (chunkStart <= from) { this.buffer = chunk.subarray(from - chunkStart); this.start = from; }
      else this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    return true;
  }
  async close(): Promise<void> { await this.iterator.return?.(); }
}

function isValid(channel: Channel, group: Group, record: Buffer): boolean {
  if (channel.flags & CN_ALL_INVALID) return false;
  if (!(channel.flags & CN_INVALID_BIT) || !group.invalidBytes) return true;
  const at = group.dataBytes + (channel.invalidBit >> 3);
  return at >= record.length || (record[at] & (1 << (channel.invalidBit & 7))) === 0;
}

/** A fixed-length value from a record: integers to 64 bits (exact to 2^53), and 32/64-bit floats. */
export function readNumber(record: Buffer, channel: Pick<Channel, 'dataType' | 'byteOffset' | 'bitOffset' | 'bitCount'>): number {
  const { dataType, byteOffset, bitOffset, bitCount } = channel;
  if (dataType === 4 || dataType === 5) {
    if (byteOffset + bitCount / 8 > record.length) return NaN;
    if (bitCount === 64) return dataType === 4 ? record.readDoubleLE(byteOffset) : record.readDoubleBE(byteOffset);
    if (bitCount === 32) return dataType === 4 ? record.readFloatLE(byteOffset) : record.readFloatBE(byteOffset);
    return NaN;
  }
  if (dataType > 3 && dataType !== BYTE_ARRAY) return NaN;
  // Whole little-endian unsigned bytes, the usual case, read directly.
  if (!bitOffset && (dataType === 0 || dataType === BYTE_ARRAY) && byteOffset + (bitCount >> 3) <= record.length) {
    if (bitCount === 8) return record[byteOffset];
    if (bitCount === 16) return record.readUInt16LE(byteOffset);
    if (bitCount === 32) return record.readUInt32LE(byteOffset);
    // Exact to 2^53, as the general path.
    if (bitCount === 64) return record.readUInt32LE(byteOffset + 4) * 4294967296 + record.readUInt32LE(byteOffset);
  }
  const bytes = Math.ceil((bitOffset + bitCount) / 8);
  if (!bitCount || bitCount > 64 || byteOffset + bytes > record.length) return NaN;
  const bigEndian = dataType === 1 || dataType === 3;
  const signed = dataType === 2 || dataType === 3;
  // Up to 31 bits in up to 4 bytes: 32-bit integer arithmetic.
  if (bytes <= 4 && bitOffset + bitCount <= 32 && bitCount < 32) {
    let word = 0;
    for (let i = 0; i < bytes; i++) word |= record[byteOffset + (bigEndian ? i : bytes - 1 - i)] << (8 * (bytes - 1 - i));
    const value = ((word >>> 0) >>> bitOffset) & ((1 << bitCount) - 1) >>> 0;
    return signed && value >= 2 ** (bitCount - 1) ? value - 2 ** bitCount : value;
  }
  if (bytes <= 6) {
    let value = 0;
    for (let i = 0; i < bytes; i++) value = value * 256 + record[byteOffset + (bigEndian ? i : bytes - 1 - i)];
    value = Math.floor(value / 2 ** bitOffset) % 2 ** bitCount;
    return signed && value >= 2 ** (bitCount - 1) ? value - 2 ** bitCount : value;
  }
  let raw = 0n;
  for (let i = 0; i < bytes; i++) raw = (raw << 8n) | BigInt(record[byteOffset + (bigEndian ? i : bytes - 1 - i)]);
  raw = (raw >> BigInt(bitOffset)) & ((1n << BigInt(bitCount)) - 1n);
  if (signed && raw >> BigInt(bitCount - 1)) raw -= 1n << BigInt(bitCount);
  return Number(raw);
}

function summary(totalBytes: number, bytesRead: number, framesParsed: number, diagnostics: number, cancelled: boolean, timeReference?: TimeReference): MdfParseSummary {
  return { totalBytes, bytesRead, linesRead: 0, framesParsed, diagnostics, cancelled, ...(timeReference ? { timeReference } : {}) };
}
