import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Adds the Frames that 2.0.0 features need to the basic log. Every existing line is kept as it is; new lines are only
// inserted in time order:
// - 0x3C0 heartbeat: nominal 100 ms with jitter, stops at 41 s and resumes at 50 s (trace stop marker, interval columns)
// - one 0x320 Frame with only 2 bytes (FRAME_TOO_SHORT, multiplexed value that cannot be read)
// - 0x6A0/0x6A8 property request/response exchanges for the stateful sample Plugin
const output = path.resolve('sample/sigmixa-basic.asc');
const lines = readFileSync(output, 'utf8').split('\n');
const added = [];

function hex(value) { return value.toString(16).toUpperCase().padStart(2, '0'); }
function classic(time, channel, id, direction, payload) { added.push({ time, line: `${time.toFixed(6).padStart(11)} ${channel}  ${id.padEnd(15)} ${direction}   d ${payload.length} ${payload.map(hex).join(' ')}` }); }
function le16(value) { return [value & 0xff, value >> 8 & 0xff]; }

// Deterministic jitter in [-20, +20] ms.
let seed = 0x3c0;
function jitter() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 41 - 20) / 1000; }
let counter = 0;
for (let index = 0; index < 600; index++) {
  const time = 0.0373 + index * 0.1 + jitter();
  if (time >= 41 && time < 50) continue;
  classic(time, 1, '3C0', 'Rx', [counter++ & 0xff, time < 41 ? 1 : 2, 0, 0, 0, 0, 0, 0]);
}

classic(26.7055, 1, '320', 'Rx', [0x01, 0x02]);

// Property IDs: 1 Target Cabin Temperature (raw = (°C + 40) / 0.5), 2 Fan Level, 3 Seat Heater Level,
// 4 Display Brightness (raw = % / 0.5), 7 not configured. Operations: 1 Get, 2 Set, 3 Reset. Result: 0 Success, 1 Failure.
const temperature = (celsius) => Math.round((celsius + 40) / 0.5);
const brightness = (percent) => Math.round(percent / 0.5);
const exchanges = [
  { time: 2.0, property: 1, operation: 1, result: 0, latest: temperature(22), latencyMs: 18 },
  { time: 2.1, property: 2, operation: 1, result: 0, latest: 2, latencyMs: 21 },
  { time: 2.2, property: 3, operation: 1, result: 0, latest: 0, latencyMs: 16 },
  { time: 2.3, property: 4, operation: 1, result: 0, latest: brightness(70), latencyMs: 24 },
  { time: 10.0, property: 1, operation: 2, value: temperature(24.5), result: 0, latest: temperature(24.5), latencyMs: 35 },
  { time: 15.0, property: 2, operation: 2, value: 3, result: 0, latest: 3, latencyMs: 22 },
  { time: 20.0, property: 2, operation: 2, value: 9, result: 1, latest: 3, latencyMs: 19 },
  { time: 20.5, property: 2, operation: 1, result: 0, latest: 3, latencyMs: 17 },
  { time: 30.0, property: 4, operation: 2, value: brightness(80), result: 0, latest: brightness(80), latencyMs: 41 },
  { time: 35.0, property: 1, operation: 3, result: 0, latest: temperature(22), latencyMs: 28 },
  { time: 40.0, property: 3, operation: 2, value: 2, result: 0, latest: 2, latencyMs: 23 },
  { time: 44.0, property: 7, operation: 1, result: 1, latest: 0, latencyMs: 15 },
  { time: 48.0, property: 4, operation: 2, value: brightness(50) },
  { time: 52.0, property: 4, operation: 1, result: 0, latest: brightness(80), latencyMs: 26 },
  { time: 56.0, property: 2, operation: 3, result: 0, latest: 2, latencyMs: 20 },
];
for (const exchange of exchanges) {
  classic(exchange.time + 0.0081, 1, '6A0', 'Tx', [exchange.property, exchange.operation, ...le16(exchange.value ?? 0), 0, 0, 0, 0]);
  if (exchange.latencyMs !== undefined) classic(exchange.time + 0.0081 + exchange.latencyMs / 1000, 1, '6A8', 'Rx', [exchange.property, exchange.result, ...le16(exchange.latest), 0, 0, 0, 0]);
}

const timeOf = (line) => { const value = Number(line.trim().split(/\s+/)[0]); return Number.isFinite(value) ? value : undefined; };
added.sort((a, b) => a.time - b.time);
for (const item of added) {
  let index = lines.findIndex((line) => { const time = timeOf(line); return time !== undefined && time > item.time; });
  if (index < 0) { index = lines.length; while (index > 0 && !lines[index - 1].trim()) index--; }
  lines.splice(index, 0, item.line);
}
lines.splice(7, 0, '// 2.0.0: 3C0 heartbeat with jitter and a 41-50 s dropout, one 2-byte 320 Frame, and 6A0/6A8 property request/response.');
writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Generated ${output}: ${added.length} Frames added for 2.0.0 coverage`);
