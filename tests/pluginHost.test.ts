import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanFrame } from '../src/core/frame/canFrame';
import { PluginHost, PluginRegistry, pluginCompatibilityDiagnostics } from '../src/core/plugin/pluginHost';
import type { PluginBinding, PluginRegistration } from '../src/core/project/schema';
import type { SigMixaPlugin } from '../src/plugin-sdk';

const frame: CanFrame = { id: 'frame-1', sourceId: 'test.asc', timestamp: 12.5, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: 8, dataLength: 8, data: Uint8Array.from([10, 20, 0, 0, 0, 0, 0, 0]) };
const registrations: PluginRegistration[] = [
  { id: 'one', version: '1.0.0', source: 'memory', enabled: true },
  { id: 'two', version: '1.0.0', source: 'memory', enabled: true },
];
const bindings: PluginBinding[] = [
  { id: 'binding-one', pluginId: 'one', frameId: 'definition', enabled: true, automatic: false },
  { id: 'binding-two', pluginId: 'two', frameId: 'definition', enabled: true, automatic: false },
];

function plugin(id: string, value: number): SigMixaPlugin { return { id, version: '1.0.0', getSupportedFrames: () => ({ type: 'any' }), processFrame: () => ({ status: 'handled', samples: [{ signalId: 'value', name: 'Shared name', unit: 'u', value }] }) }; }

test('two Plugin bindings on one Frame create independently namespaced stable Signals', () => {
  const registry = new PluginRegistry(); registry.register(plugin('one', 1)); registry.register(plugin('two', 2));
  const result = new PluginHost(registry, [{ id: 'definition', canId: 0x123, extended: false }], registrations, bindings).processFrame(frame);
  assert.equal(result.decoded.length, 2); assert.deepEqual(result.decoded.map((item) => item.sample.value), [1, 2]);
  assert.equal(new Set(result.decoded.map((item) => item.definition.id)).size, 2);
  assert.ok(result.decoded.every((item) => item.sample.timestamp === frame.timestamp && item.definition.source.type === 'plugin'));
});

test('a throwing Plugin is isolated from another Plugin and cannot mutate the source payload', () => {
  const registry = new PluginRegistry();
  registry.register({ id: 'one', version: '1', getSupportedFrames: () => ({ type: 'any' }), processFrame: (input) => { input.data[0] = 99; throw new Error('boom'); } });
  registry.register(plugin('two', 20));
  const result = new PluginHost(registry, [{ id: 'definition', canId: 0x123, extended: false }], registrations, bindings).processFrame(frame);
  assert.equal(frame.data[0], 10); assert.equal(result.decoded.length, 1); assert.equal(result.decoded[0].sample.value, 20); assert.equal(result.diagnostics[0].code, 'PLUGIN_PROCESS_THROW');
});

test('global and Binding enable states skip execution without deleting Binding state', () => {
  let calls = 0; const registry = new PluginRegistry(); registry.register({ ...plugin('one', 1), processFrame: () => { calls++; return { status: 'ignored' }; } });
  const disabledGlobal = [{ ...registrations[0], enabled: false }];
  new PluginHost(registry, [{ id: 'definition', canId: 0x123, extended: false }], disabledGlobal, [bindings[0]]).processFrame(frame);
  new PluginHost(registry, [{ id: 'definition', canId: 0x123, extended: false }], [registrations[0]], [{ ...bindings[0], enabled: false }]).processFrame(frame);
  assert.equal(calls, 0); assert.equal(bindings.length, 2);
});

test('one Plugin analysis session shares learned state across Frame bindings and is isolated between Hosts', () => {
  let sessionCount = 0;
  const registry = new PluginRegistry();
  registry.register({
    id: 'one', version: '1', getSupportedFrames: () => ({ type: 'specific', frames: [{ canId: 0x120 }, { canId: 0x121 }] }),
    processFrame: () => ({ status: 'ignored' }),
    createSession: () => {
      sessionCount++;
      let factor: number | undefined;
      return { processFrame: (input) => {
        if (input.canId === 0x120 && input.direction === 'Tx') { factor = input.data[0]; return { status: 'handled', samples: [] }; }
        if (input.canId === 0x121 && input.direction === 'Rx' && factor !== undefined) return { status: 'handled', samples: [{ signalId: 'dynamic', name: 'Dynamic', value: input.data[0] * factor }] };
        return { status: 'ignored' };
      } };
    },
  });
  const sessionFrames = [{ id: 'config', canId: 0x120, extended: false }, { id: 'data', canId: 0x121, extended: false }];
  const registration = [{ ...registrations[0], id: 'one' }];
  const sessionBindings = [
    { id: 'config-binding', pluginId: 'one', frameId: 'config', enabled: true, automatic: true },
    { id: 'data-binding', pluginId: 'one', frameId: 'data', enabled: true, automatic: true },
  ];
  const tx = { ...frame, id: 'tx', canId: 0x120, direction: 'Tx' as const, data: Uint8Array.of(3), dataLength: 1, dlcCode: 1 };
  const rx = { ...frame, id: 'rx', canId: 0x121, data: Uint8Array.of(7), dataLength: 1, dlcCode: 1 };
  const learned = new PluginHost(registry, sessionFrames, registration, sessionBindings);
  assert.equal(learned.processFrame(tx).handled, true);
  assert.equal(learned.processFrame(rx).decoded[0].sample.value, 21);
  const fresh = new PluginHost(registry, sessionFrames, registration, sessionBindings);
  assert.equal(fresh.processFrame(rx).decoded.length, 0);
  assert.equal(sessionCount, 2);
});

test('a throwing Plugin session factory is reported without affecting another Plugin', () => {
  const registry = new PluginRegistry();
  registry.register({ ...plugin('one', 1), createSession: () => { throw new Error('session boom'); } });
  registry.register(plugin('two', 2));
  const result = new PluginHost(registry, [{ id: 'definition', canId: 0x123, extended: false }], registrations, bindings).processFrame(frame);
  assert.deepEqual(result.decoded.map((item) => item.sample.value), [2]);
  assert.equal(result.diagnostics[0].code, 'PLUGIN_SESSION_CREATE_FAILED');
});

test('Plugin compatibility diagnostics distinguish missing, incompatible, runtime and config schema changes', () => {
  assert.equal(pluginCompatibilityDiagnostics(plugin('legacy', 1))[0].code, 'PLUGIN_API_VERSION_MISSING');
  const incompatible = { ...plugin('future', 1), apiVersion: '2.0' };
  assert.equal(pluginCompatibilityDiagnostics(incompatible)[0].code, 'PLUGIN_API_INCOMPATIBLE');
  const current = { ...plugin('one', 1), apiVersion: '1.2', version: '2.0.0', getConfigSchema: () => ({ type: 'object' as const, schemaVersion: '2', properties: {} }) };
  const diagnostics = pluginCompatibilityDiagnostics(current, { ...registrations[0], version: '1.0.0', configSchemaVersion: '1' });
  assert.deepEqual(diagnostics.map((item) => item.code), ['PLUGIN_VERSION_CHANGED', 'PLUGIN_CONFIG_SCHEMA_CHANGED']);
});
