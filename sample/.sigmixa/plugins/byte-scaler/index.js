'use strict';

let config = { byteIndex: 10, factor: 1, label: 'Coolant Raw Byte' };

module.exports = {
  id: 'sample.byte-scaler',
  version: '1.1.0',
  apiVersion: '1.0',
  getSupportedFrames() {
    return { type: 'specific', frames: [{ canId: 0x2A0, name: 'Vehicle Dynamics' }] };
  },
  getConfigSchema() {
    return {
      type: 'object',
      title: 'Byte scaler',
      schemaVersion: '1',
      properties: {
        byteIndex: { type: 'integer', title: 'Payload byte', minimum: 0, maximum: 63, default: 10 },
        factor: { type: 'number', title: 'Scale factor', minimum: 0.01, maximum: 100, default: 1 },
        label: { type: 'string', title: 'Signal name', default: 'Coolant Raw Byte' }
      },
      required: ['byteIndex', 'factor', 'label']
    };
  },
  getConfig() { return config; },
  setConfig(value) { config = { ...config, ...(value || {}) }; },
  validateConfig(value) {
    const next = value || {};
    const diagnostics = [];
    if (!Number.isInteger(next.byteIndex) || next.byteIndex < 0 || next.byteIndex > 63) diagnostics.push(diagnostic('BYTE_INDEX', 'Payload byte must be an integer from 0 to 63.'));
    if (!Number.isFinite(next.factor) || next.factor <= 0) diagnostics.push(diagnostic('FACTOR', 'Scale factor must be positive.'));
    if (typeof next.label !== 'string' || !next.label.trim()) diagnostics.push(diagnostic('LABEL', 'Signal name is required.'));
    return diagnostics;
  },
  processFrame(frame) {
    if (config.byteIndex >= frame.data.length) return { status: 'ignored' };
    return { status: 'handled', samples: [{ signalId: 'scaled-byte', name: config.label, unit: 'count', value: frame.data[config.byteIndex] * config.factor }] };
  }
};

function diagnostic(code, message) { return { id: '', source: 'plugin', code, severity: 'error', message }; }
