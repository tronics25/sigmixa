import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import type { CanFrame } from '../src/core/frame/canFrame';
import type { Diagnostic } from '../src/core/diagnostics/diagnostic';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';
import { parseBlfFile } from '../src/parsers/blf/parseBlf';
import { canLoadInParallel, loadAscInParallel, loadBlfInParallel, parallelLoadSettings, type ParallelLoadOptions } from '../src/parsers/parallel/parallelLoad';
import { unpackFrame } from '../src/parsers/parallel/packedFrames';
import { RawLogDocument } from '../src/extension/editors/rawLogDocument';
import { PluginRegistry } from '../src/core/plugin/pluginHost';
import { parseProjectJson, type SigMixaProject } from '../src/core/project/schema';

// Pieces of a few kilobytes, so even small logs are read as many pieces on the workers.
const settings = { ...parallelLoadSettings };
const small = () => Object.assign(parallelLoadSettings, { minBytes: 0, ascRangeBytes: 3000, blfRangeBytes: 700, workers: 3, workerScript: path.join(__dirname, 'logWorker.js') });
const restore = () => Object.assign(parallelLoadSettings, settings);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-parallel-'));
test.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

/** What a parser gives: frames, diagnostics, the time reference and its summary. */
async function sequential(file: string) {
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = []; let reference: unknown;
  const options = { sourceId: 'file:///log', onFrames: (items: readonly CanFrame[]) => { frames.push(...items.map((frame) => ({ ...frame, data: Uint8Array.from(frame.data) }))); }, onDiagnostics: (items: readonly Diagnostic[]) => { diagnostics.push(...items); }, onTimeReference: (value: unknown) => { reference = value; } };
  const summary = file.endsWith('.blf') ? await parseBlfFile(file, options) : await parseAscFile(file, options);
  return { frames, diagnostics, reference, summary };
}

async function parallel(file: string) {
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = []; let reference: unknown;
  const options: ParallelLoadOptions = {
    sourceId: 'file:///log', decodeSpec: () => ({ owner: settings, spec: { definitions: [], signalIds: [], pluginKeys: [] } }),
    onChunk: (chunk) => { for (let index = 0; index < chunk.frames.count; index++) { const frame = unpackFrame(chunk.frames, index); frames.push({ ...frame, data: Uint8Array.from(frame.data), id: `${chunk.idPrefix}${chunk.firstSequence + index}`, sourceId: 'file:///log' }); } },
    onDiagnostics: (items) => { diagnostics.push(...items); }, onTimeReference: (value) => { reference = value; },
  };
  const summary = file.endsWith('.blf') ? await loadBlfInParallel(file, options) : await loadAscInParallel(file, options);
  return { frames, diagnostics, reference, summary };
}

async function assertSameReading(file: string): Promise<number> {
  const expected = await sequential(file);
  small(); const actual = await parallel(file); restore();
  assert.equal(actual.frames.length, expected.frames.length, `${file}: frames`);
  assert.deepEqual(actual.frames, expected.frames, `${file}: frames`);
  assert.deepEqual(actual.diagnostics, expected.diagnostics, `${file}: diagnostics`);
  assert.deepEqual(actual.reference, expected.reference, `${file}: time reference`);
  assert.deepEqual(actual.summary, expected.summary, `${file}: summary`);
  return expected.frames.length;
}

function write(name: string, content: string | Buffer): string { const file = path.join(root, name); fs.writeFileSync(file, content); return file; }

const asc = fs.readFileSync('sample/sigmixa-basic.asc', 'utf8');

test('ASC logs read in pieces on workers give the same frames, diagnostics and summary as read in one go', async () => {
  assert.ok(await assertSameReading(path.resolve('sample/sigmixa-basic.asc')) > 3000);
  const lines = asc.split('\n');
  // A base change in the middle, unreadable rows, CRLF and lone CR endings, a long line, and a last line without a break.
  const at = Math.floor(lines.length / 2);
  const mixed = [...lines.slice(0, at), 'base dec  timestamps absolute', '   30.100000 1  291             Rx   d 2 01 02', 'this row is not CAN', ...lines.slice(at, at + 200), 'base hex  timestamps absolute', ...lines.slice(at + 200)];
  write('mixed.asc', mixed.join('\n').replace(/\n(?=   4)/g, '\r\n') + '\n// ' + 'x'.repeat(9000) + '\r   99.5 1 123 Rx d 1 05');
  assert.ok(await assertSameReading(path.join(root, 'mixed.asc')) > 3000);
  write('dated.asc', 'date Mon Aug 31 09:00:00.000 2026\n' + lines.filter((line) => !line.startsWith('date')).join('\n'));
  await assertSameReading(path.join(root, 'dated.asc'));
  // A log with lone \r line breaks only is read in one go (it cannot be cut at \n).
  write('cr.asc', asc.replace(/\n/g, '\r'));
  small(); assert.equal(canLoadInParallel(path.join(root, 'cr.asc')), false); assert.equal(canLoadInParallel(path.join(root, 'mixed.asc')), true); restore();
  write('empty.asc', '');
  await assertSameReading(path.join(root, 'empty.asc'));
});

