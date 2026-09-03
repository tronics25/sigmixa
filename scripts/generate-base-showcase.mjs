import { writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('sample/sigmixa-showcase.asc');
const lines = [
  'date Sun Aug 30 12:00:00.000 2026',
  'base hex  timestamps absolute',
  'internal events logged',
  '// SigMixa comprehensive showcase',
  '// Accelerate, cruise, turn, brake and stop with mixed-rate Classic CAN and CAN FD.',
];

function hex(value, width = 2) { return Math.max(0, Math.round(value)).toString(16).toUpperCase().padStart(width, '0'); }
function bytes(values) { return values.map((value) => hex(value)).join(' '); }
function put16(payload, offset, value) { const raw = Math.max(0, Math.min(0xffff, Math.round(value))); payload[offset] = raw & 0xff; payload[offset + 1] = raw >> 8; }
function putSigned16(payload, offset, value) { const raw = Math.max(-32768, Math.min(32767, Math.round(value))) & 0xffff; payload[offset] = raw & 0xff; payload[offset + 1] = raw >>> 8; }
function put32(payload, offset, value) { const raw = Math.max(0, Math.min(0xffffffff, Math.round(value))); payload[offset] = raw & 0xff; payload[offset + 1] = raw >>> 8 & 0xff; payload[offset + 2] = raw >>> 16 & 0xff; payload[offset + 3] = raw >>> 24 & 0xff; }
function classic(time, channel, id, direction, payload) { lines.push(`${time.toFixed(6).padStart(11)} ${channel}  ${id.padEnd(15)} ${direction}   d ${payload.length} ${bytes(payload)}`); }
function remote(time, channel, id, direction = 'Rx') { lines.push(`${time.toFixed(6).padStart(11)} ${channel}  ${id.padEnd(15)} ${direction}   r 0`); }
function fd(time, channel, id, direction, payload, name = '') {
  const dlc = payload.length <= 8 ? payload.length : payload.length === 12 ? 9 : payload.length === 16 ? 10 : payload.length === 20 ? 11 : payload.length === 24 ? 12 : payload.length === 32 ? 13 : payload.length === 48 ? 14 : 15;
  lines.push(`${time.toFixed(6).padStart(11)} CANFD   ${channel} ${direction} ${id}${name ? ` ${name}` : ''} 1 0 ${hex(dlc, 1)} ${payload.length} ${bytes(payload)}`);
}

function speedAt(time) {
  if (time < 8) return time * 10;
  if (time < 20) return 80 + Math.sin((time - 8) * Math.PI / 3) * 10;
  if (time < 32) return 80;
  if (time < 45) return 80 - (time - 32) * 60 / 13;
  if (time < 52) return 20 - (time - 45) * 20 / 7;
  return 0;
}

function pedalAt(time) {
  if (time >= 33 && time < 38) return (time - 33) * 12;
  if (time >= 38 && time < 45) return 60 - (time - 38) * 50 / 7;
  if (time >= 45 && time < 52) return 75 + Math.sin((time - 45) * Math.PI) * 5;
  return 0;
}

function acceleratorAt(time) {
  if (time < 8) return 28 + time * 4;
  if (time < 32) return 18 + Math.sin(time / 2) * 3;
  if (time < 45) return Math.max(0, 14 - (time - 32) * 1.1);
  return 0;
}

for (let step = 0; step <= 1200; step++) {
  const time = step * 0.05;
  const speed = speedAt(time);
  const pedal = pedalAt(time);
  const accelerator = acceleratorAt(time);

  // High-rate unknown Classic frame: RAW search/filter and virtualization.
  classic(time, 1, '123', 'Rx', [step & 0xff, step >> 8 & 0xff, Math.round(speed), Math.round(pedal), 0xAA, 0x55, step % 17, 0]);

  if (step % 2 === 0) {
    // Registered 64-byte vehicle powertrain status with dense and distant Signals.
    const payload = new Array(64).fill(0);
    const engineSpeed = speed > 0.1 ? 800 + speed * 34 + accelerator * 8 : time < 55 ? 780 : 0;
    const engineTorque = accelerator > 0 ? 25 + accelerator * 2.1 : pedal > 0 ? -pedal * 0.55 : 8;
    put16(payload, 0, speed * 100);
    put16(payload, 2, (12.6 + Math.sin(time / 4) * 0.35) * 100);
    put16(payload, 4, engineSpeed / 0.25);
    put16(payload, 6, accelerator * 10);
    putSigned16(payload, 8, engineTorque * 10);
    payload[10] = Math.round(72 + time * 0.35 + Math.sin(time / 7) * 3 + 40);
    payload[11] = speed > 0.1 ? 3 : time < 55 ? 1 : 0;
    put32(payload, 12, (125000 + time * Math.max(speed, 5) / 3600) * 10);
    put16(payload, 40, (25 + time * 0.72 + Math.sin(time / 6) * 2 + 40) * 10);
    payload[63] = 0xA5;
    fd(time + 0.001, 1, '2A0', 'Rx', payload, 'VehicleDynamics');

    // CAN FD with actual length 8 but DLC code 8.
    fd(time + 0.002, 1, '182', 'Rx', [Math.round(speed), Math.round(pedal), step & 0xff, 0x5A, 0, 0, 0, 0], 'CompactStatus');
  }

  if (step % 5 === 0) {
    // Registered Classic frame at a different sampling period: no forward-fill should occur in Table.
    const payload = new Array(8).fill(0);
    put16(payload, 0, pedal * 1.4 * 10); put16(payload, 2, pedal * 10);
    const turnDifference = time >= 20 && time < 24 ? 1.8 : time >= 35 && time < 39 ? -1.4 : 0;
    put16(payload, 4, Math.max(0, speed + turnDifference) * 100); put16(payload, 6, Math.max(0, speed - turnDifference) * 100);
    classic(time + 0.003, 1, '300', 'Rx', payload);
  }

  if (step % 8 === 0) {
    // CAN FD 16-byte boundary.
    const payload = new Array(16).fill(0); put16(payload, 0, speed * 100); put16(payload, 2, pedal * 100);
    fd(time + 0.004, 2, '184', 'Rx', payload, 'Fd16Telemetry');
  }

  if (step % 10 === 0) {
    const headlight = time >= 15 && time < 55;
    const left = time >= 20 && time < 24 && Math.floor(time * 2) % 2 === 0;
    const right = time >= 35 && time < 39 && Math.floor(time * 2) % 2 === 0;
    const horn = time >= 50 && time < 50.6;
    const flags = (headlight ? 0x80 : 0) | (left ? 0x40 : 0) | (right ? 0x20 : 0) | (horn ? 0x10 : 0);
    const driverDoor = time < 1 || time > 56; const passengerDoor = time > 57; const seatbelt = time >= 1 && time < 56;
    const body = (driverDoor ? 0x80 : 0) | (passengerDoor ? 0x40 : 0) | (seatbelt ? 0x20 : 0);
    const gear = speed > 0.1 ? 3 : time < 55 ? 1 : 0;
    classic(time + 0.005, 1, '310', 'Tx', [flags, body, gear, Math.round(22 + Math.sin(time / 9) * 2 + 40), 0, 0, 0, 0]);
  }

  if (step % 20 === 0) {
    const environment = new Array(8).fill(0);
    environment[0] = Math.round(21.5 + Math.sin(time / 8) * 1.8 + 40);
    put16(environment, 1, (100.8 + Math.sin(time / 12) * 1.1) * 10);
    put16(environment, 3, (13.8 + Math.sin(time / 5) * 0.25) * 100);
    putSigned16(environment, 5, (120 + Math.sin(time / 10) * 15) * 10);
    environment[7] = step / 20 & 0xff;
    classic(time + 0.006, 2, '18FF50E5x', 'Rx', environment);
    const adas = new Array(8).fill(0); const valid = time >= 6 && time <= 48;
    const distance = valid ? Math.max(8, 90 - time * 1.35 + Math.sin(time / 3) * 3) : 0;
    const relativeSpeed = valid ? -Math.max(0.5, 5.5 - time * 0.06) : 0;
    put16(adas, 0, distance * 10); putSigned16(adas, 2, relativeSpeed * 100); putSigned16(adas, 4, Math.sin(time / 5) * 700);
    adas[6] = valid ? Math.round((88 + Math.sin(time / 4) * 8) / 0.5) : 0; adas[7] = valid ? 1 : 0;
    classic(time + 0.0065, 2, '5A0x', 'Rx', adas);
  }
  if (step % 40 === 0) remote(time + 0.007, 2, '400');
}

// Deliberate malformed/unsupported rows make aggregate parser Diagnostics observable.
lines.splice(700, 0, '  12.345000 1 555 Rx d 8 01 02 03', '  12.346000 unsupported event for diagnostics smoke');
lines.push('');
writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Generated ${output}: ${lines.length - 1} physical lines`);
