import test from 'node:test';
import assert from 'node:assert/strict';
import { addPluginBinding, installPlugin, setPluginEnabled, synchronizePluginSupport, uninstallPlugin } from '../src/core/plugin/pluginProject';
import { emptyProject } from '../src/core/project/schema';

test('Any Plugin registration waits for an explicit Frame Binding', () => {
  const frame = { id: 'manual', canId: 0x100, extended: false, name: 'Manual', frameLength: 8, signals: [], origin: { type: 'manual' as const } };
  const installed = installPlugin({ ...emptyProject(), frames: [frame] }, { id: 'any', version: '1', source: 'any', enabled: true }, { type: 'any' });
  assert.equal(installed.pluginBindings.length, 0);
  const bound = addPluginBinding(installed, 'any', 'manual'); assert.equal(bound.pluginBindings.length, 1); assert.equal(bound.pluginBindings[0].automatic, false);
});

test('Specific Plugin registration adds missing Frames and automatic Bindings but reuses existing Frames', () => {
  const frame = { id: 'manual', canId: 0x100, extended: false, name: 'Manual', frameLength: 8, signals: [], origin: { type: 'manual' as const } };
  const installed = installPlugin({ ...emptyProject(), frames: [frame] }, { id: 'specific', version: '1', source: 'specific', enabled: true }, { type: 'specific', frames: [{ canId: 0x100 }, { canId: 0x200, name: 'Added' }] });
  assert.equal(installed.frames.length, 2); assert.equal(installed.pluginBindings.length, 2); assert.ok(installed.pluginBindings.every((item) => item.automatic));
  assert.equal(installed.frames.find((item) => item.canId === 0x200)?.origin?.type, 'plugin');
  assert.equal(installed.frames.find((item) => item.canId === 0x200)?.frameLength, 8);
});

test('Specific Plugin configuration safely replaces automatic Frames while preserving disabled state and frame length', () => {
  const installed = installPlugin(emptyProject(), { id: 'dynamic', version: '1', source: 'dynamic', enabled: true }, { type: 'specific', frames: [{ canId: 0x200, frameLength: 64 }] });
  const disabled = { ...installed, pluginBindings: installed.pluginBindings.map((item) => ({ ...item, enabled: false })) };
  const unchanged = synchronizePluginSupport(disabled, 'dynamic', { type: 'specific', frames: [{ canId: 0x200, frameLength: 64 }] });
  assert.equal(unchanged.pluginBindings[0].enabled, false); assert.equal(unchanged.frames[0].frameLength, 64);
  const changed = synchronizePluginSupport(unchanged, 'dynamic', { type: 'specific', frames: [{ canId: 0x201, frameLength: 64 }] });
  assert.deepEqual(changed.frames.map((frame) => frame.canId), [0x201]); assert.equal(changed.pluginBindings.length, 1);
});

test('disable preserves Bindings and unregister safely removes only unused Plugin-owned Frames', () => {
  const installed = installPlugin(emptyProject(), { id: 'specific', version: '1', source: 'specific', enabled: true }, { type: 'specific', frames: [{ canId: 0x200 }] });
  const disabled = setPluginEnabled(installed, 'specific', false); assert.equal(disabled.pluginBindings.length, 1);
  const removed = uninstallPlugin(disabled, 'specific'); assert.equal(removed.plugins.length, 0); assert.equal(removed.pluginBindings.length, 0); assert.equal(removed.frames.length, 0);
});
