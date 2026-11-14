import { writeFileSync } from 'node:fs';
import path from 'node:path';

// The values of sample/sigmixa-basic.asc's frame 0x2A0 (Vehicle Powertrain Status) as the frame definitions decode them,
// at the frame's own times: a log of values converted from CAN data, so it matches the CAN log exactly when compared.
// The same formulas as scripts/generate-basic-log.mjs, rounded as that frame's bytes round them.
function speedAt(time) {
  if (time < 8) return time * 10;
  if (time < 20) return 80 + Math.sin((time - 8) * Math.PI / 3) * 10;
  if (time < 32) return 80;
  if (time < 45) return 80 - (time - 32) * 60 / 13;
  if (time < 52) return 20 - (time - 45) * 20 / 7;
  return 0;
}

// Units in brackets after each name: a CSV log reads them as the Signals' units.
// Speed in m/s, while the CAN speed is in km/h: a graph converts both onto one speed axis, where the lines lie on each other.
const csvLines = ['Time_ms,Vehicle Speed [m/s],Coolant Temperature [°C]'];
// Frame 0x2A0 is sent every other step of 0.05 s, 1 ms after the step: one row for each, over the whole log.
for (let step = 0; step <= 1200; step += 2) {
  const time = step * 0.05;
  const speed = Math.max(0, Math.min(0xffff, Math.round(speedAt(time) * 100))) / 100;
  const coolant = Math.round(72 + time * 0.35 + Math.sin(time / 7) * 3 + 40) - 40;
  csvLines.push(`${step * 50 + 1},${+(speed / 3.6).toPrecision(15)},${coolant}`);
}
const csvOutput = path.resolve('sample/sigmixa-basic-decoded.csv');
writeFileSync(csvOutput, `${csvLines.join('\n')}\n`, 'utf8');

console.log(`Generated ${csvOutput}: ${csvLines.length - 1} rows from 0.001s to 60.001s`);