const NS = 2;
function object(type: number, payload: Buffer, timestamp: bigint): Buffer {
  const size = 32 + payload.length; const padded = Buffer.alloc(Math.ceil(size / 4) * 4);
  padded.write('LOBJ'); padded.writeUInt16LE(32, 4); padded.writeUInt16LE(1, 6); padded.writeUInt32LE(size, 8); padded.writeUInt32LE(type, 12);
  padded.writeUInt32LE(NS, 16); padded.writeBigUInt64LE(timestamp, 24); payload.copy(padded, 32); return padded;
}
function classic(channel: number, id: number, data: number[]): Buffer {
  const payload = Buffer.alloc(16); payload.writeUInt16LE(channel, 0); payload.writeUInt8(data.length, 3); payload.writeUInt32LE(id >>> 0, 4); Buffer.from(data).copy(payload, 8); return payload;
}
function fd(channel: number, id: number, data: number[]): Buffer {
  const payload = Buffer.alloc(84); payload.writeUInt16LE(channel, 0); payload.writeUInt8(1, 2); payload.writeUInt8(9, 3); payload.writeUInt32LE(id >>> 0, 4); payload.writeUInt8(data.length, 14); Buffer.from(data).copy(payload, 20); return payload;
}
/** A BLF file whose object stream is cut into containers of the given sizes, so objects run across containers. */
function blf(stream: Buffer, sizes: (index: number) => number, options: { method?: (index: number) => number; dated?: boolean; trailing?: Buffer } = {}): Buffer {
  const header = Buffer.alloc(144); header.write('LOGG'); header.writeUInt32LE(144, 4);
  if (options.dated) { header.writeUInt16LE(2026, 40); header.writeUInt16LE(9, 42); header.writeUInt16LE(1, 46); header.writeUInt16LE(8, 48); }
  const containers: Buffer[] = [];
  for (let offset = 0, index = 0; offset < stream.length; index++) {
    const content = stream.subarray(offset, offset + sizes(index)); offset += content.length;
    const method = options.method?.(index) ?? 2; const payload = method === 2 ? zlib.deflateSync(content) : content;
    const container = Buffer.alloc(16 + payload.length); container.writeUInt16LE(method, 0); container.writeUInt32LE(content.length, 8); payload.copy(container, 16);
    const size = 16 + container.length; const result = Buffer.alloc(size + size % 4);
    result.write('LOBJ'); result.writeUInt16LE(16, 4); result.writeUInt16LE(1, 6); result.writeUInt32LE(size, 8); result.writeUInt32LE(10, 12); container.copy(result, 16);
    containers.push(result);
  }
  return Buffer.concat([header, ...containers, options.trailing ?? Buffer.alloc(0)]);
}

