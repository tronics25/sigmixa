import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A drive up a multi-storey car park, in 3D (metres; X east, Y north, Z up):
// enter on the ground floor heading east, climb three turns of a helical ramp (radius 8 m, +3.2 m per turn) to the open
// roof deck, swerve round a trolley left in the aisle, then turn right into a parking space and stop.
//
// The vehicle follows the kinematic (bicycle) model: the rear-axle centre runs along the path and the body points
// along it. Every sensor reports the position of the point it is mounted at:
//   wheel speed sensors   each wheel's contact point (wheelbase 2.7 m, track 1.6 m): in a turn the rear wheels run
//                         inside the front ones, the inner rear wheel most (off-tracking, 内輪差)
//   IMU                   1.3 m ahead of the rear axle, 0.5 m high; dead reckoning with a yaw-rate bias drifts
//   GNSS antenna          1.0 m ahead, 1.5 m high on the roof; silent inside the building (no fix), noisy outside
const output = path.resolve('sample/parking-drive/parking-garage.asc');
const DT = 0.05; const WHEELBASE = 2.7; const HALF_TRACK = 0.8;
const IMU = { forward: 1.3, height: 0.5 }; const ANTENNA = { forward: 1.0, height: 1.5 };

// Curvature along the path (1/m, left positive), as segments with 2-3 m transitions so the steering never jumps.
const segments = [];
const add = (length, from, to = from) => segments.push({ length, from, to });
const HELIX_RADIUS = 8; const TURNS = 3; const RAMP = 3;
add(15, 0);                                                     // approach on the ground floor
add(RAMP, 0, 1 / HELIX_RADIUS);                                 // into the helix
const helixArc = (TURNS * 2 * Math.PI - RAMP / HELIX_RADIUS) * HELIX_RADIUS;
add(helixArc, 1 / HELIX_RADIUS);                                // two turns up the ramp
add(RAMP, 1 / HELIX_RADIUS, 0);                                 // out onto the roof deck
add(6, 0);                                                      // aisle
const SWERVE = 9; const SHIFT = 2; const swerveCurvature = 2 * Math.PI * SHIFT / SWERVE ** 2;
segments.push({ length: SWERVE, swerve: swerveCurvature });     // swerve left round the trolley...
add(3, 0);
segments.push({ length: SWERVE, swerve: -swerveCurvature });    // ...and back
add(4, 0);
const STALL_RADIUS = 5; const STALL_RAMP = 1.5;
add(STALL_RAMP, 0, -1 / STALL_RADIUS);                          // right turn into the parking space
add((Math.PI / 2 - STALL_RAMP / STALL_RADIUS) * STALL_RADIUS, -1 / STALL_RADIUS);
add(STALL_RAMP, -1 / STALL_RADIUS, 0);
add(4, 0);                                                      // into the space
let total = 0; for (const segment of segments) { segment.start = total; total += segment.length; }
const HELIX_START = segments[1].start; const HELIX_END = segments[3].start + RAMP;
const SWERVE_START = segments[5].start; const STALL_START = segments[9].start; const STALL_END = segments[11].start + STALL_RAMP;

function curvatureAt(s) {
  const segment = segments.find((item) => s < item.start + item.length) ?? segments.at(-1);
  const u = Math.max(0, Math.min(1, (s - segment.start) / segment.length));
  if (segment.swerve !== undefined) return segment.swerve * Math.sin(2 * Math.PI * u);
  return segment.from + (segment.to - segment.from) * u;
}
// Ramp grade, eased in and out over 5 m, giving +3.2 m per turn.
const RISE = 3.2 * TURNS; const EASE = 5; const grade0 = RISE / (HELIX_END - HELIX_START - EASE);
function gradeAt(s) {
  if (s <= HELIX_START || s >= HELIX_END) return 0;
  return grade0 * Math.min(1, (s - HELIX_START) / EASE, (HELIX_END - s) / EASE);
}

