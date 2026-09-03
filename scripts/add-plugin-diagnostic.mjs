import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('sample/sigmixa-showcase.asc');
const lines = readFileSync(output, 'utf8').split('\n');
const target = lines.findIndex((line) => line.includes('30.001000 CANFD') && line.includes(' 2A0 '));
if (target < 0) throw new Error('Could not find the deterministic Plugin failure frame.');
lines[target] = lines[target].replace(/ A5$/, ' EE');
lines.splice(5, 0, '// Two sample Plugins share 0x2A0; the 30.001s 0xEE marker demonstrates error isolation.');
writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Generated ${output}: ${lines.length - 1} physical lines / one public Plugin failure marker`);
