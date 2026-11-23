import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extracted, persistFrame } from './sample-frames.mjs';
import { canKey, distribution, fileView, frameInterval, frameTiming, graph, logView, pinned, stateTimeline, TRACE_COLUMNS, trajectory } from './sample-views.mjs';

// sample/city-drive: one three-minute drive, made to look good: start, city streets with two stops and two turns, a highway
// merge, hard braking behind a car ahead, and a stop. It uses the common frame definitions (2A0, 300, 310, 1A1, 5A0) and
// adds only 1D0, the position on the route (the common position frames reach only ±327 m).
const folder = path.resolve('sample/city-drive');
const DURATION = 180;

const smooth = (u) => u <= 0 ? 0 : u >= 1 ? 1 : (1 - Math.cos(u * Math.PI)) / 2;
/** Value at `time` from [time, value] keys, eased between them (no jumps in rate at a key). */
function keyed(keys, time) {
  if (time <= keys[0][0]) return keys[0][1];
  for (let index = 1; index < keys.length; index++) {
    const [t0, v0] = keys[index - 1]; const [t1, v1] = keys[index];
    if (time <= t1) return v0 + (v1 - v0) * smooth((time - t0) / (t1 - t0));
  }
  return keys[keys.length - 1][1];
}
const between = (time, start, end) => time >= start && time < end;
const blink = (time, start, end) => between(time, start, end) && Math.floor((time - start) * 3) % 2 === 0;

// Speed in km/h: two stops at lights, a left and a right turn, the merge to 100 km/h, hard braking at 140.4 s.
const SPEED = [[0, 0], [6, 0], [14, 40], [24, 42], [31, 0], [38, 0], [41, 18], [48, 18], [56, 50], [64, 50], [71, 0], [80, 0], [83, 16], [88, 16],
  [93, 40], [108, 100], [112.3, 100], [113.6, 94], [116.5, 100], [140.4, 100], [143.6, 40], [150, 45], [168, 0], [DURATION, 0]];
const cruise = (time) => between(time, 116.5, 140.4) ? 1.2 * Math.sin((time - 116.5) / 5) * Math.sin((time - 116.5) / 23.9 * Math.PI) ** 2 : 0;
const speedAt = (time) => keyed(SPEED, time) + cruise(time);
// Heading in degrees, anticlockwise from east: left turn, right turn, the ramp curving right, a gentle highway bend.
const HEADING = [[0, 0], [41, 0], [48, 90], [81, 90], [88, 0], [94, 0], [102, -40], [110, -40], [119, -12], [128, -12], [137, -38], [DURATION, -38]];
const GRADE = [[0, 0], [94, 0], [97, 4], [101, 4], [104, 0], [DURATION, 0]];
// The car ahead cuts in 22 m ahead at 112 s (we brake lightly), pulls away, then runs a little slower than us, brakes hard
// at 139.5 s and stops ahead of us.
const LEAD = [[112, 104], [122, 107], [128, 97], [139.5, 97], [142.5, 38], [150, 46], [166.5, 0], [DURATION, 0]];

