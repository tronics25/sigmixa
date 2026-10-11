import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CURRENT_PROJECT_SCHEMA_VERSION, clipRange, migrateProject } from '../src/core/project/schema';
import { validateFrameDefinition } from '../src/core/manual/manualDefinition';
import { createManualDecodeContext, decodeManualFrame } from '../src/core/manual/manualDecoder';
import type { CanFrame } from '../src/core/frame/canFrame';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';
import { createRequire } from 'node:module';
import { PluginHost, PluginRegistry } from '../src/core/plugin/pluginHost';
import type { SigMixaPlugin } from '../src/plugin-sdk';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import { signalDefinitionFor } from '../src/core/manual/manualDefinition';
import { importExternalCsvText } from '../src/core/external/csv';
import { buildTrajectoryPoints } from '../src/core/trajectory/trajectory';
import { externalSignalId } from '../src/core/external/csv';
import { importDbc } from '../src/core/dbc/dbc';
import { addedLogsOf, composeWorkspace } from '../src/core/project/folderLevels';
import { resolveGroupProject } from '../src/core/project/analysisGroups';
import { resolveDisplayUnit } from '../src/core/units/displayUnit';
import type { ManualFrameDefinition as ManualFrame } from '../src/core/manual/manualDefinition';

const workspace = path.resolve('sample');

test('the basic log has no Clips; the road test is split into three Clips, the car park has one', () => {
  const read = (folder: string) => migrateProject(JSON.parse(readFileSync(path.join(workspace, folder, '.sigmixa/project.json'), 'utf8')));
  assert.deepEqual(read('').clips, []);
  assert.deepEqual(read('brake-analysis').clips.map((clip) => [clip.name, clip.sourcePath, clipRange(clip)]), [
    ['Stop 1', 'road-test.asc', { start: 2.5, end: 7 }], ['Stop 2', 'road-test.asc', { start: 8.5, end: 13 }], ['Stop 3', 'road-test.asc', { start: 14.5, end: 19 }],
  ]);
  // A Clip is only a name and a time range of a log in its own folder; it has no Signal selection or view settings of its own.
  for (const folder of ['brake-analysis', 'parking-drive']) {
    const stored = JSON.parse(readFileSync(path.join(workspace, folder, '.sigmixa/project.json'), 'utf8')) as { clips: Record<string, unknown>[]; viewStates: Record<string, unknown> };
    for (const clip of stored.clips) { assert.ok(existsSync(path.join(workspace, folder, String(clip.sourcePath)))); assert.deepEqual(Object.keys(clip).sort(), ['id', 'name', 'range', 'sourceFileName', 'sourcePath']); }
    assert.deepEqual(Object.keys(stored.viewStates).filter((key) => key.startsWith('clip:')), []);
  }
});

test('sample workspace persists seventeen valid Manual Frames', () => {
  const persisted = JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')) as { schemaVersion: number; frames: Array<Record<string, unknown>> };
  assert.equal(persisted.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION);
  assert.equal(persisted.frames.filter((frame) => (frame.origin as { type?: string } | undefined)?.type === 'manual').length, 17);
  assert.ok(persisted.frames.every((frame) => typeof frame.canId === 'string' && !('extended' in frame)));
  const project = migrateProject(persisted);
  for (const frame of project.frames.filter((candidate) => candidate.origin?.type === 'manual')) {
    assert.deepEqual(validateFrameDefinition(frame).diagnostics, []);
  }
  assert.deepEqual(project.frames.filter((frame) => frame.origin?.type === 'manual').map((frame) => frame.id), ['ff-2a0', 'ff-300', 'ff-310', 'ff-320', 'ff-184', 'ff-18ff50e5', 'ff-5a0x', 'ff-3c0', 'ff-1a0', 'ff-1a1', 'ff-1b0', 'ff-1b1', 'ff-1b2', 'ff-1b3', 'ff-1c0', 'ff-1c1', 'ff-5b0']);
  const multiplexed = project.frames.find((frame) => frame.id === 'ff-320');
  assert.equal(multiplexed?.multiplexing, true);
  assert.deepEqual(multiplexed?.signals[0].valueLabels, { 0: 'Torque', 1: 'Power', 2: 'Regeneration' });
  assert.deepEqual(project.frames.find((frame) => frame.id === 'ff-310')?.signals.find((signal) => signal.id === 'sig-gear-position')?.valueLabels, { 0: 'Park', 1: 'Neutral', 3: 'Drive' });
  assert.ok(project.viewStates['log-view-default']);
});

