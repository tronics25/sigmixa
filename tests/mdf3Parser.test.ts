import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Diagnostic } from '../src/core/diagnostics/diagnostic';
import type { TimeReference } from '../src/core/time/timeFormat';
import { parseMdfFile, seriesLabel, type MdfSignalSeries } from '../src/parsers/mdf/parseMdf';

// ---- a small MDF 3.30 writer: blocks are laid out in the order added; links name blocks by their index + 1 ----

class Mdf3 {
  private readonly blocks: { id: string; body: Buffer; links: { at: number; to: number }[] }[] = [];
  add(id: string, body: Buffer, links: { at: number; to: number }[] = []): number { this.blocks.push({ id, body, links }); return this.blocks.length; }
  link(block: number, at: number, to: number): void { this.blocks[block - 1].links.push({ at, to }); }
  text(value: string): number { return this.add('TX', Buffer.from(`${value}\0`, 'latin1')); }
  build(): Buffer {
    const addresses: number[] = []; let at = 64;
    for (const block of this.blocks) { addresses.push(at); at += block.id === '..' ? block.body.length : 4 + block.body.length; }
    const id = Buffer.alloc(64); id.write('MDF     ', 0, 'ascii'); id.write('3.30    ', 8, 'ascii'); id.writeUInt16LE(330, 28);
    const parts = [id];
    for (const block of this.blocks) {
      const body = Buffer.from(block.body);
      // Links are 32-bit addresses written into the body (offsets counted from the block start, as in the specification).
      for (const { at: offset, to } of block.links) body.writeUInt32LE(to ? addresses[to - 1] : 0, offset - (block.id === '..' ? 0 : 4));
      if (block.id === '..') parts.push(body);
      else { const head = Buffer.alloc(4); head.write(block.id, 0, 'ascii'); head.writeUInt16LE(4 + body.length, 2); parts.push(head, body); }
    }
    return Buffer.concat(parts);
  }
}

function hd(nanoseconds: bigint, utcHours: number): Buffer {
  const body = Buffer.alloc(204);
  body.write('03:11:2026', 14, 'latin1'); body.write('12:00:00', 24, 'latin1');
  body.writeBigUInt64LE(nanoseconds, 160); body.writeInt16LE(utcHours, 168);
  return body;
}
function cn(name: string, type: 0 | 1, bit: number, bits: number, dataType: number): Buffer {
  const body = Buffer.alloc(224); body.writeUInt16LE(type, 20); body.write(name, 22, 'latin1'); body.writeUInt16LE(bit, 182); body.writeUInt16LE(bits, 184); body.writeUInt16LE(dataType, 186);
  return body;
}
function cc(type: number, unit: string, params: Buffer, count: number): Buffer {
  const body = Buffer.alloc(42 + params.length); body.write(unit, 18, 'latin1'); body.writeUInt16LE(type, 38); body.writeUInt16LE(count, 40); params.copy(body, 42);
  return body;
}
const doubles = (...values: number[]) => { const buffer = Buffer.alloc(8 * values.length); values.forEach((value, i) => buffer.writeDoubleLE(value, 8 * i)); return buffer; };

async function parse(buffer: Buffer): Promise<{ diagnostics: Diagnostic[]; reference?: TimeReference; signals: MdfSignalSeries[]; frames: number }> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sigmixa-mdf3-')), 'log.mdf'); writeFileSync(file, buffer);
  const diagnostics: Diagnostic[] = []; let reference: TimeReference | undefined; let signals: MdfSignalSeries[] = []; let frames = 0;
  await parseMdfFile(file, { sourceId: 'log.mdf', onFrames: (items) => { frames += items.length; }, onDiagnostics: (items) => diagnostics.push(...items), onTimeReference: (value) => { reference = value; }, onSignals: (items) => { signals = [...items]; } });
  return { diagnostics, reference, signals, frames };
}