const RATIOS = [3.5, 2.1, 1.4, 1.0, 0.8, 0.65]; const FINAL = 3.9; const WHEEL = 0.31;
const DT = 0.01;
const states = [];
let x = 0; let y = 0; let distance = 0; let gap = 22; let gear = 0; let shiftedAt = -10; let rpm = 0; let accelerator = 0; let pedal = 0;
for (let step = 0; step * DT <= DURATION + 1e-9; step++) {
  const time = step * DT;
  const speed = speedAt(time); const ms = speed / 3.6;
  const accel = (speedAt(time + DT) - speedAt(time - DT)) / 3.6 / (2 * DT);
  const heading = keyed(HEADING, time); const yaw = (keyed(HEADING, time + DT) - keyed(HEADING, time - DT)) / (2 * DT);
  x += ms * Math.cos(heading * Math.PI / 180) * DT; y += ms * Math.sin(heading * Math.PI / 180) * DT; distance += ms * DT;
  const engineOn = between(time, 3, 178); const geared = between(time, 5, 172);
  // Accelerator and brake follow the acceleration; the brake holds the car at a stop.
  const wantAccelerator = !geared ? 0 : ms < 0.05 ? (accel > 0.05 ? 12 + accel * 22 : 0) : Math.max(0, 4 + ms * 0.5 + accel * 25);
  accelerator += (Math.min(100, wantAccelerator) - accelerator) * Math.min(1, DT / 0.2);
  // Slowing to a stop, the brake stays on through the last metres, so it never lets go just before the car halts.
  const pressure = Math.max(accel < -0.4 ? (-accel - 0.4) * 13 : 0, geared && (ms < 0.05 || (accel < 0 && ms < 4)) ? 15 : 0);
  pedal += ((pressure > 0 ? 8 + pressure * 0.65 : 0) - pedal) * Math.min(1, DT / 0.08);
  // An automatic gearbox: up at a speed that rises with the accelerator, down below 1100 rpm.
  const gearRpm = (index) => ms * RATIOS[index] * FINAL / WHEEL * 60 / (2 * Math.PI);
  // A gear is held at least 1.5 s, so the box does not hunt.
  if (ms < 0.3) gear = 0;
  else if (time - shiftedAt > 1.5) {
    if (gear < 5 && accel > 0.05 && gearRpm(gear) > 1400 + accelerator * 18) { gear++; shiftedAt = time; }
    else if (gear < 5 && accel <= 0.05 && gearRpm(gear + 1) > 1150) { gear++; shiftedAt = time; }
    // Braking, the box holds its gear (the converter slips) and drops to 1st only near a stop, so no gear is held for a moment.
    else if (gear > 0 && accel < -0.3) { if (ms < 3) { gear = 0; shiftedAt = time; } }
    else if (gear > 0 && gearRpm(gear) < 1000) { gear--; shiftedAt = time; }
  }
  // The torque converter lets the engine run above the gear's speed when pulling away.
  const wantRpm = !engineOn ? 0 : Math.max(750, gearRpm(gear), gear === 0 && accel > 0.05 ? 900 + accelerator * 14 : 0);
  rpm += (wantRpm - rpm) * Math.min(1, DT / 0.15);
  const lead = keyed(LEAD, time) / 3.6;
  if (time >= 112) gap += (lead - ms) * DT;
  states.push({ time, speed, ms, accel, heading, yaw, x, y, distance, gear, rpm, accelerator, pressure, pedal, engineOn, geared, gap, lead });
}
const at = (time) => states[Math.min(states.length - 1, Math.round(time / DT))];

function hex(value, width = 2) { return Math.max(0, Math.round(value)).toString(16).toUpperCase().padStart(width, '0'); }
function put16(payload, offset, value) { const raw = Math.max(0, Math.min(0xffff, Math.round(value))); payload[offset] = raw & 0xff; payload[offset + 1] = raw >> 8; }
function putSigned16(payload, offset, value) { const raw = Math.max(-32768, Math.min(32767, Math.round(value))) & 0xffff; payload[offset] = raw & 0xff; payload[offset + 1] = raw >>> 8; }
function put32(payload, offset, value) { const raw = Math.round(value) >>> 0; for (let index = 0; index < 4; index++) payload[offset + index] = raw >>> index * 8 & 0xff; }
const lines = [];
// Frames arrive a little early or late (a fixed sequence, so the log is the same each time it is generated).
let seed = 7; const jitter = (ms) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 2 * ms / 1000; };
const classic = (time, id, payload) => lines.push({ time, line: `${time.toFixed(6).padStart(11)} 1  ${id.padEnd(15)} Rx   d ${payload.length} ${payload.map((value) => hex(value)).join(' ')}` });
const fd = (time, id, payload, name) => lines.push({ time, line: `${time.toFixed(6).padStart(11)} CANFD   1 Rx ${id} ${name} 1 0 F ${payload.length} ${payload.map((value) => hex(value)).join(' ')}` });