test('basic log DBC imports value labels and Multiplexing without errors', () => {
  const result = importDbc(readFileSync(path.join(workspace, 'sigmixa-basic.dbc'), 'utf8'), 'sigmixa-basic.dbc');
  assert.deepEqual(result.diagnostics.filter((item) => item.severity === 'error'), []);
  const body = result.frames.find((frame) => frame.canId === 0x310);
  assert.deepEqual(body?.signals.find((signal) => signal.name === 'GearPosition')?.valueLabels, { 0: 'Park', 1: 'Neutral', 3: 'Drive' });
  const multiplexed = result.frames.find((frame) => frame.canId === 0x320);
  assert.equal(multiplexed?.multiplexing, true);
  assert.deepEqual(multiplexed?.signals.map((signal) => signal.multiplexing), [
    { type: 'multiplexer' }, undefined,
    { type: 'conditional', ranges: [{ from: 0, to: 0 }] },
    { type: 'conditional', ranges: [{ from: 1, to: 1 }] },
    { type: 'conditional', ranges: [{ from: 2, to: 2 }] },
  ]);
});

test('basic log ASC exercises parser boundaries and visible Signal ranges', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const definitions = new Map(project.frames.map((frame) => [frame.canId, frame]));
  const values = new Map<string, number[]>();
  const manualContext = createManualDecodeContext();
  const observed = new Set<string>();
  const observedIds = new Set<string>();
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'basic', batchSize: 127,
    onFrames: (frames) => {
      for (const frame of frames) {
        observed.add(`${frame.extended ? 'extended' : 'standard'}:${frame.direction}:${frame.dlcCode}:${frame.dataLength}`);
        observedIds.add(`${frame.extended ? 'extended' : 'standard'}:${frame.canId.toString(16)}`);
        const definition = definitions.get(frame.canId); if (!definition) continue;
        for (const item of decodeManualFrame(frame, definition, manualContext).decoded) {
          const series = values.get(item.definition.id) ?? []; series.push(item.sample.value); values.set(item.definition.id, series);
        }
      }
    },
  });

  assert.ok(summary.framesParsed > 3000);
  assert.equal(summary.diagnostics, 2);
  assert.ok(observed.has('standard:Rx:8:8'));
  assert.ok(observed.has('standard:Tx:8:8'));
  assert.ok(observed.has('standard:Rx:0:0'));
  assert.ok(observed.has('extended:Rx:8:8'));
  assert.ok(observed.has('standard:Rx:15:64'));
  assert.ok(observed.has('standard:Rx:10:16'));
  assert.ok(observedIds.has('extended:18ff50e5'));
  assert.ok(observedIds.has('extended:5a0'));
  assert.equal(values.get('sig-speed')?.[0], 0); assert.equal(values.get('sig-speed')?.at(-1), 0);
  assert.ok(Math.max(...values.get('sig-speed')!) >= 89);
  assert.ok(Math.max(...values.get('sig-corrected-speed')!) > 80);
  assert.ok(Math.max(...values.get('sig-corrected-speed-rate')!) > 65);
  assert.ok(Math.max(...values.get('sig-speed-grade')!) >= 2);
  assert.equal(values.get('sig-smoothed-speed')?.length, values.get('sig-corrected-speed')?.length);
  assert.notDeepEqual(values.get('sig-smoothed-speed')?.slice(1, 20), values.get('sig-corrected-speed')?.slice(1, 20));
  assert.ok(Math.max(...values.get('sig-temp')!) >= 66);
  assert.ok(Math.max(...values.get('sig-brake-pressure')!) >= 104);
  assert.ok(Math.max(...values.get('sig-engine-speed')!) > 4000);
  assert.ok(Math.max(...values.get('sig-engine-torque')!) > 100);
  assert.ok(Math.min(...values.get('sig-engine-torque')!) < 0);
  assert.ok(Math.max(...values.get('sig-mechanical-power')!) > 30);
  assert.ok(Math.max(...values.get('sig-wheel-speed-difference')!) > 2);
  assert.ok(Math.max(...values.get('sig-object-distance')!) > 70);
  assert.ok(Math.min(...values.get('sig-relative-speed')!) < -3);
  assert.ok(values.get('sig-time-to-collision')!.every(Number.isFinite));
  assert.ok(Math.max(...values.get('sig-barometric-pressure')!) > 100);
  assert.deepEqual(new Set(values.get('sig-headlight')), new Set([0, 1]));
  assert.deepEqual(new Set(values.get('sig-turn-left')), new Set([0, 1]));
  assert.deepEqual(new Set(values.get('sig-mux-mode')), new Set([0, 1, 2]));
  assert.ok((values.get('sig-requested-torque')?.length ?? 0) > 0);
  assert.ok((values.get('sig-dc-link-power')?.length ?? 0) > 0);
  assert.ok((values.get('sig-regen-limit')?.length ?? 0) > 0);
});

