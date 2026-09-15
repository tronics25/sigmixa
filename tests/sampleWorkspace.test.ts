import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { migrateProject } from '../src/core/project/schema';
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

const workspace = path.resolve('sample');

test('showcase Clips reference available log ranges and Signals', () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  assert.equal(project.clips.length, 2);
  const signalIds = new Set(project.frames.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signal.id)));
  for (const source of project.externalCsvSources) for (const column of source.valueColumns) signalIds.add(externalSignalId(source.id, column.column));
  const pluginPrefixes = project.pluginBindings.map((binding) => `plugin:${encodeURIComponent(binding.pluginId)}:${encodeURIComponent(binding.id)}:`);
  for (const clip of project.clips) {
    assert.ok(existsSync(path.join(workspace, clip.sourcePath)));
    assert.ok(clip.endTimestamp > clip.startTimestamp);
    assert.ok(clip.signalIds.length > 0 && clip.signalIds.every((id) => signalIds.has(id) || pluginPrefixes.some((prefix) => id.startsWith(prefix))));
  }
});

test('sample workspace persists seven valid automotive Manual Frames', () => {
  const persisted = JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')) as { schemaVersion: number; frames: Array<Record<string, unknown>> };
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.frames.filter((frame) => (frame.origin as { type?: string } | undefined)?.type === 'manual').length, 7);
  assert.ok(persisted.frames.every((frame) => typeof frame.canId === 'string' && !('extended' in frame)));
  const project = migrateProject(persisted);
  for (const frame of project.frames.filter((candidate) => candidate.origin?.type === 'manual')) {
    assert.deepEqual(validateFrameDefinition(frame).diagnostics, []);
  }
  assert.deepEqual(project.frames.filter((frame) => frame.origin?.type === 'manual').map((frame) => frame.id), ['ff-2a0', 'ff-300', 'ff-310', 'ff-320', 'ff-184', 'ff-18ff50e5', 'ff-5a0x']);
  const multiplexed = project.frames.find((frame) => frame.id === 'ff-320');
  assert.equal(multiplexed?.multiplexing, true);
  assert.deepEqual(multiplexed?.signals[0].valueLabels, { 0: 'Torque', 1: 'Power', 2: 'Regeneration' });
  assert.deepEqual(project.frames.find((frame) => frame.id === 'ff-310')?.signals.find((signal) => signal.id === 'sig-gear-position')?.valueLabels, { 0: 'Park', 1: 'Neutral', 3: 'Drive' });
  assert.ok(project.viewStates['log-view-default']);
});

test('showcase DBC imports value labels and Multiplexing without errors', () => {
  const result = importDbc(readFileSync(path.join(workspace, 'sigmixa-showcase.dbc'), 'utf8'), 'sigmixa-showcase.dbc');
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

test('showcase ASC exercises parser boundaries and visible Signal ranges', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const definitions = new Map(project.frames.map((frame) => [frame.canId, frame]));
  const values = new Map<string, number[]>();
  const manualContext = createManualDecodeContext();
  const observed = new Set<string>();
  const observedIds = new Set<string>();
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-showcase.asc'), {
    sourceId: 'showcase', batchSize: 127,
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

test('showcase runs two public Plugins on one Frame and isolates the deliberate failure marker', async () => {
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
  await parseAscFile(path.join(workspace, 'sigmixa-showcase.asc'), {
    sourceId: 'plugin-showcase',
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

test('showcase overlays non-zero External CSV timestamps without Table merging', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  assert.equal(project.externalCsvSources.length, 1); assert.equal(project.calculations.length, 0); assert.equal(project.lookupTables.length, 0);
  const store = new InMemorySignalStore();
  store.registerDefinitions(project.frames.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signalDefinitionFor(frame, signal))));
  const definitions = new Map(project.frames.map((frame) => [`${frame.extended ? 'e' : 's'}:${frame.canId}`, frame]));
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-showcase.asc'), {
    sourceId: 'csv-showcase',
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

test('showcase decodes an effective synchronized 3D Trajectory', async () => {
  const project = migrateProject(JSON.parse(readFileSync(path.join(workspace, '.sigmixa/project.json'), 'utf8')));
  const definition = project.frames.find((frame) => frame.id === 'ff-184');
  assert.ok(definition); assert.equal(definition.frameLength, 16);
  assert.deepEqual(definition.signals.slice(0, 3).map((signal) => signal.id), ['sig-position-x', 'sig-position-y', 'sig-position-z']);
  assert.deepEqual(definition.signals.slice(3).map((signal) => signal.id), ['sig-heading', 'sig-yaw-rate', 'sig-lateral-accel']);
  assert.deepEqual(validateFrameDefinition(definition).diagnostics, []);
  const samples = new Map(definition.signals.map((signal) => [signal.id, [] as Array<{ timestamp: number; value: number }>]));
  const summary = await parseAscFile(path.join(workspace, 'sigmixa-showcase.asc'), {
    sourceId: 'trajectory-showcase',
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