for (let index = 0; index * 0.1 <= DURATION + 1e-9; index++) {
  const time = index * 0.1; const s = at(time);
  // 2A0 Vehicle Powertrain Status (CAN FD, 64 bytes).
  const powertrain = new Array(64).fill(0);
  const cranking = between(time, 3, 3.4);
  put16(powertrain, 0, s.speed * 100);
  put16(powertrain, 2, (!s.engineOn ? 12.4 : cranking ? 10.8 : 14.1 + Math.sin(time / 7) * 0.08) * 100);
  put16(powertrain, 4, s.rpm / 0.25);
  put16(powertrain, 6, s.accelerator * 10);
  putSigned16(powertrain, 8, (!s.engineOn ? 0 : s.accelerator > 1 ? 20 + s.accelerator * 2.4 : s.ms > 0.5 ? -15 : 5) * 10);
  powertrain[10] = Math.round((time >= 3 ? 35 + 55 * (1 - Math.exp(-Math.max(0, time - 3) / 70)) : 35) + 40);
  powertrain[11] = s.geared ? 3 : s.engineOn ? 1 : 0;
  put32(powertrain, 12, (12345.6 + s.distance / 1000) * 10);
  put16(powertrain, 40, (30 + 45 * (1 - Math.exp(-Math.max(0, time - 3) / 90)) + s.accelerator * 0.05 + 40) * 10);
  fd(time + 0.002 + jitter(1.5), '2A0', powertrain, 'VehicleDynamics');
  // 310 Body Control Status.
  const flags = (blink(time, 36.5, 48.5) ? 0x40 : 0) | (blink(time, 76.5, 88.5) || blink(time, 101, 106) ? 0x20 : 0) | (between(time, 140.6, 141.2) ? 0x10 : 0);
  const body = (time < 1.5 || time >= 175 ? 0x80 : 0) | (between(time, 2, 174) ? 0x20 : 0);
  classic(time + 0.005, '310', [flags, body, s.geared ? 3 : 0, Math.round(23 + Math.sin(time / 40) + 40), 0, 0, 0, 0]);
  // 5A0 ADAS Object Summary: the car ahead.
  // Sent while a car ahead is tracked.
  if (between(time, 112, 170)) {
    const adas = new Array(8).fill(0);
    put16(adas, 0, s.gap * 10); putSigned16(adas, 2, (s.lead - s.ms) * 100);
    putSigned16(adas, 4, (Math.sin(time / 3) * 0.6 + (between(time, 124, 134) ? 2 * Math.sin((time - 124) / 10 * Math.PI) : 0)) * 100);
    adas[6] = Math.round((94 + Math.sin(time / 4) * 4) / 0.5); adas[7] = 1;
    classic(time + 0.0065, '5A0x', adas);
  }
  // 2B0 Drive Status: the states the views show under their graphs.
  const ttc = s.gap / Math.max(s.ms - s.lead, 0.01);
  const roadType = time < 6 ? 0 : time < 92 ? 1 : time < 108 ? 2 : time < 150 ? 3 : 4;
  const brakePhase = between(time, 141.3, 142.9) ? 4 : s.pressure > 40 ? 3 : s.pressure > 0 && s.ms >= 0.05 ? 2 : s.pressure > 0 ? 1 : 0;
  const warning = !between(time, 112, 170) ? 0 : between(time, 139.6, 143.6) ? 3 : ttc < 3 || s.gap < 30 && s.ms > 15 ? 2 : 1;
  classic(time + 0.007, '2B0', [s.geared ? s.gear + 1 : 0, roadType, brakePhase, warning, 0, 0, 0, 0]);
  // 1D0 Route Position.
  const route = new Array(8).fill(0); put32(route, 0, s.x * 100); put32(route, 4, s.y * 100);
  classic(time + 0.008, '1D0', route);
}
for (let index = 0; index * 0.05 <= DURATION + 1e-9; index++) {
  // 1A1 Vehicle Motion (expected every 50 ms).
  const time = index * 0.05; const s = at(time);
  const steering = s.ms > 0.5 ? 15 * Math.atan(2.7 * s.yaw * Math.PI / 180 / s.ms) * 180 / Math.PI : 0;
  const motion = new Array(8).fill(0);
  put16(motion, 0, s.speed * 100); putSigned16(motion, 2, s.yaw * 100); putSigned16(motion, 4, steering * 10); putSigned16(motion, 6, keyed(GRADE, time) * 100);
  // The motion sensor drops out for 0.7 s on the highway: Frame timing and Receive interval show it.
  if (!between(time, 119, 119.7)) classic(time + 0.004 + jitter(3), '1A1', motion);
}
for (let index = 0; index * 0.02 <= DURATION + 1e-9; index++) {
  // 300 Brake and Wheel Speed: the inner front wheel turns slower, and ABS pulses the wheels in the hard braking.
  const time = index * 0.02; const s = at(time);
  const turn = s.yaw * Math.PI / 180 * 0.8 * 3.6;
  const abs = (phase) => between(time, 141.3, 142.9) ? 1 - 0.12 * Math.max(0, Math.sin((time - 141.3) * 2 * Math.PI * 3 + phase)) : 1;
  const brake = new Array(8).fill(0);
  put16(brake, 0, s.pressure * 10); put16(brake, 2, s.pedal * 10);
  put16(brake, 4, Math.max(0, s.speed - turn) * abs(0) * 100); put16(brake, 6, Math.max(0, s.speed + turn) * abs(0.25) * 100);
  classic(time + 0.005 + jitter(1), '300', brake);
}
lines.sort((a, b) => a.time - b.time);
mkdirSync(folder, { recursive: true });
const header = ['date Sat Sep 5 10:00:00.000 2026', 'base hex  timestamps absolute', 'internal events logged', '// City drive: start, city streets, a highway merge, hard braking behind a car ahead, and a stop.'];
writeFileSync(path.join(folder, 'drive.asc'), [...header, ...lines.map((item) => item.line), ''].join('\n'), 'utf8');
const ahead = states.filter((s) => s.time >= 112 && s.time < 170);
console.log(`Generated ${path.join(folder, 'drive.asc')}: ${lines.length} Frames, ${(states.at(-1).distance / 1000).toFixed(2)} km, closest car ahead ${Math.min(...ahead.map((s) => s.gap)).toFixed(1)} m, top gear ${Math.max(...states.map((s) => s.gear)) + 1}`);