test('basic log runs two public Plugins on one Frame and isolates the deliberate failure marker', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const samplePlugins = project.plugins.filter((item) => item.id === 'sample.byte-scaler' || item.id === 'sample.payload-metric');
  const sampleBindings = project.pluginBindings.filter((item) => item.pluginId === 'sample.byte-scaler' || item.pluginId === 'sample.payload-metric');
  assert.equal(samplePlugins.length, 2); assert.equal(sampleBindings.length, 2);
  assert.equal(new Set(sampleBindings.map((item) => item.frameId)).size, 1);
  const registry = new PluginRegistry(); const runtimeRequire = createRequire(path.resolve('tests/sampleWorkspace.test.ts'));
  for (const registration of project.plugins) {
    const plugin = runtimeRequire(path.join(workspace, registration.source)) as SigMixaPlugin;
    plugin.setConfig?.(registration.config); registry.register(plugin, registration.source);
  }
  const host = new PluginHost(registry, project.frames, project.plugins, project.pluginBindings);
  const sampleCounts = new Map<string, number>(); const diagnostics: string[] = [];
  await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'plugin-basic',
    onFrames: (frames) => {
      for (const frame of frames) {
        const result = host.processFrame(frame);
        for (const item of result.decoded) {
          if (item.definition.source.type !== 'plugin') continue;
          const pluginId = item.definition.source.pluginId; sampleCounts.set(pluginId, (sampleCounts.get(pluginId) ?? 0) + 1);
        }
        diagnostics.push(...result.diagnostics.map((item) => item.code));
      }
    },
  });
  assert.equal(sampleCounts.get('sample.byte-scaler'), 601);
  assert.equal(sampleCounts.get('sample.payload-metric'), 600);
  assert.deepEqual(diagnostics, ['PLUGIN_PROCESS_THROW']);
});

test('basic log overlays non-zero External CSV timestamps without Table merging', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  assert.equal(project.externalCsvSources.length, 1); assert.equal(project.calculations.length, 0); assert.equal(project.lookupTables.length, 0);
  const store = new InMemorySignalStore();
  store.registerDefinitions(project.frames.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signalDefinitionFor(frame, signal))));
  const definitions = new Map(project.frames.map((frame) => [`${frame.extended ? 'e' : 's'}:${frame.canId}`, frame]));
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'csv-basic',
    onFrames: (frames) => {
      for (const frame of frames) {
        const definition = definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
        if (!definition) continue;
        store.appendFrame(frame.id, frame.timestamp, decodeManualFrame(frame, definition).decoded);
      }
    },
  });
  assert.equal(summary.diagnostics, 2);

  const source = project.externalCsvSources[0];
  const external = importExternalCsvText(readFileSync(path.join(workspace, source.path), 'utf8'), source);
  assert.equal(external.diagnostics.length, 0); assert.equal(external.series.length, 2);
  assert.equal(external.series[0].samples[0].timestamp, 5);
  assert.deepEqual(external.series[0].samples[0].originalTimestamp, { value: 5000, unit: 'milliseconds' });
  for (const series of external.series) store.appendSeries(series.definition, series.samples);
  store.finalize();
  assert.equal(store.tablePage([external.series[0].definition.id], 0, 10).total, 0);
});

