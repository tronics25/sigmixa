import { writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('sample/.sigmixa/project.json');
const formatCanId = (canId, extended) => `${canId.toString(16).toUpperCase()}${extended && canId <= 0x7ff ? 'x' : ''}`;
const extracted = (id, name, unit, byteOffset, lengthBits, scale, offset = 0, options = {}) => ({
  id, name, unit, byteOffset, bitOffset: options.bitOffset ?? 0, lengthBits,
  signedness: options.signedness ?? 'unsigned', byteOrder: options.byteOrder ?? 'little',
  conversion: { type: 'scale-offset', lsb: scale, lsbText: options.scaleText ?? String(scale), offset },
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
      extracted('sig-drive-mode', 'Drive Mode', '', 11, 3, 1),
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
      extracted('sig-headlight', 'Headlight', '', 0, 1, 1, 0, { byteOrder: 'big' }),
      extracted('sig-turn-left', 'Left Turn Signal', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 1 }),
      extracted('sig-turn-right', 'Right Turn Signal', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 2 }),
      extracted('sig-horn', 'Horn', '', 0, 1, 1, 0, { byteOrder: 'big', bitOffset: 3 }),
      extracted('sig-driver-door', 'Driver Door Open', '', 1, 1, 1, 0, { byteOrder: 'big' }),
      extracted('sig-passenger-door', 'Passenger Door Open', '', 1, 1, 1, 0, { byteOrder: 'big', bitOffset: 1 }),
      extracted('sig-seatbelt', 'Driver Seatbelt Latched', '', 1, 1, 1, 0, { byteOrder: 'big', bitOffset: 2 }),
      extracted('sig-gear-position', 'Gear Position', '', 2, 4, 1),
      extracted('sig-cabin-temperature', 'Cabin Temperature', '°C', 3, 8, 1, -40),
    ], derivedSignals: [],
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
];

const pluginBindings = [
  { id: 'plugin-binding:sample.byte-scaler:ff-2a0', pluginId: 'sample.byte-scaler', frameId: 'ff-2a0', enabled: true, automatic: true },
  { id: 'plugin-binding:sample.payload-metric:ff-2a0', pluginId: 'sample.payload-metric', frameId: 'ff-2a0', enabled: true, automatic: true },
];
const pluginSignalId = (pluginId, bindingId, signalId) => `plugin:${encodeURIComponent(pluginId)}:${encodeURIComponent(bindingId)}:${encodeURIComponent(signalId)}`;
const counterId = pluginSignalId('sample.byte-scaler', pluginBindings[0].id, 'scaled-byte');
const metricId = pluginSignalId('sample.payload-metric', pluginBindings[1].id, 'payload-metric');
const externalSignalId = (sourceId, column) => `external:${encodeURIComponent(sourceId)}:${encodeURIComponent(column)}`;
const externalSourceId = 'reference-signals';
const referenceSpeedId = externalSignalId(externalSourceId, 'Reference Speed');
const ambientTemperatureId = externalSignalId(externalSourceId, 'Ambient Temperature');
const project = {
  schemaVersion: 2,
  frames,
  plugins: [
    { id: 'sample.byte-scaler', version: '1.1.0', source: '.sigmixa/plugins/byte-scaler', enabled: true, configSchemaVersion: '1', config: { byteIndex: 10, factor: 1, label: 'Coolant Raw Byte' } },
    { id: 'sample.payload-metric', version: '1.0.0', source: '.sigmixa/plugins/payload-metric', enabled: true, configSchemaVersion: '1', config: { mode: 'average', throwOnMarker: true } },
  ],
  pluginBindings,
  externalCsvSources: [{
    id: externalSourceId,
    path: 'reference-signals.csv',
    fileName: 'reference-signals.csv',
    timestampColumn: 'Time_ms',
    timestampUnit: 'milliseconds',
    valueColumns: [
      { column: 'Reference Speed', name: 'Reference Speed', unit: 'km/h' },
      { column: 'Ambient Temperature', name: 'Ambient Temperature', unit: '°C' },
    ],
  }],
  lookupTables: [],
  calculations: [],
  viewStates: {
    'frame-definition-columns': { name: 130, unit: 75, byte: 70, bit: 62, length: 82, signed: 100, endian: 112, scale: 180, offset: 90, actions: 52, derivedName: 180, derivedUnit: 90, derivedType: 160, definition: 520, derivedActions: 52 },
    'log-view-default': {
      tableSelectedIds: ['sig-speed', 'sig-engine-speed', 'sig-engine-torque', 'sig-mechanical-power', 'sig-brake-pressure', 'sig-wheel-speed-difference', 'sig-headlight', 'sig-gear-position', 'sig-object-distance', 'sig-time-to-collision', counterId, metricId],
      tableWidths: { time: 118, 'sig-speed': 130, 'sig-engine-speed': 130, 'sig-accelerator': 145, 'sig-engine-torque': 135, 'sig-coolant-temp': 150, 'sig-mechanical-power': 140, 'sig-brake-pressure': 130, 'sig-pedal': 145, 'sig-wheel-speed-difference': 180, 'sig-headlight': 110, 'sig-gear-position': 120, 'sig-object-distance': 130, 'sig-relative-speed': 130, 'sig-time-to-collision': 130, [counterId]: 140, [metricId]: 140 },
      chartSelectedIds: ['sig-speed', 'sig-smoothed-speed', referenceSpeedId, 'sig-engine-speed', 'sig-engine-torque', 'sig-brake-pressure', 'sig-temp', ambientTemperatureId, 'sig-yaw-rate', 'sig-lateral-accel', 'sig-object-distance', 'sig-time-to-collision'],
      chartColors: { 'sig-speed': '#2563eb', 'sig-smoothed-speed': '#0891b2', [referenceSpeedId]: '#f97316', 'sig-engine-speed': '#7c3aed', 'sig-accelerator': '#84cc16', 'sig-engine-torque': '#dc2626', 'sig-mechanical-power': '#eab308', 'sig-brake-pressure': '#ef4444', 'sig-wheel-speed-fl': '#0ea5e9', 'sig-wheel-speed-fr': '#22c55e', 'sig-temp': '#a855f7', 'sig-ambient-can': '#f59e0b', [ambientTemperatureId]: '#16a34a', 'sig-yaw-rate': '#ec4899', 'sig-lateral-accel': '#14b8a6', 'sig-object-distance': '#3b82f6', 'sig-relative-speed': '#f43f5e', 'sig-time-to-collision': '#8b5cf6', [counterId]: '#7c3aed', [metricId]: '#0891b2' },
      chartMode: 'raw', chartPaneWidth: 270, chartPaneCollapsed: false,
      trajectoryXId: 'sig-position-x', trajectoryYId: 'sig-position-y', trajectoryZId: 'sig-position-z',
      trajectoryInvert: { x: false, y: false, z: false }, trajectoryEqualAspect: true,
      trajectoryTrail: 'all', trajectoryTrailSeconds: 10, trajectorySpeed: 1,
    },
  },
};

const persistedProject = { ...project, frames: project.frames.map(({ canId, extended, ...frame }) => ({ ...frame, canId: formatCanId(canId, extended) })) };
writeFileSync(output, `${JSON.stringify(persistedProject, null, 2)}\n`, 'utf8');
console.log(`Generated ${output}: ${frames.length} frames / ${frames.reduce((sum, frame) => sum + frame.signals.length, 0)} extracted Signals / ${frames.reduce((sum, frame) => sum + frame.derivedSignals.length, 0)} Derived Signals / 2 Plugins / 1 External CSV`);