test('MDF 3 measured signals: sorted and unsorted data groups, linear and text conversions, local start with its UTC offset', async () => {
  const mdf = new Mdf3();
  const header = mdf.add('HD', hd(1_700_000_000_000_000_000n, 9));
  // Group 1 (sorted): time (double), Speed (uint16, x0.1 km/h), Gear (uint8 text table), Name (string, not read).
  const speedCc = mdf.add('CC', cc(0, 'km/h', doubles(0, 0.1), 2));
  const gearTable = Buffer.alloc(80); gearTable.writeDoubleLE(0, 0); gearTable.write('P', 8, 'latin1'); gearTable.writeDoubleLE(1, 40); gearTable.write('D', 48, 'latin1');
  const gearCc = mdf.add('CC', cc(11, '', gearTable, 2));
  const time1 = mdf.add('CN', cn('time', 1, 0, 64, 3)); const speed = mdf.add('CN', cn('Speed', 0, 64, 16, 0)); const gear = mdf.add('CN', cn('Gear', 0, 80, 8, 0)); const label = mdf.add('CN', cn('Name', 0, 88, 32, 7));
  mdf.link(time1, 4, speed); mdf.link(speed, 4, gear); mdf.link(gear, 4, label); mdf.link(speed, 8, speedCc); mdf.link(gear, 8, gearCc);
  const cg1Body = Buffer.alloc(26); cg1Body.writeUInt16LE(3, 14); cg1Body.writeUInt16LE(15, 16); cg1Body.writeUInt32LE(2, 18);
  const cg1 = mdf.add('CG', cg1Body); mdf.link(cg1, 8, time1); mdf.link(cg1, 12, mdf.text('Engine'));
  const records1 = Buffer.alloc(30);
  [[0.5, 1234, 0], [1.5, 1250, 1]].forEach(([seconds, raw, gearValue], i) => { records1.writeDoubleLE(seconds, 15 * i); records1.writeUInt16LE(raw, 15 * i + 8); records1[15 * i + 10] = gearValue; records1.write('ab', 15 * i + 11, 'latin1'); });
  const data1 = mdf.add('..', records1);
  // Group 2 (unsorted, record IDs): two channel groups of float32 values with their own float32 times.
  const group = (id: number, name: string) => {
    const t = mdf.add('CN', cn('t', 1, 0, 32, 2)); const v = mdf.add('CN', cn(name, 0, 32, 32, 2)); mdf.link(t, 4, v);
    const body = Buffer.alloc(26); body.writeUInt16LE(id, 12); body.writeUInt16LE(2, 14); body.writeUInt16LE(8, 16); body.writeUInt32LE(2, 18);
    const block = mdf.add('CG', body); mdf.link(block, 8, t); return block;
  };
  const cgA = group(1, 'A'); const cgB = group(2, 'B'); mdf.link(cgA, 4, cgB);
  const record = (id: number, time: number, value: number) => { const buffer = Buffer.alloc(9); buffer[0] = id; buffer.writeFloatLE(time, 1); buffer.writeFloatLE(value, 5); return buffer; };
  const data2 = mdf.add('..', Buffer.concat([record(1, 0.25, 1), record(2, 0.5, 10), record(1, 0.75, 2), record(2, 1, 20)]));
  const dgBody = () => { const body = Buffer.alloc(24); body.writeUInt16LE(1, 16); return body; };
  const dg1 = mdf.add('DG', dgBody()); const dg2Body = dgBody(); dg2Body.writeUInt16LE(2, 16); dg2Body.writeUInt16LE(1, 18); const dg2 = mdf.add('DG', dg2Body);
  mdf.link(dg1, 4, dg2); mdf.link(dg1, 8, cg1); mdf.link(dg1, 16, data1); mdf.link(dg2, 8, cgA); mdf.link(dg2, 16, data2);
  mdf.link(header, 4, dg1);
  const { diagnostics, reference, signals, frames } = await parse(mdf.build());
  assert.equal(frames, 0);
  assert.deepEqual(diagnostics.map((item) => item.code), ['MDF_CHANNEL_UNSUPPORTED']);
  assert.deepEqual(reference, { start: 1_700_000_000 + 9 * 3600, offset: 1_700_000_000 + 9 * 3600, utcOffsetMinutes: 540 });
  assert.deepEqual(signals.map((item) => [item.group, item.channel, item.unit, Array.from(item.times), Array.from(item.values).map((value) => +value.toFixed(6))]), [
    ['Engine', 'Speed', 'km/h', [0.5, 1.5], [123.4, 125]],
    ['Engine', 'Gear', undefined, [0.5, 1.5], [0, 1]],
    ['Group 2', 'A', undefined, [0.25, 0.75], [1, 2]],
    ['Group 3', 'B', undefined, [0.5, 1], [10, 20]],
  ]);
  assert.equal(seriesLabel(signals[1], 1), 'D');
});

test('bundled basic MDF 3 log holds the reference signals, with the ASC start time', async () => {
  const { readFileSync } = await import('fs');
  const { parseAscFile } = await import('../src/parsers/asc/parseAscStream');
  const { diagnostics, reference, signals } = await parse(readFileSync('sample/sigmixa-basic-decoded.mdf'));
  let ascReference: TimeReference | undefined;
  await parseAscFile('sample/sigmixa-basic.asc', { sourceId: 'asc', onFrames: () => undefined, onTimeReference: (value) => { ascReference = value; } });
  const csv = readFileSync('sample/sigmixa-basic-decoded.csv', 'utf8').trim().split(/\r?\n/).slice(1).map((line) => line.split(',').map(Number));
  assert.deepEqual(diagnostics, []); assert.deepEqual(reference, ascReference);
  assert.deepEqual(signals.map((item) => [item.group, item.channel, item.unit]), [['Reference', 'Vehicle Speed', 'm/s'], ['Reference', 'Coolant Temperature', '°C'], ['Reference', 'Speed Band', undefined]]);
  assert.deepEqual(Array.from(signals[0].times), csv.map(([milliseconds]) => milliseconds / 1000));
  assert.deepEqual(Array.from(signals[0].values), csv.map(([, speed]) => speed));
  assert.deepEqual(Array.from(signals[1].values), csv.map(([, , temperature]) => temperature));
  assert.equal(seriesLabel(signals[2], 0), csv[0][1] < 10 ? 'Slow' : csv[0][1] < 20 ? 'Medium' : 'Fast');
});

