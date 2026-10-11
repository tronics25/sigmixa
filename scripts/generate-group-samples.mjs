import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brakeFrame, parkingFrames, persistFrame } from './sample-frames.mjs';
import { brakeViews, graph, logView, pinned, TRACE_COLUMNS, trajectory } from './sample-views.mjs';

// Analysis groups. Each is a folder with its own `.sigmixa`: the definitions it adds to the common ones and the views
// its logs share.
//   brake-analysis/   several logs managed as one: a road test with three trials (split into Clips), a bench test
//                     recorded separately, and the basic log added from the workspace root
//   parking-drive/    trajectories in 3D, and a Clip seen from above in 2D
const sample = path.resolve('sample');

function hex(value) { return value.toString(16).toUpperCase().padStart(2, '0'); }
function le16(value) { const raw = Math.max(0, Math.min(0xffff, Math.round(value))); return [raw & 0xff, raw >> 8]; }

function writeLog(relative, title, build) {
  const lines = ['date Sun Aug 30 14:00:00.000 2026', 'base hex  timestamps absolute', 'internal events logged', `// ${title}`];
  const frames = [];
  const classic = (time, id, payload) => frames.push({ time, line: `${time.toFixed(6).padStart(11)} 1  ${id.padEnd(15)} Rx   d ${payload.length} ${payload.map(hex).join(' ')}` });
  build(classic);
  frames.sort((a, b) => a.time - b.time);
  const file = path.join(sample, relative); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [...lines, ...frames.map((frame) => frame.line), ''].join('\n'), 'utf8');
  console.log(`Generated ${file}: ${frames.length} Frames`);
}

// Brake applications (start time, peak pressure, peak pedal travel); 300 encoded as the common definition
// (pressure 0.1 bar, pedal 0.1 %, speeds 0.01 km/h). Pressure follows the pedal 80 ms late and rises more than in
// proportion, so the pedal-to-pressure ratio changes through each stop.
function brakeTest(classic, { duration, stops, stopSeconds = 3, periodSeconds = 0.02 }) {
  const pedalAt = (time) => Math.max(0, ...stops.map((stop) => time >= stop.start && time < stop.start + stopSeconds ? stop.pedal * Math.sin((time - stop.start) / stopSeconds * Math.PI) : 0));
  const pressureAt = (time) => Math.max(0, ...stops.map((stop) => { const t = time - 0.08; return t >= stop.start && t < stop.start + stopSeconds ? stop.peak * Math.sin((t - stop.start) / stopSeconds * Math.PI) ** 1.4 : 0; }));
  for (let index = 0; index * periodSeconds <= duration + 1e-9; index++) {
    const time = index * periodSeconds; const pressure = pressureAt(time);
    const speed = Math.max(0, 60 - pressure / 4 - (time > duration - 2 ? (time - duration + 2) * 25 : 0));
    classic(time + 0.003, '300', [...le16(pressure / 0.1), ...le16(pedalAt(time) / 0.1), ...le16(speed / 0.01), ...le16(speed / 0.01)]);
  }
  for (let index = 0; 0.05 + index * 0.1 <= duration; index++) classic(0.05 + index * 0.1, '3C0', [index & 0xff, 1, 0, 0, 0, 0, 0, 0]);
}

writeLog('brake-analysis/bench-test.asc', 'Brake bench test, recorded separately: two stops.', (classic) => brakeTest(classic, { duration: 12, stops: [{ start: 2, peak: 100, pedal: 75 }, { start: 7, peak: 100, pedal: 75 }] }));
// Three trials in one recording, each braking a little differently and starting at a different point of its Clip
// (Stop 1-3 all begin at a whole second): shift them in the comparison to line up the brake application.
const ROAD_STOPS = [{ start: 3, peak: 95, pedal: 70 }, { start: 9.3, peak: 80, pedal: 62 }, { start: 15.6, peak: 112, pedal: 82 }];
const CLIP_STARTS = [2.5, 8.5, 14.5];
writeLog('brake-analysis/road-test.asc', 'Brake road test: three stops in one recording.', (classic) => brakeTest(classic, { duration: 20, stops: ROAD_STOPS }));

const level = (frames, rest = {}) => ({ schemaVersion: 4, frames: frames.map(persistFrame), plugins: [], pluginBindings: [], externalCsvSources: [], clips: [], lookupTables: [], calculations: [], viewStates: {}, ...rest });
function writeLevel(folder, project) {
  const file = path.join(sample, folder, '.sigmixa', 'project.json'); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  console.log(`Generated ${file}`);
}
const withDerived = (frame, derivedSignals, extra = {}) => ({ ...frame, ...extra, derivedSignals: [...frame.derivedSignals, ...derivedSignals] });