test('basic log decodes an effective synchronized 3D Trajectory', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const definition = project.frames.find((frame) => frame.id === 'ff-184');
  assert.ok(definition); assert.equal(definition.frameLength, 16);
  assert.deepEqual(definition.signals.slice(0, 3).map((signal) => signal.id), ['sig-position-x', 'sig-position-y', 'sig-position-z']);
  assert.deepEqual(definition.signals.slice(3).map((signal) => signal.id), ['sig-heading', 'sig-yaw-rate', 'sig-lateral-accel']);
  assert.deepEqual(validateFrameDefinition(definition).diagnostics, []);
  const samples = new Map(definition.signals.map((signal) => [signal.id, [] as Array<{ timestamp: number; value: number }>]));
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'trajectory-basic',
    onFrames: (frames) => {
      for (const frame of frames) {
        if (frame.canId !== definition.canId || frame.extended !== definition.extended) continue;
        for (const item of decodeManualFrame(frame, definition).decoded) samples.get(item.definition.id)?.push(item.sample);
      }
    },
  });
  assert.equal(summary.diagnostics, 2);
  assert.ok(Math.max(...samples.get('sig-heading')!.map((sample) => sample.value)) > 300);
  assert.ok(samples.get('sig-yaw-rate')!.every((sample) => Math.abs(sample.value - 24.06) < 0.001));
  assert.ok(Math.min(...samples.get('sig-lateral-accel')!.map((sample) => sample.value)) < -0.2);
  assert.ok(Math.max(...samples.get('sig-lateral-accel')!.map((sample) => sample.value)) > 0.2);
  const points = buildTrajectoryPoints(samples.get('sig-position-x')!, samples.get('sig-position-y')!, samples.get('sig-position-z')!, { x: false, y: false, z: false });
  assert.ok(points.length >= 150);
  assert.equal(points[0].timestamp, 0.004); assert.ok(points.at(-1)!.timestamp > 59);
  assert.ok(Math.min(...points.map((point) => point.x)) < -20); assert.ok(Math.max(...points.map((point) => point.x)) > 20);
  assert.ok(Math.min(...points.map((point) => point.y)) < -20); assert.ok(Math.max(...points.map((point) => point.y)) > 20);
  assert.ok(Math.max(...points.map((point) => point.z!)) - Math.min(...points.map((point) => point.z!)) > 10);
});

test('the property-service Plugin pairs each response with its request', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const registry = new PluginRegistry(); const runtimeRequire = createRequire(path.resolve('tests/sampleWorkspace.test.ts'));
  for (const registration of project.plugins) {
    const plugin = runtimeRequire(path.join(workspace, registration.source)) as SigMixaPlugin;
    plugin.setConfig?.(registration.config); registry.register(plugin, registration.source);
  }
  const host = new PluginHost(registry, project.frames, project.plugins, project.pluginBindings);
  const samples: Array<{ name: string; time: number; value: number; label?: string }> = []; const diagnostics: string[] = [];
  await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'property-basic',
    onFrames: (frames) => {
      for (const frame of frames) {
        if (frame.canId !== 0x6a0 && frame.canId !== 0x6a8) continue;
        const result = host.processFrame(frame); diagnostics.push(...result.diagnostics.map((item) => item.code));
        for (const item of result.decoded) samples.push({ name: item.definition.name, time: item.sample.timestamp, value: item.sample.value, label: item.sample.valueLabel });
      }
    },
  });
  assert.deepEqual(diagnostics, []);
  const named = (name: string) => samples.filter((sample) => sample.name === name);
  assert.deepEqual(named('Target Cabin Temperature').map((sample) => sample.value), [22, 24.5, 22], 'Scale 0.5 and Offset -40 from the Plugin configuration');
  assert.deepEqual(named('Target Cabin Temperature Requested').map((sample) => sample.value), [24.5]);
  assert.deepEqual(named('Fan Level Result').map((sample) => sample.label), ['Get Success', 'Set Success', 'Set Failure', 'Get Success', 'Reset Success'], 'each response is labelled with the request it answers');
  assert.deepEqual(named('Fan Level').map((sample) => sample.value), [2, 3, 3, 3, 2], 'a failed Set reports the unchanged value');
  assert.deepEqual(named('Target Cabin Temperature Response Time').map((sample) => sample.value), [18, 35, 28]);
  assert.deepEqual(named('Property 7 Result').map((sample) => sample.label), ['Get Failure'], 'an ID missing from the configuration still decodes with a generic name');
  assert.deepEqual(named('Unanswered Requests').map((sample) => [sample.time, sample.value, sample.label]), [[52.0081, 1, 'Display Brightness Set']], 'the Set without a response is counted at the next request');
  assert.deepEqual(named('Display Brightness').map((sample) => sample.value), [70, 80, 80]);
});