test('MDF 3 records with two record IDs, across read chunks, keep their places', async () => {
  const mdf = new Mdf3();
  const header = mdf.add('HD', hd(0n, 0));
  const t = mdf.add('CN', cn('t', 1, 0, 64, 3)); const v = mdf.add('CN', cn('V', 0, 64, 32, 0)); mdf.link(t, 4, v);
  const body = Buffer.alloc(26); body.writeUInt16LE(7, 12); body.writeUInt16LE(2, 14); body.writeUInt16LE(12, 16); body.writeUInt32LE(100_000, 18);
  const group = mdf.add('CG', body); mdf.link(group, 8, t);
  // Each record: ID, 12 bytes, ID again (14 bytes): 1.4 MB in all, across the 1 MiB chunks the reader takes.
  const records = Buffer.alloc(14 * 100_000);
  for (let i = 0; i < 100_000; i++) { records[14 * i] = 7; records.writeDoubleLE(i / 100, 14 * i + 1); records.writeUInt32LE(i, 14 * i + 9); records[14 * i + 13] = 7; }
  const data = mdf.add('..', records);
  const dgBody = Buffer.alloc(24); dgBody.writeUInt16LE(1, 16); dgBody.writeUInt16LE(2, 18);
  const dg = mdf.add('DG', dgBody); mdf.link(dg, 8, group); mdf.link(dg, 16, data); mdf.link(header, 4, dg);
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(diagnostics.map((item) => item.code), []);
  assert.equal(signals[0].values.length, 100_000);
  assert.ok(signals[0].values.every((value, i) => value === i));
});

test('an MDF log with measured signals only has their time range, so comparison and reports can use it', async () => {
  const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { emptyProject } = await import('../src/core/project/schema');
  const file = path.resolve('sample/sigmixa-basic-decoded.mdf');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, emptyProject(), 1, new PluginRegistry());
  try {
    await doc.whenReady(); assert.deepEqual(doc.timelineRange, { start: 0.001, end: 60.001 });
    // Without frames, the comparison screen steps a target through the samples' times.
    const next = doc.adjacentFrameTimestamp(0.001, 1); assert.ok(next !== undefined && next > 0.001 && next <= 60.001);
    assert.equal(doc.adjacentFrameTimestamp(next!, -1), 0.001); assert.equal(doc.nearestFrameTimestamp(0.001 + (next! - 0.001) / 4), 0.001);
  } finally { doc.dispose(); }
});

test('an MDF 3 time channel of 0 bits counts records at its sampling rate', async () => {
  const mdf = new Mdf3();
  const header = mdf.add('HD', hd(0n, 0));
  const timeBody = cn('t', 1, 0, 0, 3); timeBody.writeDoubleLE(0.1, 206);
  const t = mdf.add('CN', timeBody); const v = mdf.add('CN', cn('V', 0, 0, 8, 0)); mdf.link(t, 4, v);
  const body = Buffer.alloc(26); body.writeUInt16LE(2, 14); body.writeUInt16LE(1, 16); body.writeUInt32LE(3, 18);
  const group = mdf.add('CG', body); mdf.link(group, 8, t);
  const dg = mdf.add('DG', (() => { const b = Buffer.alloc(24); b.writeUInt16LE(1, 16); return b; })()); mdf.link(dg, 8, group); mdf.link(dg, 16, mdf.add('..', Buffer.from([7, 8, 9]))); mdf.link(header, 4, dg);
  const { signals } = await parse(mdf.build());
  assert.deepEqual(signals.map((item) => [Array.from(item.times).map((time) => +time.toFixed(9)), Array.from(item.values)]), [[[0, 0.1, 0.2], [7, 8, 9]]]);
});

test('every graph of an MF4 log of measured signals spans the whole log, whichever channel group it shows', async () => {
  const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { emptyProject } = await import('../src/core/project/schema');
  const file = path.resolve('tests/fixtures/mdf/asammdf-signals-410.mf4');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, emptyProject(), 1, new PluginRegistry());
  try {
    await doc.whenReady();
    // Its channel groups cover different times (0–9.99 s and 0.05–24.95 s): each graph's axis is the log's, not its group's.
    const ids = doc.signalCatalog().map((definition) => definition.id);
    const own = ids.map((id) => doc.signalSeries([id], undefined, 100).series[0]?.samples ?? []).filter((samples) => samples.length).map((samples) => samples[samples.length - 1].timestamp);
    assert.ok(new Set(own.map((time) => Math.round(time))).size >= 2, 'the fixture has groups ending at different times');
    for (const id of ids) assert.deepEqual(doc.signalSeries([id], undefined, 100).range, doc.timelineRange);
  } finally { doc.dispose(); }
});
