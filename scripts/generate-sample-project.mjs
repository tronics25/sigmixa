import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canKey, distribution, fileView, frameInterval, frameTiming, graph, logView, pinned, stateTimeline, TRACE_COLUMNS, trajectory } from './sample-views.mjs';
import { parkingFrames } from './sample-frames.mjs';

const output = path.resolve('sample/.sigmixa/project.json');
const basicOutput = path.resolve('sample/basic/.sigmixa/project.json');
const formatCanId = (canId, extended) => `${canId.toString(16).toUpperCase()}${extended && canId <= 0x7ff ? 'x' : ''}`;
const extracted = (id, name, unit, byteOffset, lengthBits, scale, offset = 0, options = {}) => ({
  id, name, unit, byteOffset, bitOffset: options.bitOffset ?? 0, lengthBits,
  signedness: options.signedness ?? 'unsigned', byteOrder: options.byteOrder ?? 'little',
  conversion: { type: 'scale-offset', lsb: scale, lsbText: options.scaleText ?? String(scale), offset },
  ...(options.valueLabels ? { valueLabels: options.valueLabels } : {}),
  ...(options.multiplexing ? { multiplexing: options.multiplexing } : {}),
});

const frames = [
  {
    id: 'ff-2a0', canId: 0x2a0, extended: false, name: 'Vehicle Powertrain Status', frameLength: 64, origin: { type: 'manual' },
    signals: [
      extracted('sig-speed', 'Vehicle Speed', 'km/h', 0, 16, 0.01),
      extracted('sig-batt', 'Battery Voltage', 'V', 2, 16, 0.01),
      extracted('sig-engine-speed', 'Engine Speed', 'rpm', 4, 16, 0.25),
      extracted('sig-accelerator', 'Accelerator Position', '%', 6, 16, 0.1),
      extracted('sig-engine-torque', 'Engine Torque', 'Nm', 8, 16, 0.1, 0, { signedness: 'signed' }),
      extracted('sig-coolant-temp', 'Coolant Temperature', '°C', 10, 8, 1, -40),
      extracted('sig-drive-mode', 'Drive Mode', '', 11, 3, 1, 0, { valueLabels: { 0: 'Off', 1: 'Ready', 3: 'Drive' } }),
      extracted('sig-odometer', 'Odometer', 'km', 12, 32, 0.1),
      extracted('sig-temp', 'Motor Temperature', '°C', 40, 16, 0.1, -40),
    ],
    derivedSignals: [
      { id: 'sig-corrected-speed', name: 'Voltage Corrected Speed', unit: 'km/h', operation: { type: 'expression', expression: '[Vehicle Speed] * [Battery Voltage] / 12' } },
      { id: 'sig-corrected-speed-rate', name: 'Vehicle Speed Percent', unit: '%', operation: { type: 'expression', expression: 'clamp([Voltage Corrected Speed] / 1.2, 0, 100)' } },
      { id: 'sig-speed-grade', name: 'Speed Zone', unit: '', operation: { type: 'lookup', input: 'Voltage Corrected Speed', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 30, output: 1 }, { input: 60, output: 2 }, { input: 120, output: 3 }, { input: 160, output: 4 }] } },
      { id: 'sig-smoothed-speed', name: 'Filtered Vehicle Speed', unit: 'km/h', operation: { type: 'filter', input: 'Vehicle Speed', filter: 'low-pass', timeSeconds: 0.5 } },
      { id: 'sig-average-accelerator', name: 'Average Accelerator Position', unit: '%', operation: { type: 'filter', input: 'Accelerator Position', filter: 'moving-average', timeSeconds: 1 } },
      { id: 'sig-mechanical-power', name: 'Mechanical Power', unit: 'kW', operation: { type: 'expression', expression: '[Engine Torque] * [Engine Speed] * 0.00010472' } },
      { id: 'sig-power-utilization', name: 'Power Utilization', unit: '%', operation: { type: 'expression', expression: 'clamp(abs([Mechanical Power]) / 0.8, 0, 100)' } },
    ],
  },
  {
    id: 'ff-300', canId: 0x300, extended: false, name: 'Brake and Wheel Speed', frameLength: 8, origin: { type: 'manual' },
    signals: [
      extracted('sig-brake-pressure', 'Brake Pressure', 'bar', 0, 16, 0.1),
      extracted('sig-pedal', 'Brake Pedal Position', '%', 2, 16, 0.1),
      extracted('sig-wheel-speed-fl', 'Front Left Wheel Speed', 'km/h', 4, 16, 0.01),
      extracted('sig-wheel-speed-fr', 'Front Right Wheel Speed', 'km/h', 6, 16, 0.01),
    ],
    derivedSignals: [
      { id: 'sig-wheel-speed-difference', name: 'Front Wheel Speed Difference', unit: 'km/h', operation: { type: 'expression', expression: 'abs([Front Left Wheel Speed] - [Front Right Wheel Speed])' } },
      { id: 'sig-brake-level', name: 'Brake Level', unit: '', operation: { type: 'lookup', input: 'Brake Pressure', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 20, output: 1 }, { input: 60, output: 2 }, { input: 120, output: 3 }] } },
      { id: 'sig-smoothed-brake-pressure', name: 'Smoothed Brake Pressure', unit: 'bar', operation: { type: 'filter', input: 'Brake Pressure', filter: 'low-pass', timeSeconds: 0.4 } },
    ],
  },
  {
    id: 'ff-310', canId: 0x310, extended: false, name: 'Body Control Status', frameLength: 8, origin: { type: 'manual' },
    signals: [
      extracted('sig-headlight', 'Headlight', '', 0, 1, 1, 0, { byteOrder: 'big', valueLabels: { 0: 'Off', 1: 'On' } }),
      extracted('sig-turn-left', 'Left Turn Signal', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 1, valueLabels: { 0: 'Off', 1: 'On' } }),
      extracted('sig-turn-right', 'Right Turn Signal', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 2, valueLabels: { 0: 'Off', 1: 'On' } }),
      extracted('sig-horn', 'Horn', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 3, valueLabels: { 0: 'Off', 1: 'On' } }),
      extracted('sig-driver-door', 'Driver Door Open', '', 1, 1, 1, 0, { byteOrder: 'big', valueLabels: { 0: 'Closed', 1: 'Open' } }),
      extracted('sig-passenger-door', 'Passenger Door Open', '', 1, 1, 1, 0, { byteOrder: 'big', bitOffset: 1, valueLabels: { 0: 'Closed', 1: 'Open' } }),
      extracted('sig-seatbelt', 'Driver Seatbelt Latched', '', 1, 1, 1, 0, { byteOrder: 'big', bitOffset: 2, valueLabels: { 0: 'Unlatched', 1: 'Latched' } }),
      extracted('sig-gear-position', 'Gear Position', '', 2, 4, 1, 0, { valueLabels: { 0: 'Park', 1: 'Neutral', 3: 'Drive' } }),
      extracted('sig-cabin-temperature', 'Cabin Temperature', '°C', 3, 8, 1, -40),
    ], derivedSignals: [],
  },
  {
    id: 'ff-320', canId: 0x320, extended: false, name: 'Multiplexed Drive Status', frameLength: 8, multiplexing: true, origin: { type: 'manual' },
    signals: [
      extracted('sig-mux-mode', 'Multiplexer', '', 0, 8, 1, 0, { multiplexing: { type: 'multiplexer' }, valueLabels: { 0: 'Torque', 1: 'Power', 2: 'Regeneration' } }),
      extracted('sig-drive-state', 'Drive State', '', 1, 8, 1, 0, { valueLabels: { 0: 'Disabled', 1: 'Ready', 2: 'Driving', 3: 'Fault' } }),
      extracted('sig-requested-torque', 'Requested Torque', 'Nm', 2, 16, 0.1, 0, { signedness: 'signed', multiplexing: { type: 'conditional', ranges: [{ from: 0, to: 0 }] } }),
      extracted('sig-dc-link-power', 'DC Link Power', 'kW', 2, 16, 0.1, 0, { multiplexing: { type: 'conditional', ranges: [{ from: 1, to: 1 }] } }),
      extracted('sig-regen-limit', 'Regeneration Limit', 'kW', 2, 16, 0.1, 0, { multiplexing: { type: 'conditional', ranges: [{ from: 2, to: 2 }] } }),
    ],
    derivedSignals: [],
  },
  {
    id: 'ff-184', canId: 0x184, extended: false, name: 'Vehicle Position and Motion', frameLength: 16, origin: { type: 'manual' },
    signals: [
      extracted('sig-position-x', 'Position X', 'm', 4, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-position-y', 'Position Y', 'm', 6, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-position-z', 'Position Z', 'm', 8, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-heading', 'Heading', 'deg', 10, 16, 0.01),
      extracted('sig-yaw-rate', 'Yaw Rate', 'deg/s', 12, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-lateral-accel', 'Lateral Acceleration', 'g', 14, 16, 0.001, 0, { signedness: 'signed' }),
    ],
    derivedSignals: [
      { id: 'sig-path-radius', name: 'Path Radius', unit: 'm', operation: { type: 'expression', expression: 'sqrt([Position X] ^ 2 + [Position Y] ^ 2)' } },
      { id: 'sig-planar-position', name: 'Planar Position Mean', unit: 'm', operation: { type: 'expression', expression: '([Position X] + [Position Y]) / 2' } },
    ],
  },
  {
    id: 'ff-18ff50e5', canId: 0x18ff50e5, extended: true, name: 'Environmental Status', frameLength: 8, origin: { type: 'manual' },
    signals: [
      extracted('sig-ambient-can', 'Ambient Temperature CAN', '°C', 0, 8, 1, -40),
      extracted('sig-barometric-pressure', 'Barometric Pressure', 'kPa', 1, 16, 0.1),
      extracted('sig-module-voltage', 'Module Supply Voltage', 'V', 3, 16, 0.01),
      extracted('sig-altitude', 'Altitude', 'm', 5, 16, 0.1, 0, { signedness: 'signed' }),
      extracted('sig-environment-counter', 'Environment Counter', '', 7, 8, 1),
    ], derivedSignals: [],
  },
  {
    id: 'ff-5a0x', canId: 0x5a0, extended: true, name: 'ADAS Object Summary', frameLength: 8, origin: { type: 'manual' },
    signals: [
      extracted('sig-object-distance', 'Object Distance', 'm', 0, 16, 0.1),
      extracted('sig-relative-speed', 'Relative Speed', 'm/s', 2, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-object-angle', 'Object Angle', 'deg', 4, 16, 0.01, 0, { signedness: 'signed' }),
      extracted('sig-object-confidence', 'Object Confidence', '%', 6, 8, 0.5),
      extracted('sig-object-valid', 'Object Valid', '', 7, 1, 1),
    ],
    derivedSignals: [
      { id: 'sig-time-to-collision', name: 'Time To Collision', unit: 's', operation: { type: 'expression', expression: '[Object Distance] / max(-[Relative Speed], 0.1)' } },
    ],
  },
  {
    // 100 ms with jitter, a 41-50 s dropout: the trace shows the stop and the interval spread.
    id: 'ff-3c0', canId: 0x3c0, extended: false, name: 'Door Module Heartbeat', frameLength: 8, expectedPeriodMs: 100, origin: { type: 'manual' },
    signals: [
      extracted('sig-heartbeat-counter', 'Heartbeat Counter', '', 0, 8, 1),
      extracted('sig-door-module-state', 'Door Module State', '', 1, 8, 1, 0, { valueLabels: { 0: 'Sleep', 1: 'Awake', 2: 'Recovered' } }),
    ],
    derivedSignals: [],
  },
  // The car park log (parking-drive/parking-garage.asc).
  ...parkingFrames(),
  // Owned by the property-service Plugin, as its registration creates them.
  { id: 'plugin-frame:sample.property-service:s:6a0', canId: 0x6a0, extended: false, name: 'Property Request', frameLength: 8, signals: [], derivedSignals: [], origin: { type: 'plugin', pluginId: 'sample.property-service' } },
  { id: 'plugin-frame:sample.property-service:s:6a8', canId: 0x6a8, extended: false, name: 'Property Response', frameLength: 8, signals: [], derivedSignals: [], origin: { type: 'plugin', pluginId: 'sample.property-service' } },
];

const pluginBindings = [
  { id: 'plugin-binding:sample.byte-scaler:ff-2a0', pluginId: 'sample.byte-scaler', frameId: 'ff-2a0', enabled: true, automatic: true },
  { id: 'plugin-binding:sample.payload-metric:ff-2a0', pluginId: 'sample.payload-metric', frameId: 'ff-2a0', enabled: true, automatic: true },
  ...['6a0', '6a8'].map((id) => ({ id: `plugin-binding:sample.property-service:${encodeURIComponent(`plugin-frame:sample.property-service:s:${id}`)}`, pluginId: 'sample.property-service', frameId: `plugin-frame:sample.property-service:s:${id}`, enabled: true, automatic: true })),
];
const pluginSignalId = (pluginId, bindingId, signalId) => `plugin:${encodeURIComponent(pluginId)}:${encodeURIComponent(bindingId)}:${encodeURIComponent(signalId)}`;
const counterId = pluginSignalId('sample.byte-scaler', pluginBindings[0].id, 'scaled-byte');
const metricId = pluginSignalId('sample.payload-metric', pluginBindings[1].id, 'payload-metric');
const propertyResponseSignal = (signalId) => pluginSignalId('sample.property-service', pluginBindings[3].id, signalId);
const propertyRequestSignal = (signalId) => pluginSignalId('sample.property-service', pluginBindings[2].id, signalId);
const propertyConfig = {
  responseTimeoutMs: 500,
  properties: [
    { id: 1, name: 'Target Cabin Temperature', unit: '°C', scale: 0.5, offset: -40 },
    { id: 2, name: 'Fan Level', unit: '', scale: 1, offset: 0 },
    { id: 3, name: 'Seat Heater Level', unit: '', scale: 1, offset: 0 },
    { id: 4, name: 'Display Brightness', unit: '%', scale: 0.5, offset: 0 },
  ],
};
// The views of the basic CAN log (and its BLF and MF4 copies).
const basicViews = logView([
      // The CAN logs' views: what the vehicle did and in what state.
      graph('view-speed-engine', 'Speed and Engine', ['sig-speed', 'sig-smoothed-speed', 'sig-engine-speed'], ['family:speed', 'family:rotational-speed']),
      stateTimeline('view-drive-states', 'Drive Mode and Gear', ['sig-drive-mode', 'sig-gear-position', 'sig-drive-state']),
      graph('view-torque-brake', 'Torque and Brake', ['sig-engine-torque', 'sig-brake-pressure'], ['family:torque', 'family:pressure']),
      // 320 is multiplexed: bytes 2-3 carry the requested torque, the DC link power or the regeneration limit.
      stateTimeline('view-mux-states', 'Multiplexer of 320', ['sig-mux-mode']),
      graph('view-temperatures', 'Temperatures', ['sig-temp', 'sig-coolant-temp'], ['family:temperature']),
      stateTimeline('view-body-states', 'Body Control', ['sig-headlight', 'sig-turn-left', 'sig-turn-right', 'sig-horn', 'sig-driver-door', 'sig-passenger-door', 'sig-seatbelt']),
      distribution('view-distribution', 'Speed, Torque and Brake', ['sig-speed', 'sig-engine-speed', 'sig-engine-torque', 'sig-brake-pressure']),
      trajectory('view-path-3d', 'Vehicle Path (3D)', [{ id: 'series-vehicle', name: 'Vehicle Position', xId: 'sig-position-x', yId: 'sig-position-y', zId: 'sig-position-z' }], { view: { yaw: 5.374, pitch: 0.419, zoom: 1.49, panX: -4.11, panY: 0.58 } }),
    ], {
      tableSelectedIds: ['sig-speed', 'sig-engine-speed', 'sig-engine-torque', 'sig-mechanical-power', 'sig-brake-pressure', 'sig-wheel-speed-difference', 'sig-headlight', 'sig-gear-position', 'sig-object-distance', 'sig-time-to-collision', counterId, metricId,
        'sig-door-module-state', propertyRequestSignal('request'), propertyResponseSignal('p2-value'), propertyResponseSignal('p2-result'), propertyResponseSignal('p2-response-time')],
      traceSettings: { pinnedIds: pinned(0x3c0, 0x6a0, 0x6a8), defaultMode: 'decoded', columns: TRACE_COLUMNS, sort: 'canId', descending: false },
    });

// Measured signals are named mdf:<group>:<channel>; a CSV log's group is empty.
const measured = (group, channel) => `mdf:${encodeURIComponent(group)}:${encodeURIComponent(channel)}`;
const decodedViews = {
  'log:sigmixa-basic-decoded.csv': { ...logView([
    graph('view-decoded', 'Decoded Speed and Coolant Temperature', [measured('', 'Vehicle Speed'), measured('', 'Coolant Temperature')], ['family:speed', 'family:temperature']),
  ], { tableSelectedIds: [measured('', 'Vehicle Speed'), measured('', 'Coolant Temperature')] }), viewStateScope: 'file' },
  'log:sigmixa-basic-decoded.mdf': { ...logView([
    graph('view-decoded', 'Decoded Speed and Coolant Temperature', [measured('Reference', 'Vehicle Speed'), measured('Reference', 'Coolant Temperature')], ['family:speed', 'family:temperature']),
    graph('view-speed-band', 'Speed Band', [measured('Reference', 'Speed Band')], ['empty'], 200),
  ], { tableSelectedIds: [measured('Reference', 'Vehicle Speed'), measured('Reference', 'Coolant Temperature'), measured('Reference', 'Speed Band')] }), viewStateScope: 'file' },
  // The MF4 log holds the CAN frames and the decoded values: the speed decoded from CAN and the stored one lie on each other.
  'log:sigmixa-basic.mf4': { ...logView([
    graph('view-speed-check', 'CAN Speed and Stored Speed', ['sig-speed', measured('Reference', 'Vehicle Speed')], ['family:speed']),
    graph('view-wheels', 'Wheel Speeds (Array)', [0, 1, 2, 3].map((wheel) => measured('Chassis', `WheelSpeed[${wheel}]`)), ['family:speed']),
    trajectory('view-position', 'Position (Structure)', [{ id: 'series-position', name: 'Position', xId: measured('Chassis', 'Position.X'), yId: measured('Chassis', 'Position.Y') }]),
  ], { tableSelectedIds: ['sig-speed', measured('Reference', 'Vehicle Speed'), measured('Reference', 'Coolant Temperature')] }), viewStateScope: 'file' },
};

// The basic ASC log's own views ("This file", which it opens with): the CAN views, its Plugins and how its frames arrive.
const basicAscViews = fileView([
  ...basicViews.visualizeViews,
      // 3C0 is expected every 100 ms, arrives with jitter and stops from 41 to 50 s.
      stateTimeline('view-door-module-states', 'Door Module State', ['sig-door-module-state']),
      frameInterval('view-intervals', 'Door Module Heartbeat Interval', [canKey(0x3c0)]),
      frameTiming('view-frame-timing', 'Frame Timing'),
      graph('view-property-service', 'Property Service', [propertyResponseSignal('p1-value'), propertyRequestSignal('p1-requested'), propertyResponseSignal('p4-value'), propertyRequestSignal('p4-requested')], ['family:temperature', 'family:percentage']),
], { tableSelectedIds: basicViews.tableSelectedIds, traceSettings: basicViews.traceSettings }, 'file');
// The BLF copy's own views: the CAN views, and the same timing as the ASC log.
const basicBlfViews = fileView([
  ...basicViews.visualizeViews,
  frameTiming('view-frame-timing', 'Frame Timing'),
  frameInterval('view-intervals', 'Door Module Heartbeat Interval', [canKey(0x3c0)]),
], { tableSelectedIds: basicViews.tableSelectedIds }, 'file');


// The basic group's shared views ("Shared in group"): the values every log here holds, whether decoded from CAN (ASC,
// BLF, MF4) or stored as measured values (CSV, MDF, MF4). Each log shows the ones it has.
const speeds = ['sig-speed', measured('', 'Vehicle Speed'), measured('Reference', 'Vehicle Speed')];
const coolant = ['sig-coolant-temp', measured('', 'Coolant Temperature'), measured('Reference', 'Coolant Temperature')];
const basicSharedViews = logView([
  graph('view-shared-speed', 'Vehicle Speed', speeds, ['family:speed'], 240),
  graph('view-shared-coolant', 'Coolant Temperature', coolant, ['family:temperature'], 200),
  distribution('view-shared-distribution', 'Speed and Coolant Temperature', [...speeds, ...coolant]),
]);

const project = {
  schemaVersion: 4,
  frames,
  plugins: [
    { id: 'sample.byte-scaler', version: '1.1.0', source: '.sigmixa/plugins/byte-scaler', enabled: true, configSchemaVersion: '1', config: { byteIndex: 10, factor: 1, label: 'Coolant Raw Byte' } },
    { id: 'sample.payload-metric', version: '1.0.0', source: '.sigmixa/plugins/payload-metric', enabled: true, configSchemaVersion: '1', config: { mode: 'average', throwOnMarker: true } },
    { id: 'sample.property-service', version: '1.0.0', source: '.sigmixa/plugins/property-service', enabled: true, configSchemaVersion: '1', config: propertyConfig },
  ],
  pluginBindings,
  externalCsvSources: [],
  clips: [],
  lookupTables: [],
  calculations: [],
  viewStates: {
    'frame-definition-columns': { name: 203, unit: 112, byte: 48, bit: 44, length: 58, signed: 96, endian: 92, scale: 100, offset: 74, minimum: 74, maximum: 74, activation: 136, actions: 32, derivedName: 235, derivedUnit: 112, derivedType: 140, definition: 520, derivedActions: 32 },
    // A log with no views of its own starts from these (2.0.0: several graphs and trajectories).
    'log-view-default': basicViews,
  },
};

// The basic logs are an analysis group of their own. They use the workspace's Frames and Plugins.
const basicProject = {
  schemaVersion: 4, frames: [], plugins: [], pluginBindings: [], externalCsvSources: [],
  // The reference values are a CSV log of their own: compare it with the basic log on the comparison screen.
  addedLogs: ['sigmixa-basic-decoded.csv'],
  // The basic log has no Clips: Clips are shown on brake-analysis/road-test.asc, which holds three trials.
  clips: [], lookupTables: [], calculations: [],
  viewStates: {
    // Its logs share these views ("Shared in group").
    'group-view': basicSharedViews,
    // The CAN logs open with their own views ("This file").
    'log:sigmixa-basic.asc': basicAscViews,
    'log:sigmixa-basic.blf': basicBlfViews,
    // Logs of decoded values show their own signals ("This file").
    ...decodedViews,
  },
};

const persistedProject = { ...project, frames: project.frames.map(({ canId, extended, ...frame }) => ({ ...frame, canId: formatCanId(canId, extended) })) };
writeFileSync(output, `${JSON.stringify(persistedProject, null, 2)}\n`, 'utf8');
mkdirSync(path.dirname(basicOutput), { recursive: true });
writeFileSync(basicOutput, `${JSON.stringify(basicProject, null, 2)}\n`, 'utf8');
console.log(`Generated ${output}: ${frames.length} frames / ${frames.reduce((sum, frame) => sum + frame.signals.length, 0)} extracted Signals / ${frames.reduce((sum, frame) => sum + frame.derivedSignals.length, 0)} Derived Signals / 0 Clips / 3 Plugins / 1 External CSV`);
