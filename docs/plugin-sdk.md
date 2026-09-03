# SigMixa Plugin SDK

Plugins are CommonJS packages or directories loaded by the VS Code Extension Host. A directory must resolve through Node's normal package rules, typically with a `package.json` containing `"main": "index.js"`. Export the Plugin object directly, as `default`, or as `plugin`.

The authoritative TypeScript contract is `src/plugin-sdk/index.ts`. The public samples are under `sample/.sigmixa/plugins/`.

Plugins should declare `apiVersion: '1.0'` or import `PLUGIN_API_VERSION` in
TypeScript. An incompatible major version prevents loading and appears as a
Plugin Diagnostic. Package-version and configuration-schema changes are also
reported.

## Minimal Plugin

```js
module.exports = {
  id: 'example.byte',
  version: '1.0.0',
  apiVersion: '1.0',
  getSupportedFrames() {
    return { type: 'specific', frames: [{ canId: 0x123, name: 'Example' }] };
  },
  processFrame(frame) {
    return {
      status: 'handled',
      samples: [{ signalId: 'byte-0', name: 'Byte 0', unit: 'raw', value: frame.data[0] }]
    };
  }
};
```

`signalId` must be stable within the Plugin. The Host namespaces it with Plugin ID and Binding ID so two Plugins may emit the same local ID or display name without collision. Output samples retain the input Frame timestamp.

## Stateful analysis sessions

A Plugin that learns configuration or protocol state from earlier Frames should
implement `createSession()`. The Host calls it once per log analysis and uses the
returned processor for every Binding belonging to that Plugin:

```js
module.exports = {
  id: 'example.tx-configured',
  version: '1.0.0',
  apiVersion: '1.0',
  getSupportedFrames() {
    return { type: 'specific', frames: [{ canId: 0x620 }, { canId: 0x621 }] };
  },
  processFrame() { return { status: 'ignored' }; },
  createSession() {
    let scale;
    return { processFrame(frame) {
      if (frame.canId === 0x620 && frame.direction === 'Tx') {
        scale = frame.data[0];
        return { status: 'handled', samples: [] };
      }
      if (frame.canId !== 0x621 || scale === undefined) return { status: 'ignored' };
      return { status: 'handled', samples: [{ signalId: 'value', name: 'Value', value: frame.data[0] * scale }] };
    } };
  }
};
```

One session shares state across that Plugin's configuration and data Frame
Bindings. Reanalysis and each open log receive a fresh session, preventing state
from leaking between documents. `dispose()` on the returned session is optional.
Plugins without `createSession()` retain the original stateless behavior.

An output sample may include a source-defined `group` label. Selectors use it as
an extra grouping level; SigMixa treats it only as display metadata.

## Frame support and Bindings

- `specific` declares CAN IDs and may declare `frameLength`. Registration reuses an existing matching Frame or adds a Plugin-owned Frame, then creates automatic Bindings.
- When accepted configuration changes declared Specific IDs, SigMixa synchronizes only that Plugin's automatic Frames and Bindings and preserves unrelated/manual data.
- `any` creates no Binding at registration. The user must explicitly add each Frame Binding.
- Global enable and Binding enable are independent. Disabling either preserves configuration and Binding records.
- Manual Decode and every enabled Plugin Binding run independently on a matching Frame.

## Results and isolation

`processFrame` returns `handled`, `ignored`, or `error`. A thrown exception and malformed sample are converted to Plugin Diagnostics. Other Plugins, Manual Decode, Frame storage, and RAW display continue. The Host passes a copied payload so Plugin mutation cannot alter the stored Frame.

Plugin code executes synchronously in the VS Code Extension Host. Keep `processFrame` bounded and do not log unrestricted payloads or secrets.

## Generic configuration

`getConfigSchema()` may return a recursively nested object schema containing
string, enum, number, integer, boolean, object and object-array properties. An
object array uses the table presentation by default. Setting
`presentation: 'hierarchy'` renders collapsible cards whose children may contain
more objects, tables or hierarchy arrays. `itemTitle` supports `{property}`
placeholders; `addLabel` and `searchable` control the shared actions. String
properties may request `generate: 'uuid'` so newly added rows receive a stable
identifier. SigMixa owns expand/collapse, search, add and trash behavior, so
catalogs remain editable without a Plugin-specific Webview. `validateConfig()` returns Diagnostics; `setConfig()` applies
accepted values. A Plugin without a schema remains registrable and executable.

Proprietary communication rules and databases should remain inside the Plugin package and must not be written to logs.