test('BLF logs read in pieces on workers give the same frames, diagnostics and summary, also where objects run across containers', async () => {
  for (const name of ['sample/sigmixa-basic.blf', ...fs.readdirSync('tests/fixtures/python-can').filter((item) => item.endsWith('.blf')).map((item) => `tests/fixtures/python-can/${item}`)]) await assertSameReading(path.resolve(name));
  const objects: Buffer[] = [];
  for (let index = 0; index < 3000; index++) {
    const time = BigInt(index) * 1_000_000n;
    if (index % 997 === 5) objects.push(object(2, Buffer.alloc(8), time)); // an error frame (reported)
    else if (index % 1499 === 7) objects.push(object(999, Buffer.alloc(12), time)); // not read (reported)
    else if (index % 3 === 0) objects.push(object(100, fd(1, 0x18ff0000 + (index % 5) | 0x80000000, Array.from({ length: 12 }, (_, byte) => (index + byte) & 0xff)), time));
    else objects.push(object(1, classic(1 + (index % 2), 0x100 + (index % 7), [index & 0xff, (index >> 8) & 0xff]), time));
  }
  const stream = Buffer.concat(objects);
  write('across.blf', blf(stream, (index) => 37 + (index * 131) % 900, { dated: true }));
  assert.ok(await assertSameReading(path.join(root, 'across.blf')) > 2900);
  // Some containers stored without compression; one container holding only part of one object.
  write('stored.blf', blf(stream, (index) => index === 4 ? 10 : 500 + (index % 3) * 64, { method: (index) => index % 4 === 1 ? 0 : 2 }));
  await assertSameReading(path.join(root, 'stored.blf'));
  // A last container cut inside an object, and bytes after the last object.
  write('cut.blf', blf(stream.subarray(0, stream.length - 30), () => 800, { trailing: Buffer.from([0, 0, 0, 7, 9]) }));
  await assertSameReading(path.join(root, 'cut.blf'));
  // An unsupported compression method and a broken container in the middle.
  write('odd.blf', blf(stream, () => 650, { method: (index) => index === 6 ? 7 : 2 }));
  const odd = fs.readFileSync(path.join(root, 'odd.blf')); const second = odd.indexOf('LOBJ', 200); odd.writeUInt16LE(2, second + 16); odd.fill(0x55, second + 40, second + 60);
  write('odd.blf', odd);
  await assertSameReading(path.join(root, 'odd.blf'));
  // Containers that cannot be expanded, a whole piece of them: what the container before them left goes on to the next.
  const broken = blf(stream, () => 300);
  for (let at = broken.indexOf('LOBJ', 144), index = 0; at >= 0; at = broken.indexOf('LOBJ', at + broken.readUInt32LE(at + 8)), index++) if (index >= 9 && index <= 14) broken.fill(0xaa, at + 34, at + 50);
  write('broken.blf', broken);
  await assertSameReading(path.join(root, 'broken.blf'));
  // A dated header that declares more than the file holds: the start time is still reported.
  const oversized = blf(stream.subarray(0, 4000), () => 800, { dated: true }); oversized.writeUInt32LE(oversized.length + 1, 4);
  write('oversized.blf', oversized);
  await assertSameReading(path.join(root, 'oversized.blf'));
  write('not.blf', 'not a BLF');
  await assertSameReading(path.join(root, 'not.blf'));
});

/** Everything a document shows of a log: RAW rows, diagnostics, Signals with all their samples, the Table. */
function shown(doc: RawLogDocument, project: SigMixaProject) {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += 2000) { const page = doc.query({ offset, limit: 2000 }, project, 1); rows.push(...page.rows); if (offset + 2000 >= page.total) break; }
  const store = (doc as unknown as { signalStore: import('../src/core/signal/signalStore').InMemorySignalStore }).signalStore;
  const ids = doc.signalCatalog().map((item) => item.id).sort();
  const series = ids.map((id) => store.seriesSlice([id], undefined, 1e9)[0]);
  const table = store.tablePage(ids, 0, 1e9);
  return { rows, ids, series, table, frames: doc.query({ offset: 0, limit: 1 }, project, 1).total, source: doc.sourceDiagnosticGroups, analysis: doc.analysisDiagnosticGroups, channels: doc.channelValues, reference: doc.timeReference, range: doc.timelineRange };
}

async function open(file: string, project: SigMixaProject, registry: () => PluginRegistry, inParallel: boolean) {
  if (inParallel) small(); else Object.assign(parallelLoadSettings, { minBytes: Infinity });
  const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, registry());
  try { const summary = await doc.whenReady(); return { summary, ...shown(doc, project) }; } finally { doc.dispose(); restore(); }
}

