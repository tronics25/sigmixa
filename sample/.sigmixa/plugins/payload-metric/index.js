'use strict';

let config = { mode: 'average', throwOnMarker: true };

module.exports = {
  id: 'sample.payload-metric',
  version: '1.0.0',
  apiVersion: '1.0',
  getSupportedFrames() {
    return { type: 'specific', frames: [{ canId: 0x2A0, name: 'Vehicle Dynamics' }] };
  },
  getConfigSchema() {
    return {
      type: 'object',
      title: 'Payload metric',
      schemaVersion: '1',
      properties: {
        mode: { type: 'string', title: 'Metric', enum: ['average', 'maximum'], default: 'average' },
        throwOnMarker: { type: 'boolean', title: 'Exercise error isolation at 0xEE marker', default: true }
      }
    };
  },
  getConfig() { return config; },
  setConfig(value) { config = { ...config, ...(value || {}) }; },
  validateConfig(value) {
    return value && ['average', 'maximum'].includes(value.mode) ? [] : [{ id: '', source: 'plugin', code: 'MODE', severity: 'error', message: 'Metric must be average or maximum.' }];
  },
  processFrame(frame) {
    if (config.throwOnMarker && frame.data[63] === 0xEE) throw new Error('Intentional public sample failure at marker 0xEE');
    const values = Array.from(frame.data.slice(0, 8));
    const metric = config.mode === 'maximum' ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0) / values.length;
    return { status: 'handled', samples: [{ signalId: 'payload-metric', name: 'Payload Metric', unit: 'raw', value: metric }] };
  }
};
