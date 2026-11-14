import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayScrollForSlider, overlayScrollbarScript, overlaySliderGeometry } from '../src/webview/shared/overlayScrollbars';

test('the slider is hidden when the content fits', () => {
  assert.equal(overlaySliderGeometry(500, 500, 500, 0).visible, false);
  assert.equal(overlaySliderGeometry(0, 100, 1000, 0).visible, false);
});

test('slider size and offset follow the scroll position, with a 20px minimum', () => {
  assert.deepEqual(overlaySliderGeometry(500, 500, 1000, 0), { visible: true, size: 250, position: 0 });
  assert.deepEqual(overlaySliderGeometry(500, 500, 1000, 500), { visible: true, size: 250, position: 250 });
  const huge = overlaySliderGeometry(500, 500, 16_000_000, 8_000_000);
  assert.equal(huge.size, 20); assert.equal(huge.position, 240);
});

test('dragging the slider maps back onto the scroll range', () => {
  assert.equal(overlayScrollForSlider(500, 500, 1000, 250, 125), 250);
  assert.equal(overlayScrollForSlider(500, 500, 1000, 250, -10), 0);
  assert.equal(overlayScrollForSlider(500, 500, 1000, 250, 999), 500);
});

test('the script for pages without a bundle is self-contained', () => {
  const script = overlayScrollbarScript();
  assert.doesNotThrow(() => new Function('document', script));
  assert.doesNotMatch(script, /__name|require\(|import\(/);
});
