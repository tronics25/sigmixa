import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkedFrameStore } from '../src/core/frame/frameStore';
import type { CanFrame } from '../src/core/frame/canFrame';
import { extractBits, extractRaw } from '../src/core/manual/bits';
import { convertScaleOffset } from '../src/core/manual/scaleOffset';
import { parseAscFrameBytes, parseAscLine } from '../src/parsers/asc/ascLineParser';
import { PluginFrameTags } from '../src/extension/editors/pluginFrameTags';
import { InMemorySignalStore } from '../src/core/signal/signalStore';

const frame = (index: number, id = `file:///a.asc:${index}`): CanFrame => ({ id, sourceId: 'file:///a.asc', timestamp: index / 10, canId: index % 3, extended: false, direction: 'Rx', channel: 1, dlcCode: 1, dataLength: 1, data: new Uint8Array([index & 0xff]) });

test('a frame is found again by its ID, also when IDs do not follow the order', () => {
  const store = new ChunkedFrameStore(8);
  store.append(Array.from({ length: 30 }, (_, index) => frame(index)));
  assert.equal(store.ordinalOf(frame(17)), 17); assert.equal(store.idAt(17), 'file:///a.asc:17'); assert.equal(store.ordinalOf(frame(99)), undefined);
  const mixed = new ChunkedFrameStore();
  mixed.append([frame(0, 'x:5'), frame(1, 'x:2'), frame(2, 'plain'), frame(3, 'x:007')]);
  assert.deepEqual(['x:5', 'x:2', 'plain', 'x:007'].map((id) => mixed.ordinalOf({ id, sourceId: 'file:///a.asc' })), [0, 1, 2, 3]);
});

test('a filter over a large log is read in steps and gives the same rows, frames arriving meanwhile included', () => {
  const store = new ChunkedFrameStore(64);
  store.append(Array.from({ length: 20_000 }, (_, index) => frame(index)));
  const filter = { canIds: [1] };
  let page = store.query({ offset: 0, limit: 5, filter });
  assert.equal(page.rows.length, 5);
  store.append([frame(20_002), frame(20_005)]);
  while (!store.continueScan(1)) { /* rest */ }
  page = store.query({ offset: 0, limit: 2000, filter });
  assert.equal(page.complete, true); assert.equal(page.total, 6667 + 2);
  const all = store.query({ offset: 6600, limit: 2000, filter }, undefined, { wait: true });
  assert.deepEqual(all.rows.slice(-3).map((item) => item.id), ['file:///a.asc:19999', 'file:///a.asc:20002', 'file:///a.asc:20005']);
  assert.ok(all.rows.every((item) => item.canId === 1));
});

