'use strict';

/**
 * Public sample of a stateful request/response Plugin (fictional protocol).
 *
 * Property Request  (0x6A0, Tx): byte 0 property ID, byte 1 operation (1 Get, 2 Set, 3 Reset),
 *                                 bytes 2-3 the value to set (Set only, unsigned 16-bit Little Endian).
 * Property Response (0x6A8, Rx): byte 0 property ID, byte 1 result (0 Success, other values Failure),
 *                                 bytes 2-3 the property's latest value after processing (unsigned 16-bit Little Endian).
 *
 * A response alone does not say what it answers. The Plugin remembers each property's pending request, so it can label
 * the response with that operation, measure the response time and count requests that were never answered
 * (counted at the next request).
 * Names, units, Scale and Offset of each property come from the Plugin configuration.
 */

const REQUEST_ID = 0x6A0;
const RESPONSE_ID = 0x6A8;
const OPERATIONS = { 1: 'Get', 2: 'Set', 3: 'Reset' };
const GROUP = 'Property Service';

const DEFAULT_CONFIG = {
  responseTimeoutMs: 500,
  properties: [
    { id: 1, name: 'Target Cabin Temperature', unit: '°C', scale: 0.5, offset: -40 },
    { id: 2, name: 'Fan Level', unit: '', scale: 1, offset: 0 },
    { id: 3, name: 'Seat Heater Level', unit: '', scale: 1, offset: 0 },
    { id: 4, name: 'Display Brightness', unit: '%', scale: 0.5, offset: 0 },
  ],
};
let config = DEFAULT_CONFIG;

function property(id) {
  const known = config.properties.find((item) => item.id === id);
  return known || { id, name: `Property ${id}`, unit: '', scale: 1, offset: 0 };
}
function physical(item, raw) { return raw * item.scale + item.offset; }
function raw16(data, offset) { return data[offset] | data[offset + 1] << 8; }

module.exports = {
  id: 'sample.property-service',
  version: '1.0.0',
  apiVersion: '1.0',
  getSupportedFrames() {
    return { type: 'specific', frames: [{ canId: REQUEST_ID, name: 'Property Request', frameLength: 8 }, { canId: RESPONSE_ID, name: 'Property Response', frameLength: 8 }] };
  },
  getConfigSchema() {
    return {
      type: 'object',
      title: 'Property service',
      schemaVersion: '1',
      properties: {
        responseTimeoutMs: { type: 'number', title: 'Response timeout (ms)', minimum: 1, maximum: 60000, default: 500 },
        properties: {
          type: 'array', title: 'Properties', addLabel: 'Add property', default: DEFAULT_CONFIG.properties,
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', title: 'Property ID', minimum: 0, maximum: 255 },
              name: { type: 'string', title: 'Name' },
              unit: { type: 'string', title: 'Unit' },
              scale: { type: 'number', title: 'Scale' },
              offset: { type: 'number', title: 'Offset' },
            },
            required: ['id', 'name', 'scale', 'offset'],
          },
        },
      },
      required: ['responseTimeoutMs', 'properties'],
    };
  },
  getConfig() { return config; },
  setConfig(value) { config = { ...DEFAULT_CONFIG, ...(value || {}) }; },
  validateConfig(value) {
    const next = value || {}; const diagnostics = [];
    if (!Number.isFinite(next.responseTimeoutMs) || next.responseTimeoutMs <= 0) diagnostics.push(diagnostic('TIMEOUT', 'Response timeout must be a positive number of milliseconds.'));
    const ids = new Set();
    for (const item of Array.isArray(next.properties) ? next.properties : []) {
      if (!Number.isInteger(item.id) || item.id < 0 || item.id > 255) diagnostics.push(diagnostic('PROPERTY_ID', 'Property ID must be an integer from 0 to 255.'));
      else if (ids.has(item.id)) diagnostics.push(diagnostic('PROPERTY_DUPLICATE', `Property ID ${item.id} is listed twice.`));
      ids.add(item.id);
      if (typeof item.name !== 'string' || !item.name.trim()) diagnostics.push(diagnostic('PROPERTY_NAME', 'Every property needs a name.'));
      if (!Number.isFinite(item.scale) || item.scale === 0) diagnostics.push(diagnostic('PROPERTY_SCALE', 'Scale must be a non-zero number.'));
      if (!Number.isFinite(item.offset)) diagnostics.push(diagnostic('PROPERTY_OFFSET', 'Offset must be a number.'));
    }
    if (!Array.isArray(next.properties)) diagnostics.push(diagnostic('PROPERTIES', 'Properties must be a list.'));
    return diagnostics;
  },
  // Without a session there is no request to match; the Host always uses createSession().
  processFrame() { return { status: 'ignored' }; },
  createSession() {
    const pending = new Map(); // property ID -> { operation, timestamp }
    let unanswered = 0;
    // A request that waited longer than the timeout is counted once, at the next request (so the count is one Signal).
    function expire(now) {
      const samples = [];
      for (const [id, request] of pending) {
        if ((now - request.timestamp) * 1000 <= config.responseTimeoutMs) continue;
        pending.delete(id); unanswered++;
        samples.push({ signalId: 'unanswered', name: 'Unanswered Requests', unit: 'count', group: GROUP, value: unanswered, valueLabel: `${property(id).name} ${OPERATIONS[request.operation] || 'Request'}` });
      }
      return samples;
    }
    return {
      processFrame(frame) {
        if (frame.canId !== REQUEST_ID && frame.canId !== RESPONSE_ID) return { status: 'ignored' };
        if (frame.data.length < 4) return { status: 'error', diagnostics: [{ id: '', source: 'plugin', code: 'PROPERTY_FRAME_SHORT', severity: 'warning', message: `Property ${frame.canId === REQUEST_ID ? 'Request' : 'Response'} has ${frame.data.length} bytes; 4 are needed.` }] };
        const samples = frame.canId === REQUEST_ID ? expire(frame.timestamp) : [];
        const item = property(frame.data[0]); const key = `p${item.id}`;
        if (frame.canId === REQUEST_ID) {
          const operation = frame.data[1]; const name = OPERATIONS[operation] || `Unknown (${operation})`;
          samples.push({ signalId: 'request', name: 'Request', group: GROUP, value: operation, valueLabel: `${item.name} ${name}` });
          if (operation === 2) samples.push({ signalId: `${key}-requested`, name: `${item.name} Requested`, unit: item.unit, group: item.name, value: physical(item, raw16(frame.data, 2)) });
          pending.set(item.id, { operation, timestamp: frame.timestamp });
          return { status: 'handled', samples };
        }
        const request = pending.get(item.id); pending.delete(item.id);
        const success = frame.data[1] === 0;
        const answered = request ? OPERATIONS[request.operation] || 'Request' : 'Unsolicited';
        samples.push({ signalId: `${key}-value`, name: item.name, unit: item.unit, group: item.name, value: physical(item, raw16(frame.data, 2)) });
        samples.push({ signalId: `${key}-result`, name: `${item.name} Result`, group: item.name, value: success ? 0 : 1, valueLabel: `${answered} ${success ? 'Success' : 'Failure'}` });
        if (request) samples.push({ signalId: `${key}-response-time`, name: `${item.name} Response Time`, unit: 'ms', group: item.name, value: Math.round((frame.timestamp - request.timestamp) * 1e6) / 1e3 });
        return { status: 'handled', samples };
      },
    };
  },
};

function diagnostic(code, message) { return { id: '', source: 'plugin', code, severity: 'error', message }; }