test('a log decoded on workers shows the same values, Plugin output and diagnostics as decoded in one go', async () => {
  const sample = path.resolve('sample');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(sample) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const sampleProject = parseProjectJson(fs.readFileSync(path.join(sample, '.sigmixa/project.json'), 'utf8'));
  // After the filter of 0x300, a lookup that fails for most values (derived Signals decoded here report it).
  const failing = { id: 'sig-test-strict-level', name: 'Strict Level', unit: '', operation: { type: 'lookup', input: 'Smoothed Brake Pressure', outOfRange: 'error', points: [{ input: 0, output: 0 }, { input: 5, output: 1 }] } };
  const project = { ...sampleProject, frames: sampleProject.frames.map((frame) => frame.id === 'ff-300' ? { ...frame, derivedSignals: [...frame.derivedSignals ?? [], failing] } : frame) } as SigMixaProject;
  // Plugins keep state from frame to frame, so each document gets its own instances.
  const registry = () => {
    const result = new PluginRegistry();
    for (const plugin of project.plugins) {
      const file = path.join(sample, plugin.source, 'index.js'); delete require.cache[require.resolve(file)];
      const loaded = require(file); const instance = loaded.default ?? loaded; instance.setConfig?.(plugin.config); result.register(instance, plugin.source);
    }
    return result;
  };
  // Frames shorter than their definitions (diagnostics), in the middle of the log.
  const lines = asc.split('\n'); const at = Math.floor(lines.length / 3);
  const short = write('short.asc', [...lines.slice(0, at), '   20.000100 1  2A0             Rx   d 2 01 02', '   20.000200 1  300             Rx   d 1 07', ...lines.slice(at)].join('\n'));
  for (const file of [path.resolve('sample/sigmixa-basic.asc'), path.resolve('sample/sigmixa-basic.blf'), short]) {
    const expected = await open(file, project, registry, false);
    const actual = await open(file, project, registry, true);
    assert.ok(expected.rows.length > 3000 && expected.ids.length > 40 && expected.analysis.some((group) => group.code === 'DERIVED_SIGNAL_EVALUATION_ERROR'), file);
    assert.deepEqual(actual, expected, file);
  }
});

test('definitions changed while a log is read on workers give the values of the new definitions', async () => {
  const sample = path.resolve('sample');
  const project = parseProjectJson(fs.readFileSync(path.join(sample, '.sigmixa/project.json'), 'utf8'));
  const scaled = { ...project, frames: project.frames.map((frame) => frame.id === 'ff-300' || frame.id === 'ff-310' ? { ...frame, signals: frame.signals.map((signal) => ({ ...signal, conversion: { ...signal.conversion, offset: signal.conversion.offset + 1 } })) } : frame) } as SigMixaProject;
  const withoutPlugins = { ...scaled, plugins: [], pluginBindings: [] } as SigMixaProject;
  const lines = asc.split('\n'); const file = write('long.asc', [...lines, ...lines.slice(10).map((line) => line.replace(/^(\s*)(\d+)\./, (_, space, seconds) => `${space}${Number(seconds) + 100}.`))].join('\n'));
  for (const next of [scaled, withoutPlugins]) {
    Object.assign(parallelLoadSettings, { minBytes: Infinity });
    const fresh = new RawLogDocument(vscode.Uri.file(file), file, next, 2, new PluginRegistry());
    await fresh.whenReady(); const expected = shown(fresh, next); fresh.dispose();
    small();
    const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, new PluginRegistry());
    let rebuilt: Promise<void> | undefined; let progress = 0;
    const done = new Promise<void>((resolve) => doc.onDidUpdate((update) => {
      if (update.type === 'progress' && ++progress === 1) rebuilt = doc.rebuildSignals(next, 2);
      if (update.type === 'analysisComplete') resolve();
    }));
    await doc.whenReady(); assert.ok(rebuilt, 'changed while reading'); await rebuilt; await done;
    const actual = shown(doc, next); doc.dispose(); restore();
    // How many changes the stores counted depends on when the definitions changed.
    const unversioned = (value: object) => JSON.parse(JSON.stringify(value, (key, item) => key === 'generation' ? undefined : item instanceof Map ? [...item] : item === undefined ? null : item));
    assert.deepEqual(unversioned(actual), unversioned(expected));
  }
});