test('the heartbeat has irregular intervals and a dropout, and one multiplexed Frame is too short', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  assert.equal(project.frames.find((frame) => frame.id === 'ff-3c0')?.expectedPeriodMs, 100);
  const heartbeat: number[] = []; const short: CanFrame[] = [];
  await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), {
    sourceId: 'coverage-basic',
    onFrames: (frames) => { for (const frame of frames) { if (frame.canId === 0x3c0) heartbeat.push(frame.timestamp); if (frame.canId === 0x320 && frame.dataLength < 8) short.push(frame); } },
  });
  const intervals = heartbeat.slice(1).map((time, index) => time - heartbeat[index]);
  assert.ok(Math.min(...intervals) < 0.085 && Math.max(...intervals.filter((value) => value < 1)) > 0.115, 'jitter around 100 ms');
  assert.ok(Math.max(...intervals) > 8.5, 'the 41-50 s dropout');
  assert.equal(short.length, 1); assert.equal(short[0].dataLength, 2);
  const definition = project.frames.find((frame) => frame.id === 'ff-320')!;
  const decoded = decodeManualFrame(short[0], definition);
  assert.ok(decoded.diagnostics.some((item) => item.code === 'FRAME_TOO_SHORT'));
});

const LEVELS = ['', 'brake-analysis', 'parking-drive'];
const readLevel = (folder: string) => migrateProject(JSON.parse(readFileSync(path.join(workspace, folder, '.sigmixa/project.json'), 'utf8')));

test('brake analysis manages several logs as one group, with its own definitions on top of the common ones', () => {
  const levels = LEVELS.map((folder) => ({ folder, project: readLevel(folder) }));
  const located = ['sigmixa-basic.asc', 'brake-analysis/bench-test.asc', 'brake-analysis/road-test.asc', 'parking-drive/parking-garage.asc'].map((file) => ({ path: file }));
  const project = composeWorkspace(levels, [...located, ...addedLogsOf(levels)]);
  const brake = project.analysisGroups!.find((group) => group.id === 'brake-analysis')!;
  assert.deepEqual([...brake.sourcePaths].sort(), ['brake-analysis/bench-test.asc', 'brake-analysis/road-test.asc', 'sigmixa-basic.asc'], 'two logs of its own and the basic log added');
  assert.ok(project.logPaths!.includes('sigmixa-basic.asc'), 'the added log also stays where it is');
  assert.ok(resolveGroupProject(project, 'brake-analysis').frames.find((frame) => frame.canId === 0x300)?.derivedSignals?.some((signal) => signal.id === 'sig-pedal-pressure-ratio'));
  assert.ok(!project.frames.find((frame) => frame.canId === 0x300)?.derivedSignals?.some((signal) => signal.id === 'sig-pedal-pressure-ratio'), 'the common definitions are unchanged');
  assert.ok(resolveGroupProject(project, 'parking-drive').frames.find((frame) => frame.canId === 0x1a1)?.derivedSignals?.some((signal) => signal.id === 'sig-inner-wheel-difference'));
});

