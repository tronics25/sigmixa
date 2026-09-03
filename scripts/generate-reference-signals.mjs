import { writeFileSync } from 'node:fs';
import path from 'node:path';

function speedAt(time) {
  if (time < 8) return time * 10;
  if (time < 20) return 80 + Math.sin((time - 8) * Math.PI / 3) * 10;
  if (time < 32) return 80;
  if (time < 45) return 80 - (time - 32) * 60 / 13;
  if (time < 52) return 20 - (time - 45) * 20 / 7;
  return 0;
}

const csvLines = ['Time_ms,Reference Speed,Ambient Temperature'];
for (let index = 0; index <= 200; index++) {
  const time = 5 + index * 0.25;
  const reference = Math.max(0, speedAt(time) + Math.sin(time * 0.7) * 2.5);
  const ambient = 21.5 + Math.sin(time / 8) * 1.8;
  csvLines.push(`${Math.round(time * 1000)},${reference.toFixed(3)},${ambient.toFixed(3)}`);
}
const csvOutput = path.resolve('sample/reference-signals.csv');
writeFileSync(csvOutput, `${csvLines.join('\n')}\n`, 'utf8');

console.log(`Generated ${csvOutput}: ${csvLines.length - 1} rows from 5.000s to 55.000s`);