test('Plugin tags spelled from the Signal store are the tags kept as given, also after rows are put in time order', async () => {
  const { InMemorySignalStore } = await import('../src/core/signal/signalStore');
  const { PluginFrameTags } = await import('../src/extension/editors/pluginFrameTags');
  const store = new InMemorySignalStore(); const kept = new PluginFrameTags(); const stored = new PluginFrameTags((frame) => store.pluginSamplesOfFrame(frame));
  const plugin = (id: string, name: string, unit?: string) => ({ id, name, unit, source: { type: 'plugin', pluginId: 'p', bindingId: 'b' } }) as never;
  const manual = { id: 'm', name: 'M', source: { type: 'manual-can', frameDefinitionId: 'd' } } as never;
  const a = plugin('a', 'Speed', 'km/h'); const b = plugin('b', 'Mode'); const renamed = plugin('a', 'Velocity', 'm/s');
  for (let frame = 0; frame < 500; frame++) {
    const time = frame % 7 === 3 ? frame - 2.5 : frame; // some rows out of time order
    // From frame 400 on, the Plugin gives Signal a another name and unit.
    const first = frame < 400 ? a : renamed;
    const outputs = frame % 5 === 0 ? [] : frame % 3 === 0 ? [{ definition: first, value: frame }, { definition: first, value: -frame }, { definition: b, value: 0.1 + frame / 10 }] : [{ definition: b, value: frame * 3 }];
    store.appendFrame(frame, time, [{ definition: manual, sample: { timestamp: time, value: 1 } }, ...outputs.map((item) => ({ definition: item.definition, sample: { timestamp: time, value: item.value } }))]);
    const decoded = outputs.map((item) => ({ id: (item.definition as { id: string }).id, name: (item.definition as { name: string }).name, unit: (item.definition as { unit?: string }).unit, value: item.value }));
    const diagnostics = frame % 11 === 0 ? [{ id: `d${frame}`, source: 'plugin', code: 'X', severity: 'warning', message: 'x' } as const] : [];
    kept.set(frame, decoded, diagnostics); stored.set(frame, decoded, diagnostics);
  }
  // A rename followed by another Signal's rename in the next frame, as Codex found (each frame keeps its own tags).
  const x = plugin('x', 'A'); const y = plugin('y', 'B'); const x2 = plugin('x', 'A2'); const y2 = plugin('y', 'B2');
  for (const [frame, outputs] of [[500, [x]], [501, [x2, y]], [502, [x, y2]]] as const) {
    store.appendFrame(frame, frame, outputs.map((definition) => ({ definition, sample: { timestamp: frame, value: frame } })));
    const decoded = outputs.map((definition) => ({ id: (definition as { id: string }).id, name: (definition as { name: string }).name, value: frame }));
    kept.set(frame, decoded, []); stored.set(frame, decoded, []);
  }
  store.finalize();
  const cells = (text: string) => text.length;
  assert.deepEqual(stored.get(502)?.tags, ['A=502', 'B2=502']);
  for (let frame = 0; frame < 504; frame++) { assert.deepEqual(stored.get(frame), kept.get(frame), `frame ${frame}`); assert.equal(stored.cells(frame, cells, 7), kept.cells(frame, cells, 7)); }
});

test('channel and direction filters made on first use find the same frames, also frames added afterwards', async () => {
  const { ChunkedFrameStore } = await import('../src/core/frame/frameStore');
  const frame = (index: number): CanFrame => ({ id: `s:${index}`, sourceId: 's', timestamp: index, canId: index % 5, extended: false, direction: index % 3 ? 'Rx' : 'Tx', channel: 1 + (index % 4 === 0 ? 300 : index % 2), dlcCode: 1, dataLength: 1, data: new Uint8Array([index & 0xff]) });
  const store = new ChunkedFrameStore(100);
  store.append(Array.from({ length: 1000 }, (_, index) => frame(index)));
  const all = (filter: object) => { const rows: string[] = []; for (let offset = 0; ; offset += 2000) { const page = store.query({ offset, limit: 2000, filter }, undefined, { wait: true }); rows.push(...page.rows.map((row) => row.id)); if (offset + 2000 >= page.total) return rows; } };
  const expected = (filter: { channel?: number; direction?: string; canIds?: number[] }, count: number) => Array.from({ length: count }, (_, index) => frame(index)).filter((item) => (filter.channel === undefined || item.channel === filter.channel) && (!filter.direction || item.direction === filter.direction) && (!filter.canIds || filter.canIds.includes(item.canId))).map((item) => item.id);
  const filters = [{ channel: 301 }, { channel: 2 }, { direction: 'Tx' }, { direction: 'Rx', channel: 1 }, { channel: 2, canIds: [3] }, { channel: 9 }];
  for (const filter of filters) assert.deepEqual(all(filter), expected(filter, 1000), JSON.stringify(filter));
  store.append(Array.from({ length: 500 }, (_, index) => frame(1000 + index)));
  for (const filter of filters) assert.deepEqual(all(filter), expected(filter, 1500), JSON.stringify(filter));
  // Frames stored from a worker's columns join the indexes too.
  const { FramePacker } = await import('../src/parsers/parallel/packedFrames');
  const packer = new FramePacker(); for (let index = 1500; index < 2000; index++) packer.push(frame(index));
  store.appendPacked(packer.finish(), 's', 's:', 1500);
  for (const filter of filters) assert.deepEqual(all(filter), expected(filter, 2000), JSON.stringify(filter));
});
