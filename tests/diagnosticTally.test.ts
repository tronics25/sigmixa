import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostic } from '../src/core/diagnostics/diagnostic';
import { DiagnosticTally, OVERFLOW_MESSAGE } from '../src/core/diagnostics/diagnosticTally';

const short = (definitionId: string, signalId: string) => createDiagnostic({
  source: 'definition', code: 'FRAME_TOO_SHORT', severity: 'warning', message: `${signalId}: Signal bit range exceeds the available payload.`,
  location: { sourceId: 'log' }, details: { definitionId, signalId },
});

test('Diagnostic tally counts every frame while grouping identical findings', () => {
  const tally = new DiagnosticTally();
  for (let index = 0; index < 1000; index++) tally.add(index * 0.01, [short('frame-a', 'mux')]);
  tally.add(3, [short('frame-b', 'speed'), short('frame-b', 'torque')]);
  assert.equal(tally.total, 1002);
  assert.equal(tally.size, 3);
  const [first] = tally.snapshot();
  assert.equal(first.count, 1000); assert.equal(first.firstPosition, 0); assert.equal(first.lastPosition, 9.99); assert.equal(first.definitionId, 'frame-a');
});

test('Re-analysing a definition replaces only its findings', () => {
  const tally = new DiagnosticTally();
  tally.add(1, [short('frame-a', 'mux')]); tally.add(2, [short('frame-a', 'mux')]); tally.add(3, [short('frame-b', 'speed')]);
  const replacement = new DiagnosticTally();
  replacement.add(5, [short('frame-a', 'other')]);
  tally.replaceDefinitions(new Set(['frame-a']), replacement);
  assert.equal(tally.total, 2);
  assert.deepEqual(tally.snapshot().map((group) => [group.definitionId, group.message, group.count]), [
    ['frame-b', 'speed: Signal bit range exceeds the available payload.', 1],
    ['frame-a', 'other: Signal bit range exceeds the available payload.', 1],
  ]);
  tally.replaceDefinitions(new Set(['frame-b']), new DiagnosticTally());
  assert.equal(tally.total, 1);
});

test('Varying messages stay bounded without losing the total', () => {
  const tally = new DiagnosticTally();
  for (let index = 0; index < 6000; index++) tally.add(index, [createDiagnostic({ source: 'plugin', code: 'VALUE', severity: 'warning', message: `value ${index}` })]);
  assert.equal(tally.total, 6000);
  assert.equal(tally.size, 5001);
  assert.equal(tally.snapshot().find((group) => group.message === OVERFLOW_MESSAGE)?.count, 1000);
});

test('Parser findings group by message and keep their line span', () => {
  const tally = new DiagnosticTally('line');
  const row = (line?: number) => createDiagnostic({ source: 'parser', code: 'ASC_UNSUPPORTED_ROW', severity: 'warning', message: 'Unsupported ASC row was not imported.', location: { sourceId: 'log', line } });
  for (const line of [12, 7, 30]) tally.add(line, [row(line)]);
  tally.add(undefined, [row()]);
  const [group] = tally.snapshot();
  assert.equal(tally.size, 1); assert.equal(group.count, 4);
  assert.equal(group.positionKind, 'line'); assert.equal(group.firstPosition, 7); assert.equal(group.lastPosition, 30);
});
