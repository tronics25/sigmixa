import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('sample/sigmixa-showcase.asc');
const lines = readFileSync(output, 'utf8').split('\n');
let points = 0;

function putSigned16(bytes, offset, value) {
  const raw = Math.max(-32768, Math.min(32767, Math.round(value))) & 0xffff;
  bytes[offset] = raw & 0xff;
  bytes[offset + 1] = raw >>> 8;
}
function put16(bytes, offset, value) {
  const raw = Math.max(0, Math.min(65535, Math.round(value)));
  bytes[offset] = raw & 0xff;
  bytes[offset + 1] = raw >>> 8;
}

for (let index = 0; index < lines.length; index++) {
  if (!/\bCANFD\b.*\b184\b/.test(lines[index])) continue;
  const fields = lines[index].trim().split(/\s+/);
  const time = Number(fields[0]);
  const bytes = fields.slice(-16).map((value) => Number.parseInt(value, 16));
  const angle = time * 0.42;
  const radius = 12 + time * 0.28;
  const x = radius * Math.cos(angle);
  const y = radius * Math.sin(angle);
  const z = 8 * Math.sin(time * 0.18) + time * 0.22;
  putSigned16(bytes, 4, x * 100);
  putSigned16(bytes, 6, y * 100);
  putSigned16(bytes, 8, z * 100);
  put16(bytes, 10, ((angle * 180 / Math.PI) % 360) * 100);
  putSigned16(bytes, 12, 24.06 * 100);
  putSigned16(bytes, 14, Math.sin(time * 0.42) * 0.28 * 1000);
  fields.splice(fields.length - 16, 16, ...bytes.map((value) => value.toString(16).padStart(2, '0').toUpperCase()));
  lines[index] = `   ${fields.join(' ')}`;
  points++;
}

lines.splice(6, 0, '// CAN FD 184 encodes synchronized X/Y/Z, heading, yaw rate and lateral acceleration.');
writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Generated ${output}: ${points} synchronized 3D trajectory points`);