test('bits read as numbers match the BigInt reading for every layout', () => {
  const data = new Uint8Array([0x12, 0xf4, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  for (const order of ['little', 'big'] as const) for (const signedness of ['signed', 'unsigned'] as const) for (let bit = 0; bit < 8; bit++) for (let length = 1; bit + length <= 64; length++) {
    assert.equal(String(extractRaw(data, 0, bit, length, order, signedness)), String(extractBits(data, 0, bit, length, order, signedness)), `${order} ${signedness} ${bit} ${length}`);
  }
  for (const lsbText of ['0.1', '1/3', '0.25', '-0.5', '1e-5']) for (const offset of [0, -40, 0.5]) for (const raw of [0, 1, -7, 123_456, 2 ** 40 + 3]) {
    const conversion = { lsbText, lsb: Number(lsbText.includes('/') ? 1 / 3 : lsbText), offset } as never;
    assert.ok(Object.is(convertScaleOffset(raw, conversion), convertScaleOffset(BigInt(raw), { ...(conversion as object) } as never)), `${lsbText} ${offset} ${raw}`);
  }
});

test('ASC rows read from bytes give the frames the full rules give', () => {
  const lines = ['   1.250000 1  1A3x            Rx   d 3 01 FF 7', '   2.5 CANFD   2 Tx 18FF00X Name 1 0 9 12 00 01 02 03 04 05 06 07 08 09 0A 0B 33 44', '0.1 1 7FF Rx r 4'];
  for (const line of lines) {
    const context = { sourceId: 's', line: 3, sequence: 9, base: 'hex' as const }; const bytes = Buffer.from(`\n${line}\n`);
    const fast = parseAscFrameBytes(bytes, 1, bytes.length - 1, context); const full = parseAscLine(line, context);
    assert.ok(fast); assert.equal(full.type, 'frame');
    assert.deepEqual({ ...fast, data: [...fast.data] }, { ...(full as { frame: CanFrame }).frame, data: [...(full as { frame: CanFrame }).frame.data] });
  }
  for (const line of ['   1.25 1 0x1A3 Rx d 1 01', '1.2.3 1 1A3 Rx d 1 01', '1.25 1 1A3 Rx d 2 01 G1', '1.25 1 1A3 Rx d 1 1é']) { const bytes = Buffer.from(line); assert.equal(parseAscFrameBytes(bytes, 0, bytes.length, { sourceId: 's', line: 1, sequence: 0, base: 'hex' }), undefined, line); }
});

test('Plugin tags of every frame are kept as numbers and spelled as the Plugin gave them', () => {
  const tags = new PluginFrameTags();
  tags.set(3, [{ name: 'Speed', unit: 'km/h', value: 0.1 + 0.2 }, { name: 'Speed', unit: 'km/h', value: 2 }, { name: 'Mode', value: 1 }], []);
  tags.set(1, [{ name: 'Late', value: 5 }], []);
  assert.deepEqual(tags.get(3)?.tags, ['Speed=0.30000000000000004 km/h', 'Speed=2 km/h', 'Mode=1']);
  assert.deepEqual(tags.get(1)?.tags, ['Late=5']); assert.equal(tags.get(2), undefined);
});

test('rows of frame ordinals carry the frame ID and survive sorting', () => {
  const store = new InMemorySignalStore({ frameId: (ordinal) => `f:${ordinal}` });
  const definition = { id: 's', name: 'S', source: { type: 'manual-can', frameDefinitionId: 'd' } } as never;
  store.appendFrame(0, 2, [{ definition, sample: { timestamp: 2, value: 20, quality: 'valid', valueLabel: 'two' } }]);
  store.appendFrame(1, 1, [{ definition, sample: { timestamp: 1, value: 10, quality: 'invalid' } }]);
  store.finalize();
  assert.deepEqual(store.tablePage(['s'], 0, 10).rows.map((row) => [row.id, row.timestamp, row.values.get('s')]), [['f:1', 1, { timestamp: 1, value: 10, quality: 'invalid' }], ['f:0', 2, { timestamp: 2, value: 20, quality: 'valid', valueLabel: 'two' }]]);
  assert.deepEqual(store.samplesForFrame(0), [{ signalId: 's', sample: { timestamp: 2, value: 20, quality: 'valid', valueLabel: 'two' } }]);
});

test('a long series is drawn with its peaks, breaks and invalid values, and the same while it grows', () => {
  const definition = { id: 'v', name: 'v', source: { type: 'manual' } } as never;
  const fill = (store: InMemorySignalStore, from: number, to: number) => {
    for (let index = from; index < to; index++) {
      const time = index / 100 + (index >= 30_000 ? 5 : 0);
      const value = index === 12_345 ? 1000 : index === 40_001 ? -1000 : Math.sin(index / 300);
      store.appendFrame(index, time, [{ definition, sample: { timestamp: time, value, ...(index === 20_000 ? { quality: 'invalid' as const } : {}) } }]);
    }
  };
  const growing = new InMemorySignalStore(); fill(growing, 0, 25_000);
  growing.seriesSlice(['v'], undefined, 400);
  fill(growing, 25_000, 50_000);
  const fresh = new InMemorySignalStore(); fill(fresh, 0, 50_000);
  const [slice] = growing.seriesSlice(['v'], undefined, 400);
  assert.deepEqual(slice, fresh.seriesSlice(['v'], undefined, 400)[0]);
  assert.ok(slice.samples.length <= 400);
  const values = slice.samples.map((sample) => sample.value);
  assert.ok(values.includes(1000) && values.includes(-1000));
  assert.ok(slice.gaps.some((gap) => gap.startTimestamp <= 199.99 && gap.endTimestamp >= 200.01));
  assert.ok(slice.gaps.some((gap) => gap.startTimestamp < 300 && gap.endTimestamp > 304));
  const zoomed = growing.seriesSlice(['v'], { start: 120, end: 130 }, 50)[0];
  assert.deepEqual(zoomed, fresh.seriesSlice(['v'], { start: 120, end: 130 }, 50)[0]);
});

test('the width of Plugin tags is counted without spelling them', () => {
  const tags = new PluginFrameTags(); const cells = (text: string) => text.length;
  tags.set(3, [{ name: 'Speed', unit: 'km/h', value: 12.5 }, { name: 'Speed', unit: 'km/h', value: -3 }], []);
  tags.set('x', [{ name: 'A', value: 1 }], []);
  for (const frame of [3, 'x', 4]) assert.equal(tags.cells(frame, cells, 7), (tags.get(frame)?.tags ?? []).reduce((sum, tag) => sum + tag.length + 7, 0));
});

test('the Trace index built in steps is the index built at once', async () => {
  const { TraceIndex } = await import('../src/core/frame/traceIndex');
  const store = new InMemorySignalStore(); const definition = { id: 's', name: 's', source: { type: 'manual' } } as never;
  const frames = Array.from({ length: 120_000 }, (_, index) => frame(index));
  frames.forEach((item, index) => store.appendFrame(index, item.timestamp, [{ definition, sample: { timestamp: item.timestamp, value: index % 7 } }]));
  const samples = (_frame: CanFrame, index: number) => store.samplesForFrame(index);
  const once = new TraceIndex(frames, samples, undefined, (index) => frames[index], store);
  const steps = TraceIndex.fromColumnSteps(frames, samples, undefined, (index) => frames[index], store); let step = steps.next(); let yields = 0;
  while (!step.done) { yields++; step = steps.next(); }
  assert.ok(yields > 2);
  for (const time of [0, 777.7, 5000, 20_000]) assert.deepEqual(step.value.at(time), once.at(time));
});

test('filter evidence is kept in columns and given back as it came, also after sorting', () => {
  const store = new InMemorySignalStore(); const definition = { id: 'f', name: 'f', source: { type: 'manual' } } as never;
  const evidence = [
    { previousValue: undefined, deltaSeconds: 0 }, { previousValue: 1.5, deltaSeconds: 0.01 },
    { previousValue: 2, deltaSeconds: 0.02, sampleCount: 3, sum: 6 }, { previousValue: 2, deltaSeconds: 0.02, sampleCount: undefined, sum: undefined },
    { deltaSeconds: 1 },
  ];
  const times = [5, 1, 4, 2, 3];
  times.forEach((time, index) => store.appendFrame(index, time, [{ definition, sample: { timestamp: time, value: index, filterEvidence: evidence[index] as never, ...(index === 4 ? { originalTimestamp: { value: 3000, unit: 'milliseconds' as const } } : {}) } }]));
  const samples = store.seriesSlice(['f'], undefined, 100)[0].samples;
  assert.deepEqual(samples.map((sample) => sample.value), [1, 3, 4, 2, 0]);
  samples.forEach((sample) => assert.deepEqual(sample.filterEvidence, evidence[sample.value]));
  assert.deepEqual(samples[2].originalTimestamp, { value: 3000, unit: 'milliseconds' });
  assert.deepEqual(Object.keys(samples[4].filterEvidence!), ['previousValue', 'deltaSeconds']);
});

test('a selected Signal that first appears later joins the Table, and changes compare with the sample before in time', () => {
  const plugin = { id: 'p', name: 'p', source: { type: 'plugin', pluginId: 'x', bindingId: 'y' } } as never;
  const plain = { id: 'a', name: 'a', source: { type: 'manual' } } as never;
  const store = new InMemorySignalStore();
  store.appendFrame(0, 0, [{ definition: plain, sample: { timestamp: 0, value: 1 } }]);
  assert.equal(store.tablePage(['p'], 0, 10).total, 0);
  store.appendFrame(1, 1, [{ definition: plugin, sample: { timestamp: 1, value: 5 } }]);
  store.appendFrame(2, 2, [{ definition: plugin, sample: { timestamp: 2, value: 6 } }]);
  assert.equal(store.tablePage(['p'], 0, 10).total, 2);
  const build = (finalize: boolean) => {
    const target = new InMemorySignalStore();
    [[0, 1, 10], [1, 3, 30], [2, 2, 100]].forEach(([frame, time, value]) => target.appendFrame(frame, time, [{ definition: plain, sample: { timestamp: time, value } }]));
    if (finalize) target.finalize();
    return target.tableDisplayPage(['a'], 0, 10).rows.find((row) => row.timestamp === 3)?.changes;
  };
  assert.deepEqual(build(false), build(true));
});

test('filter evidence stays with its sample when samples without evidence come in between', () => {
  const store = new InMemorySignalStore(); const definition = { id: 'g', name: 'g', source: { type: 'manual' } } as never;
  const evidence = [{ previousValue: 1, deltaSeconds: 0.5 }, undefined, undefined, { previousValue: 7, deltaSeconds: 0.25 }];
  evidence.forEach((item, index) => store.appendFrame(index, index, [{ definition, sample: { timestamp: index, value: index, ...(item ? { filterEvidence: item } : {}) } }]));
  const samples = store.seriesSlice(['g'], undefined, 100)[0].samples;
  assert.deepEqual(samples.map((sample) => sample.filterEvidence), evidence);
});

test('a Table width scan started before rows are put in time order gives the result of a scan after it', () => {
  const definition = { id: 'w', name: 'w', source: { type: 'manual' } } as never;
  const build = () => {
    const store = new InMemorySignalStore();
    for (let index = 0; index < 120_000; index++) { const time = index % 2 ? index : 200_000 - index; store.appendFrame(index, time, [{ definition, sample: { timestamp: time, value: index === 77_777 ? 123456789 : index % 10 } }]); }
    return store;
  };
  const early = build(); const scan = early.tableWidthScan(['w']); scan.next(); early.finalize();
  let step = scan.next(); while (!step.done) step = scan.next();
  const late = build(); late.finalize(); const reference = late.tableWidthScan(['w']); let done = reference.next(); while (!done.done) done = reference.next();
  assert.deepEqual(step.value, done.value);
  assert.ok(step.value.some((row) => row.values.get('w')?.value === 123456789));
});

test('a Table width scan takes in rows the log adds between its steps', () => {
  const definition = { id: 'w', name: 'w', source: { type: 'manual' } } as never;
  const store = new InMemorySignalStore();
  const add = (from: number, to: number, wide?: number) => { for (let index = from; index < to; index++) store.appendFrame(index, index, [{ definition, sample: { timestamp: index, value: index === wide ? 123456789 : index % 10 } }]); };
  add(0, 120_000);
  const scan = store.tableWidthScan(['w']); scan.next();
  // A wide value arrives while the scan waits between steps, in a row the scan had not seen when it started.
  add(120_000, 130_000, 125_000);
  let step = scan.next(); while (!step.done) step = scan.next();
  assert.ok(step.value.some((row) => row.values.get('w')?.value === 123456789));
  assert.ok(step.value.some((row) => row.timestamp === 129_999));
});

test('Table width scans for two selections taken in turns both finish with their own result', () => {
  const a = { id: 'a', name: 'a', source: { type: 'manual' } } as never; const b = { id: 'b', name: 'b', source: { type: 'manual' } } as never;
  const store = new InMemorySignalStore();
  for (let index = 0; index < 60_000; index++) store.appendFrame(index, index, [{ definition: index % 2 ? a : b, sample: { timestamp: index, value: index === 30_001 ? 987654321 : index === 40_000 ? 123456789 : index % 10 } }]);
  const left = store.tableWidthScan(['a']); const right = store.tableWidthScan(['b']);
  let one = left.next(); let two = right.next(); let rounds = 0;
  while ((!one.done || !two.done) && rounds++ < 1000) { if (!one.done) one = left.next(); store.tablePage(['b'], 0, 1); if (!two.done) two = right.next(); store.tablePage(['a'], 0, 1); }
  assert.ok(one.done && two.done);
  assert.deepEqual(one.value, store.tableWidthRows(['a'])); assert.deepEqual(two.value, store.tableWidthRows(['b']));
  assert.ok(one.value.some((row) => row.values.get('a')?.value === 987654321));
  assert.ok(two.value.some((row) => row.values.get('b')?.value === 123456789));
});

test('a Table width scan takes in a selected Signal that gets its first sample between its steps', () => {
  const w = { id: 'w', name: 'w', source: { type: 'manual' } } as never; const late = { id: 'late', name: 'late', source: { type: 'manual' } } as never;
  const store = new InMemorySignalStore();
  for (let index = 0; index < 120_000; index++) store.appendFrame(index, index, [{ definition: w, sample: { timestamp: index, value: index % 10 } }]);
  const scan = store.tableWidthScan(['w', 'late']); scan.next();
  store.appendFrame(120_000, 120_000, [{ definition: late, sample: { timestamp: 120_000, value: 123456789 } }]);
  for (let index = 120_001; index < 120_010; index++) store.appendFrame(index, index, [{ definition: w, sample: { timestamp: index, value: 1 } }]);
  let step = scan.next(); while (!step.done) step = scan.next();
  assert.ok(step.value.some((row) => row.values.get('late')?.value === 123456789));
});