// The group's definitions and views.
const routeFrame = { id: 'ff-1d0', canId: 0x1d0, extended: false, name: 'Route Position', frameLength: 8, origin: { type: 'manual' }, expectedPeriodMs: 100, derivedSignals: [], signals: [
  extracted('sig-route-x', 'Route X', 'm', 0, 32, 0.01, 0, { signedness: 'signed' }), extracted('sig-route-y', 'Route Y', 'm', 4, 32, 0.01, 0, { signedness: 'signed' }),
] };
const statusFrame = { id: 'ff-2b0', canId: 0x2b0, extended: false, name: 'Drive Status', frameLength: 8, origin: { type: 'manual' }, expectedPeriodMs: 100, derivedSignals: [], signals: [
  extracted('sig-transmission-gear', 'Transmission Gear', '', 0, 8, 1, 0, { valueLabels: { 0: 'P', 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th' } }),
  extracted('sig-road-type', 'Road Type', '', 1, 8, 1, 0, { valueLabels: { 0: 'Parked', 1: 'City', 2: 'On-Ramp', 3: 'Highway', 4: 'Off-Ramp' } }),
  extracted('sig-brake-phase', 'Brake Phase', '', 2, 8, 1, 0, { valueLabels: { 0: 'Released', 1: 'Holding', 2: 'Braking', 3: 'Hard Braking', 4: 'ABS Active' } }),
  extracted('sig-collision-warning', 'Forward Collision Warning', '', 3, 8, 1, 0, { valueLabels: { 0: 'No Car Ahead', 1: 'Car Ahead', 2: 'Closing In', 3: 'Collision Warning' } }),
] };
const lanes = { lanes: true };
const project = {
  schemaVersion: 4, frames: [persistFrame(statusFrame), persistFrame(routeFrame)], plugins: [], pluginBindings: [], externalCsvSources: [], lookupTables: [], calculations: [],
  clips: [
    { id: 'clip-highway-merge', name: 'Highway Merge', sourcePath: 'drive.asc', sourceFileName: 'drive.asc', range: { start: 90, end: 128 } },
    { id: 'clip-hard-braking', name: 'Hard Braking', sourcePath: 'drive.asc', sourceFileName: 'drive.asc', range: { start: 136, end: 152 } },
  ],
  viewStates: {
    // The log's own views: the powertrain and electrics behind the drive, and how its frames arrived (the motion sensor
    // drops out for 0.7 s).
    'log:drive.asc': fileView([
      graph('view-power', 'Engine Torque and Mechanical Power', ['sig-engine-torque', 'sig-mechanical-power'], ['family:torque', 'family:power'], 240),
      graph('view-temperatures', 'Coolant and Motor Temperature', ['sig-coolant-temp', 'sig-temp'], ['family:temperature'], 200),
      graph('view-battery', 'Battery Voltage', ['sig-batt'], ['family:voltage'], 180),
      stateTimeline('view-power-states', 'Drive Mode', ['sig-drive-mode']),
      frameTiming('view-frame-timing', 'Frame Timing'),
      frameInterval('view-motion-interval', 'Motion Sensor Receive Interval', [canKey(0x1a1)]),
    ]),
    'group-view': logView([
      // Each graph has a state timeline under it that says what state the graph is in.
      // What happened: speed and engine speed, with the road and the gear (the engine speed drops at each upshift).
      graph('view-overview', 'Speed and Engine Speed', ['sig-speed', 'sig-engine-speed'], ['family:speed', 'family:rotational-speed'], 300),
      stateTimeline('view-overview-states', 'Road and Gear', ['sig-road-type', 'sig-transmission-gear']),
      // Why: the driver's inputs, with the drive mode and the selector.
      graph('view-inputs', 'Accelerator and Brake Pedal', ['sig-accelerator', 'sig-pedal'], ['family:percentage'], 200),
      stateTimeline('view-input-states', 'Drive Mode and Selector', ['sig-drive-mode', 'sig-gear-position', 'sig-seatbelt', 'sig-driver-door']),
      // The turns: the inner front wheel runs slower as the steering wheel turns.
      graph('view-turns', 'Steering Angle and Front Wheel Speed Difference', ['sig-steering-angle', 'sig-wheel-speed-difference'], ['family:angle', 'family:speed'], 220),
      stateTimeline('view-turn-states', 'Turn Signals', ['sig-turn-left', 'sig-turn-right']),
      // The hard braking: the car ahead closes in, the warning, the brake pressure, and ABS pulsing the front wheels.
      graph('view-car-ahead', 'Distance and Relative Speed to the Car Ahead', ['sig-object-distance', 'sig-relative-speed'], ['family:length', 'family:speed'], 220),
      stateTimeline('view-warning-states', 'Forward Collision Warning', ['sig-collision-warning', 'sig-horn']),
      graph('view-braking', 'Brake Pressure and Front Wheel Speeds', ['sig-brake-pressure', 'sig-wheel-speed-fl', 'sig-wheel-speed-fr'], ['family:pressure', 'family:speed'], 240),
      stateTimeline('view-brake-states', 'Brake Phase', ['sig-brake-phase']),
      trajectory('view-route', 'Route from Above (2D)', [{ id: 'series-route', name: 'Vehicle', xId: 'sig-route-x', yId: 'sig-route-y' }], { height: 420 }),
      distribution('view-profile', 'Driving Profile', ['sig-speed', 'sig-engine-speed', 'sig-accelerator']),
    ], {
      tableSelectedIds: ['sig-speed', 'sig-engine-speed', 'sig-accelerator', 'sig-pedal', 'sig-brake-pressure', 'sig-gear-position', 'sig-steering-angle', 'sig-object-distance', 'sig-relative-speed'],
      traceSettings: { pinnedIds: pinned(0x300, 0x1a1), defaultMode: 'decoded', columns: TRACE_COLUMNS, sort: 'canId', descending: false },
    }),
  },
};
mkdirSync(path.join(folder, '.sigmixa'), { recursive: true });
writeFileSync(path.join(folder, '.sigmixa', 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
console.log(`Generated ${path.join(folder, '.sigmixa', 'project.json')}`);
