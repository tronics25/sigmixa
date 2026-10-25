import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText } from '../src/shared/diagnosticText';
import { parseResolution } from '../src/core/manual/resolution';

test('built-in diagnostics use UI terminology and preserve Signal names and parameters', () => {
  for (const input of ['', 'abc', '1/0', '0', '1e20']) {
    const parsed = parseResolution(input); assert.equal(parsed.valid, false);
    if (!parsed.valid) {
      const text = diagnosticText(`Sensor: Multiplexer: ${parsed.error}`, 'ja-JP');
      assert.ok(text.startsWith('Sensor: Multiplexer: SCALE'));
      assert.ok(!text.includes('Resolution'));
    }
  }
  assert.equal(diagnosticText('CAN ID must fit the 29-bit range.', 'ja'), 'CAN IDは29ビットの範囲で入力してください。');
  assert.equal(diagnosticText('Speed overlaps another signal at byte 3, bit 7.', 'ja'), 'SpeedはBYTE 3、BIT 7で別のシグナルと重複しています。');
  assert.equal(diagnosticText('Speed: Unsupported character “$” at position 4.', 'ja'), 'Speed: 4文字目の「$」は使用できません。');
});

test('English diagnostics, unknown errors and user-provided content remain intact', () => {
  const message = 'Multiplexer: Scale must be finite.';
  assert.equal(diagnosticText(message, 'en'), message);
  assert.equal(diagnosticText('Plugin: hardware error 0x123', 'ja'), 'Plugin: hardware error 0x123');
  assert.equal(diagnosticText('Variable “$&\\sensor” is missing or invalid.', 'ja'), '変数「$&\\sensor」が存在しないか、無効です。');
});