// Integrate the path once, finely.
const STEP = 0.005; const track = [{ x: -15, y: 4, z: 0, heading: 0 }];
for (let index = 1; index * STEP <= total + 5; index++) {
  const previous = track[index - 1]; const s = (index - 0.5) * STEP; const heading = previous.heading + curvatureAt(s) * STEP; const mean = (previous.heading + heading) / 2;
  track.push({ x: previous.x + Math.cos(mean) * STEP, y: previous.y + Math.sin(mean) * STEP, z: previous.z + gradeAt(s) * STEP, heading });
}
const at = (s) => track[Math.max(0, Math.min(track.length - 1, Math.round(s / STEP)))];

// Walking pace in the building, slower into the space, stopping at the end.
function speedAt(s) {
  const cruise = 2.8; const slow = 1.5;
  let speed = Math.min(cruise, Math.sqrt(2 * 0.8 * (s + 0.05)), Math.sqrt(Math.max(0, 2 * 0.6 * (total - s))));
  if (s > STALL_START - 4 && s < STALL_END + 1) speed = Math.min(speed, slow + (cruise - slow) * Math.max(0, (STALL_START - s) / 4));
  return s >= total ? 0 : speed;
}

let seed = 0x9a7; const noise = (amplitude) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff * 2 - 1) * amplitude; };
const lines = ['date Sun Aug 30 16:00:00.000 2026', 'base hex  timestamps absolute', 'internal events logged',
  '// SigMixa sample: a drive up a multi-storey car park (helical ramp, roof deck, swerve round a trolley, right turn into a space).',
  '// Each sensor reports the position of its mounting point: wheel contact points, IMU (1.3 m ahead, 0.5 m high), GNSS antenna (1.0 m ahead, 1.5 m high).'];
const hex = (value) => value.toString(16).toUpperCase().padStart(2, '0');
const s16 = (value, scale) => { const raw = Math.max(-32768, Math.min(32767, Math.round(value / scale))) & 0xffff; return [raw & 0xff, raw >> 8]; };
const u16 = (value, scale) => { const raw = Math.max(0, Math.min(0xffff, Math.round(value / scale))); return [raw & 0xff, raw >> 8]; };
const frame = (time, id, payload) => lines.push(`${time.toFixed(6).padStart(11)} 1  ${id.padEnd(15)} Rx   d ${payload.length} ${payload.map(hex).join(' ')}`);
const degrees = (radians) => ((radians * 180 / Math.PI) % 360 + 360) % 360;