test('the car park log climbs a helix in 3D, and each wheel runs on its own radius', async () => {
  const project = composeWorkspace(['', 'parking-drive'].map((folder) => ({ folder, project: readLevel(folder) })), []);
  const resolved = resolveGroupProject(project, 'parking-drive');
  const definitions = new Map(resolved.frames.map((frame) => [frame.canId, frame]));
  const values = new Map<string, Array<{ time: number; value: number }>>();
  await parseAscFile(path.join(workspace, 'parking-drive/parking-garage.asc'), {
    sourceId: 'parking', onFrames: (frames) => { const context = createManualDecodeContext(); for (const frame of frames) { const definition = definitions.get(frame.canId); if (!definition) continue; for (const item of decodeManualFrame(frame, definition, context).decoded) { const list = values.get(item.definition.id) ?? []; list.push({ time: item.sample.timestamp, value: item.sample.value }); values.set(item.definition.id, list); } } },
  });
  const series = (id: string, from = 0, to = Infinity) => values.get(id)!.filter((sample) => sample.time >= from && sample.time <= to).map((sample) => sample.value);
  assert.ok(Math.abs(Math.max(...series('sig-pose-z')) - 9.6) < 0.02, 'three turns of 3.2 m to the roof');
  assert.ok(Math.max(...series('sig-motion-yaw-rate').slice(1).map((value, index) => Math.abs(value - series('sig-motion-yaw-rate')[index]))) < 3, 'the yaw rate has no steps');
  // On the helix (left turns), radii about its centre: inner rear < inner front < axle < outer rear < outer front.
  const from = 20; const to = 50; const middle = (list: number[]) => (Math.min(...list) + Math.max(...list)) / 2; const centre = { x: middle(series('sig-pose-x', from, to)), y: middle(series('sig-pose-y', from, to)) };
  const radius = (prefix: string) => mean(series(`sig-${prefix}-x`, from, to).map((x, index) => Math.hypot(x - centre.x, series(`sig-${prefix}-y`, from, to)[index] - centre.y)));
  const [rl, fl, axle, rr, fr] = ['wheel-rl', 'wheel-fl', 'pose', 'wheel-rr', 'wheel-fr'].map(radius);
  assert.ok(Math.abs(axle - 8) < 0.1 && rl < fl && fl < axle && axle < rr && rr < fr, `radii ${[rl, fl, axle, rr, fr].map((value) => value.toFixed(2))}`);
  const difference = mean(series('sig-inner-wheel-difference', from, to));
  assert.ok(Math.abs(difference - (fl - rl)) < 0.05, `inner wheel difference ${difference.toFixed(3)} against the tracks ${(fl - rl).toFixed(3)}`);
  assert.ok(mean(series('sig-wheel-rl-speed', from, to)) < mean(series('sig-wheel-fr-speed', from, to)), 'the inner rear wheel turns slowest');
  // The GNSS antenna is 1.5 m above the ground and silent under the floors.
  const gnss = values.get('sig-gnss-x')!.map((sample) => sample.time);
  assert.ok(gnss.slice(1).some((time, index) => time - gnss[index] > 40));
  assert.ok(Math.min(...series('sig-gnss-z', 0, 3)) > 0.5);
  assert.ok((values.get('sig-obstacle-x')?.length ?? 0) > 20, 'the trolley outline');
});
const mean = (list: readonly number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;

test('every prepared view shows Signals that exist, on axes of their own unit systems', async () => {
  const project = readLevel('');
  const units = new Map<string, string | undefined>();
  for (const folder of LEVELS) for (const frame of readLevel(folder).frames) for (const signal of [...frame.signals, ...(frame.derivedSignals ?? [])]) units.set(signal.id, signal.unit);
  for (const source of project.externalCsvSources) for (const column of source.valueColumns) units.set(externalSignalId(source.id, column.column), column.unit);
  const registry = new PluginRegistry(); const runtimeRequire = createRequire(path.resolve('tests/sampleWorkspace.test.ts'));
  for (const registration of project.plugins) { const plugin = runtimeRequire(path.join(workspace, registration.source)) as SigMixaPlugin; plugin.setConfig?.(registration.config); registry.register(plugin, registration.source); }
  const host = new PluginHost(registry, project.frames, project.plugins, project.pluginBindings);
  await parseAscFile(path.join(workspace, 'sigmixa-basic.asc'), { sourceId: 'views-basic', onFrames: (frames) => { for (const frame of frames) for (const item of host.processFrame(frame).decoded) units.set(item.definition.id, item.definition.unit); } });
  const states = LEVELS.flatMap((folder) => Object.entries(readLevel(folder).viewStates).map(([key, state]) => [`${folder || '(common)'} ${key}`, state] as const))
    .filter(([, state]) => (state as { visualizeViews?: unknown }).visualizeViews) as Array<readonly [string, { visualizeViews: Array<{ kind: string; name: string; settings: Record<string, any> }>; tableSelectedIds?: string[] }]>;
  // The basic log's own views and the two groups' shared views. Clips have no views of their own.
  assert.ok(states.length >= 3);
  for (const [key, state] of states) {
    for (const id of state.tableSelectedIds ?? []) assert.ok(units.has(id), `${key}: table Signal ${id}`);
    for (const view of state.visualizeViews) {
      if (view.kind === 'trajectory') { for (const series of view.settings.trajectorySeries) for (const id of [series.xId, series.yId, series.zId].filter(Boolean)) assert.ok(units.has(id), `${key} / ${view.name}: ${id}`); continue; }
      const axes = new Set<string>(view.settings.chartGroupLayout.flat());
      for (const id of view.settings.chartSelectedIds) {
        assert.ok(units.has(id), `${key} / ${view.name}: ${id}`);
        const unit = units.get(id)?.trim(); const conversion = resolveDisplayUnit(unit);
        const axis = conversion ? `family:${conversion.family}` : unit ? `unit:${unit.toLowerCase()}` : 'empty';
        assert.ok(axes.has(axis), `${key} / ${view.name}: ${id} (${unit}) is on axis ${axis}, not in ${[...axes].join(', ')}`);
      }
      assert.ok(axes.size <= 2, `${key} / ${view.name}: at most two unit systems on real-value axes`);
    }
  }
});

test('every log opens with views whose Signals are in that log', async () => {
  // Each log of the sample, with the view settings it opens with in each place it is listed.
  const levels = new Map(LEVELS.map((folder) => [folder, readLevel(folder)]));
  const chain = (...folders: string[]) => folders.flatMap((folder) => levels.get(folder)!.frames);
  const groupView = (folder: string) => levels.get(folder)!.viewStates['group-view'];
  const cases: Array<[string, unknown, readonly ManualFrame[]]> = [
    ['sigmixa-basic.asc', levels.get('')!.viewStates['log-view-default'], chain('')],
    ['sigmixa-basic.asc', groupView('brake-analysis'), chain('brake-analysis', '')],
    ['brake-analysis/bench-test.asc', groupView('brake-analysis'), chain('brake-analysis', '')],
    ['brake-analysis/road-test.asc', groupView('brake-analysis'), chain('brake-analysis', '')],
    ['parking-drive/parking-garage.asc', groupView('parking-drive'), chain('parking-drive', '')],
  ];
  for (const [log, state, frames] of cases) {
    const present = new Set<number>();
    await parseAscFile(path.join(workspace, log), { sourceId: `views:${log}`, onFrames: (items) => { for (const frame of items) present.add(frame.canId); } });
    const signalFrame = new Map<string, number>(); for (const frame of [...frames].reverse()) for (const signal of [...frame.signals, ...(frame.derivedSignals ?? [])]) signalFrame.set(signal.id, frame.canId);
    const views = (state as { visualizeViews: Array<{ kind: string; name: string; settings: Record<string, any> }> }).visualizeViews;
    for (const view of views) {
      const ids: string[] = view.kind === 'graph' ? view.settings.chartSelectedIds : view.settings.trajectorySeries.flatMap((series: Record<string, string>) => [series.xId, series.yId, series.zId].filter(Boolean));
      const drawable = ids.filter((id) => id.startsWith('external:') || (id.startsWith('plugin:') && present.has(0x6a8)) || present.has(signalFrame.get(id) ?? -1));
      assert.deepEqual(drawable, ids, `${log} / ${view.name}: every Signal comes from a Frame in this log`);
    }
  }
});