// Brake analysis adds how much pressure each % of pedal travel gives. Its views are shared by all its logs and Clips.
const pedalRatio = { id: 'sig-pedal-pressure-ratio', name: 'Pedal to Pressure Ratio', unit: 'bar/%', operation: { type: 'expression', expression: '[Brake Pressure] / max([Brake Pedal Position], 1)' } };
writeLevel('brake-analysis', level([withDerived(brakeFrame(), [pedalRatio])], {
  addedLogs: ['../sigmixa-basic.asc'],
  clips: CLIP_STARTS.map((start, index) => ({ id: `clip-road-stop-${index + 1}`, name: `Stop ${index + 1}`, sourcePath: 'road-test.asc', sourceFileName: 'road-test.asc', range: { start, end: start + 4.5 } })),
  viewStates: { 'group-view': brakeViews('Brake Analysis', [graph('view-pedal-ratio', 'Pedal to Pressure Ratio', ['sig-pedal-pressure-ratio'], ['unit:bar/%'], 200)]) },
}));

// Low-speed driving in a car park. It adds the inner wheel difference (内輪差): how far inside the front inner wheel the
// rear inner wheel runs, from the steering angle (wheelbase 2.7 m, track 1.6 m), as a lookup table.
const motion = parkingFrames().find((frame) => frame.id === 'ff-1a1');
const innerWheelDifference = { id: 'sig-inner-wheel-difference', name: 'Inner Wheel Difference', unit: 'm', operation: { type: 'lookup', input: 'Steering Angle', outOfRange: 'clamp', points: [{ input: -40.0, output: 1.2066 }, { input: -37.5, output: 1.1129 }, { input: -35.0, output: 1.0219 }, { input: -32.5, output: 0.9334 }, { input: -30.0, output: 0.8476 }, { input: -27.5, output: 0.7643 }, { input: -25.0, output: 0.6836 }, { input: -22.5, output: 0.6054 }, { input: -20.0, output: 0.5296 }, { input: -17.5, output: 0.4561 }, { input: -15.0, output: 0.3849 }, { input: -12.5, output: 0.3159 }, { input: -10.0, output: 0.249 }, { input: -7.5, output: 0.1841 }, { input: -5.0, output: 0.121 }, { input: -2.5, output: 0.0597 }, { input: 0, output: 0 }, { input: 2.5, output: 0.0597 }, { input: 5.0, output: 0.121 }, { input: 7.5, output: 0.1841 }, { input: 10.0, output: 0.249 }, { input: 12.5, output: 0.3159 }, { input: 15.0, output: 0.3849 }, { input: 17.5, output: 0.4561 }, { input: 20.0, output: 0.5296 }, { input: 22.5, output: 0.6054 }, { input: 25.0, output: 0.6836 }, { input: 27.5, output: 0.7643 }, { input: 30.0, output: 0.8476 }, { input: 32.5, output: 0.9334 }, { input: 35.0, output: 1.0219 }, { input: 37.5, output: 1.1129 }, { input: 40.0, output: 1.2066 }] } };
const axle = { id: 'series-axle', name: 'Rear Axle Centre', xId: 'sig-pose-x', yId: 'sig-pose-y', zId: 'sig-pose-z' };
const position = (id, name, prefix) => ({ id, name, xId: `sig-${prefix}-x`, yId: `sig-${prefix}-y`, zId: `sig-${prefix}-z` });
const wheels = [position('series-fl', 'Front Left', 'wheel-fl'), position('series-fr', 'Front Right', 'wheel-fr'), position('series-rl', 'Rear Left', 'wheel-rl'), position('series-rr', 'Rear Right', 'wheel-rr')];
const gnss = position('series-gnss', 'GNSS Antenna', 'gnss');
// Seen from the south-west, above: the ramp's height and the turns both show.
const OBLIQUE = { yaw: -2.3, pitch: 0.45, zoom: 3, panX: -3.45, panY: 1.9 };
// A short trace, so the trajectories get the height.
const parkingTrace = { visualizeTraceHeight: 150, traceSettings: { pinnedIds: pinned(0x1c1, 0x5b0), defaultMode: 'decoded', columns: TRACE_COLUMNS, sort: 'canId', descending: false } };
const steering = (id) => graph(id, 'Steering Angle and Inner Wheel Difference', ['sig-steering-angle', 'sig-inner-wheel-difference'], ['family:angle', 'family:length']);
// In 2D (no Z): the series are drawn from above.
const flat = ({ zId: _z, ...series }) => series;
writeLevel('parking-drive', level([withDerived(motion, [innerWheelDifference])], {
  clips: [{ id: 'clip-parking-space', name: 'Into the Space', sourcePath: 'parking-garage.asc', sourceFileName: 'parking-garage.asc', range: { start: 72.6, end: 86 } }],
  viewStates: {
    'group-view': logView([
      trajectory('view-drive-3d', 'Drive up the Car Park (3D)', [axle, gnss], { view: OBLIQUE, height: 520, connectGaps: false }),
      trajectory('view-wheels-3d', 'Four Wheel Tracks (3D)', wheels, { view: OBLIQUE, height: 520 }),
      // A Clip has no views of its own: opened as the Clip Into the Space, these same views show only the turn into the space.
      trajectory('view-wheels-2d', 'Four Wheel Tracks from Above (2D)', [axle, ...wheels].map(flat), { height: 460 }),
      steering('view-steering'),
      graph('view-ramp', 'Height and Road Grade', ['sig-pose-z', 'sig-road-grade'], ['family:length', 'family:percentage']),
    ], parkingTrace),
  },
}));