let s = 0; let stoppedFor = 0; const imu = { x: 0, y: 0, z: 0, heading: 0, started: false };
// A trolley (1.2 m long, 0.8 m wide) standing on the aisle's centre line, 0.3 m to the right of it. The path at that
// point is already shifted left by the swerve, so its centre is SHIFT + 0.3 m to the right of the driven line.
const OBSTACLE_S = SWERVE_START + SWERVE + 1.5;
const trolley = (() => {
  const p = at(OBSTACLE_S); const forward = { x: Math.cos(p.heading), y: Math.sin(p.heading) }; const left = { x: -forward.y, y: forward.x };
  const centre = { x: p.x - left.x * (SHIFT + 0.3), y: p.y - left.y * (SHIFT + 0.3) };
  const corner = (along, side) => ({ x: centre.x + forward.x * along + left.x * side, y: centre.y + forward.y * along + left.y * side, z: p.z });
  return { centre, corners: [corner(-0.6, -0.4), corner(0.6, -0.4), corner(0.6, 0.4), corner(-0.6, 0.4)] };
})();
let corner = 0;
for (let step = 0; stoppedFor < 3; step++) {
  // The braking curve reaches the end only asymptotically: creep the last centimetres, then stand still.
  const time = step * DT; const speed = total - s < 0.03 ? 0 : Math.max(0.12, speedAt(s));
  const p = at(s); const kappa = curvatureAt(s); const grade = gradeAt(s);
  const forward = { x: Math.cos(p.heading), y: Math.sin(p.heading) }; const left = { x: -forward.y, y: forward.x };
  const point = (ahead, side, height) => { const ground = at(s + ahead); return { x: p.x + forward.x * ahead + left.x * side, y: p.y + forward.y * ahead + left.y * side, z: ground.z + height }; };
  const yawRate = kappa * speed;
  frame(time + 0.001, '1A0', [...s16(p.x, 0.01), ...s16(p.y, 0.01), ...s16(p.z, 0.01), ...u16(degrees(p.heading), 0.01)]);
  frame(time + 0.002, '1A1', [...u16(speed * 3.6, 0.01), ...s16(yawRate * 180 / Math.PI, 0.01), ...s16(Math.atan(WHEELBASE * kappa) * 180 / Math.PI, 0.1), ...s16(grade * 100, 0.01)]);
  // Each wheel turns about the instantaneous centre on the rear-axle line: its speed is the vehicle speed times its own radius ratio.
  const wheels = [['1B0', WHEELBASE, HALF_TRACK], ['1B1', WHEELBASE, -HALF_TRACK], ['1B2', 0, HALF_TRACK], ['1B3', 0, -HALF_TRACK]];
  wheels.forEach(([id, ahead, side], index) => {
    const contact = point(ahead, side, 0); const wheelSpeed = speed * Math.hypot(1 - kappa * side, kappa * ahead);
    frame(time + 0.003 + index * 0.0005, id, [...s16(contact.x, 0.01), ...s16(contact.y, 0.01), ...s16(contact.z, 0.01), ...u16(wheelSpeed * 3.6, 0.01)]);
  });
  // IMU dead reckoning from its mounting point: yaw-rate bias 0.4 deg/s and speed 2 % high while moving.
  if (!imu.started) { const start = point(IMU.forward, 0, IMU.height); Object.assign(imu, start, { heading: p.heading, started: true }); }
  imu.heading += (yawRate + (speed > 0 ? 0.4 * Math.PI / 180 : 0)) * DT;
  imu.x += Math.cos(imu.heading) * speed * 1.02 * DT; imu.y += Math.sin(imu.heading) * speed * 1.02 * DT; imu.z += grade * speed * 1.02 * DT;
  frame(time + 0.006, '1C0', [...s16(imu.x, 0.01), ...s16(imu.y, 0.01), ...s16(imu.z, 0.01), ...u16(degrees(imu.heading), 0.01)]);
  if (step % 2 === 0) {
    // GNSS: a fix outside the building (approach) and on the open roof deck; none under the floors.
    const outside = s < 8 || s > HELIX_END + 2; const antenna = point(ANTENNA.forward, 0, ANTENNA.height);
    // Without a fix the receiver sends nothing, so the trace shows GNSS stopped while the car is under the floors.
    if (outside) frame(time + 0.007, '1C1', [...s16(antenna.x + noise(0.25), 0.01), ...s16(antenna.y + noise(0.25), 0.01), ...s16(antenna.z + noise(0.4), 0.01), 10, 1]);
    // The trolley, while it is within 14 m ahead of the front bumper: the object sensor reports its outline one corner
    // per message, going round, so a trajectory of these points draws its rectangle.
    const ahead = OBSTACLE_S - s - WHEELBASE;
    if (ahead < 14 && ahead > -6) { const c = trolley.corners[corner++ % 4]; frame(time + 0.008, '5B0', [...s16(c.x, 0.01), ...s16(c.y, 0.01), ...s16(c.z, 0.01), ...u16(Math.max(0, Math.hypot(trolley.centre.x - p.x, trolley.centre.y - p.y) - WHEELBASE), 0.01)]); }
  }
  s += speed * DT; if (speed === 0) stoppedFor += DT;
}
lines.push('');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Generated ${output}: ${lines.length - 6} Frames, ${total.toFixed(1)} m, roof at ${at(total).z.toFixed(2)} m`);
