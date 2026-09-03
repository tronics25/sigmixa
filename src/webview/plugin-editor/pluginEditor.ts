import type { ConfigPropertySchema, ConfigScalarPropertySchema } from '../../plugin-sdk';
import type { PluginEditorModel, PluginEditorToExtension, PluginEditorToWebview } from '../../extension/plugin-editor/pluginEditorProtocol';

declare function acquireVsCodeApi(): { postMessage(message: PluginEditorToExtension): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

app.innerHTML = `<style>
*{box-sizing:border-box}body{margin:0;padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}main{max-width:1200px}h1{font-size:20px}h2{font-size:15px;margin-top:24px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:6px}.card{padding:12px;border:1px solid var(--vscode-panel-border);border-radius:5px;margin:8px 0}.meta{display:grid;grid-template-columns:110px 1fr;gap:5px;font-size:12px}.status-ok{color:var(--vscode-testing-iconPassed)}.status-error,.diag-error{color:var(--vscode-errorForeground)}label.field{display:grid;grid-template-columns:180px minmax(180px,1fr);gap:12px;align-items:center;margin:9px 0}input,select,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:6px 8px;border-radius:3px}button{background:var(--vscode-button-secondaryBackground);cursor:pointer;margin-right:6px}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.danger{color:var(--vscode-errorForeground)}button.icon{padding:5px;margin:0;background:transparent;border-color:transparent}.binding{display:flex;gap:8px;align-items:center;margin:7px 0}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.diagnostics{margin-top:10px;font-size:12px}.diagnostics div{margin:4px 0}.table-field,.hierarchy-field{margin:16px 0}.table-title,.hierarchy-title{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}.table-scroll{overflow:auto;border:1px solid var(--vscode-panel-border)}table{border-collapse:collapse;width:max-content;min-width:100%}th,td{padding:5px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);text-align:left;white-space:nowrap}th{background:var(--vscode-editorGroupHeader-tabsBackground);font-size:12px}td input:not([type=checkbox]),td select{min-width:100px;width:100%}td.actions{width:38px;text-align:center}.add-row{margin-top:8px}.hierarchy-toolbar{display:flex;gap:6px;align-items:center;margin:8px 0}.hierarchy-toolbar input[type=search]{min-width:240px;margin-right:auto}.hierarchy-list{display:grid;gap:8px}.hierarchy-row{border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-sideBar-background)}.hierarchy-row>summary{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;font-weight:600;background:var(--vscode-editorGroupHeader-tabsBackground)}.hierarchy-row>summary::marker{color:var(--vscode-descriptionForeground)}.hierarchy-summary-title{flex:1}.hierarchy-body{padding:8px 12px 12px 24px;background:var(--vscode-editor-background)}.hierarchy-body>.hierarchy-field{border-left:2px solid var(--vscode-panel-border);padding-left:12px}.hierarchy-empty{padding:10px;border:1px dashed var(--vscode-panel-border)}</style><div id="content">Loading Plugin…</div>`;
const content = document.getElementById('content')!;

window.addEventListener('message', (event: MessageEvent<PluginEditorToWebview>) => {
  if (event.data.type === 'init') render(event.data.model);
  else showDiagnostics(event.data.diagnostics);
});
vscode.postMessage({ type: 'ready' });

function render(model: PluginEditorModel): void {
  content.replaceChildren();
  const title = document.createElement('h1'); title.textContent = model.registration.id; content.appendChild(title);
  const card = document.createElement('div'); card.className = 'card';
  const enable = document.createElement('input'); enable.type = 'checkbox'; enable.checked = model.registration.enabled;
  enable.addEventListener('change', () => vscode.postMessage({ type: 'setEnabled', enabled: enable.checked }));
  const enabledLabel = document.createElement('label'); enabledLabel.append(enable, ' Enabled'); card.appendChild(enabledLabel);
  const meta = document.createElement('div'); meta.className = 'meta';
  addMeta(meta, 'Version', model.registration.version); addMeta(meta, 'Source', model.registration.source);
  addMeta(meta, 'Load state', model.loaded ? 'Loaded' : `Failed: ${model.loadMessage ?? 'Unknown error'}`, model.loaded ? 'status-ok' : 'status-error');
  card.appendChild(meta); content.appendChild(card);

  heading('Frame Bindings');
  const bindings = document.createElement('div'); bindings.className = 'card';
  if (!model.bindings.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No Frame Binding. Any-frame Plugins do not run until a Binding is added.'; bindings.appendChild(empty);
  }
  for (const binding of model.bindings) {
    const row = document.createElement('label'); row.className = 'binding';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = binding.enabled;
    check.addEventListener('change', () => vscode.postMessage({ type: 'setBindingEnabled', bindingId: binding.id, enabled: check.checked }));
    const text = document.createElement('span'); text.textContent = binding.frameLabel;
    const kind = document.createElement('small'); kind.className = 'muted'; kind.textContent = binding.automatic ? 'Specific · automatic' : 'manual';
    row.append(check, text, kind); bindings.appendChild(row);
  }
  bindings.appendChild(button('Add Binding…', () => vscode.postMessage({ type: 'addBinding' }))); content.appendChild(bindings);

  heading('Configuration');
  const form = document.createElement('form'); form.className = 'card'; const config = objectValue(model.registration.config);
  if (!model.schema || !Object.keys(model.schema.properties).length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'This Plugin does not expose configuration fields.'; form.appendChild(empty);
  } else {
    for (const [key, schema] of Object.entries(model.schema.properties)) form.appendChild(field(key, schema, config[key]));
  }
  const save = button('Save Configuration', () => undefined); save.classList.add('primary'); save.type = 'submit'; form.appendChild(save);
  form.addEventListener('submit', (event) => { event.preventDefault(); vscode.postMessage({ type: 'saveConfig', config: readForm(form, model.schema?.properties ?? {}) }); });
  content.appendChild(form);

  heading('Diagnostics');
  const diagnostics = document.createElement('div'); diagnostics.id = 'diagnostics'; diagnostics.className = 'card diagnostics'; content.appendChild(diagnostics); showDiagnostics(model.diagnostics);
  const actions = document.createElement('div'); actions.className = 'card';
  actions.append(button('Reload Plugin', () => vscode.postMessage({ type: 'reload' })));
  const remove = button('Unregister', () => vscode.postMessage({ type: 'unregister' })); remove.classList.add('danger'); actions.append(remove); content.appendChild(actions);
}

function heading(text: string): void { const element = document.createElement('h2'); element.textContent = text; content.appendChild(element); }
function addMeta(host: HTMLElement, label: string, value: string, className = ''): void { const key = document.createElement('strong'); key.textContent = label; const detail = document.createElement('span'); detail.textContent = value; detail.className = className; host.append(key, detail); }
function button(label: string, action: () => void): HTMLButtonElement { const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.addEventListener('click', action); return control; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

function field(key: string, schema: ConfigPropertySchema, value: unknown): HTMLElement {
  if (schema.type === 'array') return schema.presentation === 'hierarchy' ? hierarchyField(key, schema, value) : tableField(key, schema, value);
  if (schema.type === 'object') return objectField(key, schema, value);
  const label = document.createElement('label'); label.className = 'field';
  const text = document.createElement('span'); text.textContent = schema.title ?? key; text.title = schema.description ?? '';
  const control = scalarControl(schema, value);
  control.dataset.type = schema.type; control.dataset.valueControl = 'true'; label.dataset.key = key; label.dataset.type = schema.type; label.append(text, control); return label;
}

function scalarControl(schema: ConfigScalarPropertySchema, value: unknown): HTMLInputElement | HTMLSelectElement {
  if (schema.type === 'string' && schema.enum) {
    const select = document.createElement('select');
    for (const item of schema.enum) { const option = document.createElement('option'); option.value = item; option.textContent = item; select.appendChild(option); }
    select.value = String(value ?? schema.default ?? ''); return select;
  }
  const input = document.createElement('input'); input.type = schema.type === 'boolean' ? 'checkbox' : schema.type === 'string' ? 'text' : 'number';
  if (input.type === 'checkbox') input.checked = Boolean(value ?? schema.default);
  else {
    const initial = String(value ?? schema.default ?? '');
    input.value = schema.type === 'string' && schema.generate === 'uuid' && !initial.trim() ? `signal-${crypto.randomUUID()}` : initial;
  }
  if (schema.type === 'integer') input.step = '1'; if (schema.type === 'number') input.step = 'any';
  if ('minimum' in schema && schema.minimum !== undefined) input.min = String(schema.minimum);
  if ('maximum' in schema && schema.maximum !== undefined) input.max = String(schema.maximum);
  return input;
}

function tableField(key: string, schema: Extract<ConfigPropertySchema, { readonly type: 'array' }>, value: unknown): HTMLElement {
  const host = document.createElement('section'); host.className = 'table-field'; host.dataset.key = key; host.dataset.type = 'array';
  const title = document.createElement('div'); title.className = 'table-title'; const strong = document.createElement('strong'); strong.textContent = schema.title ?? key;
  const description = document.createElement('span'); description.className = 'muted'; description.textContent = schema.description ?? ''; title.append(strong, description); host.appendChild(title);
  const scroll = document.createElement('div'); scroll.className = 'table-scroll'; const table = document.createElement('table');
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const [column, columnSchema] of Object.entries(schema.items.properties)) { if (!isScalar(columnSchema)) continue; const cell = document.createElement('th'); cell.textContent = columnSchema.title ?? column; cell.title = columnSchema.description ?? ''; headRow.appendChild(cell); }
  const actionHead = document.createElement('th'); actionHead.setAttribute('aria-label', 'Actions'); headRow.appendChild(actionHead); head.appendChild(headRow); table.appendChild(head);
  const body = document.createElement('tbody'); table.appendChild(body); scroll.appendChild(table); host.appendChild(scroll);
  const initial = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];
  const addRow = (rowValue: unknown) => {
    const row = document.createElement('tr'); const record = objectValue(rowValue);
    for (const [column, columnSchema] of Object.entries(schema.items.properties)) { if (!isScalar(columnSchema)) continue; const cell = document.createElement('td'); const control = scalarControl(columnSchema, record[column]); control.dataset.column = column; control.dataset.type = columnSchema.type; cell.appendChild(control); row.appendChild(cell); }
    const actions = document.createElement('td'); actions.className = 'actions'; const remove = iconButton('trash', `Delete ${schema.title ?? key} row`, () => row.remove()); actions.appendChild(remove); row.appendChild(actions); body.appendChild(row);
  };
  initial.forEach(addRow);
  const add = button(schema.addLabel ?? 'Add row', () => addRow(defaultObject(schema.items))); add.className = 'add-row'; host.appendChild(add); return host;
}

function hierarchyField(key: string, schema: Extract<ConfigPropertySchema, { readonly type: 'array' }>, value: unknown): HTMLElement {
  const host = document.createElement('section'); host.className = 'hierarchy-field'; host.dataset.key = key; host.dataset.type = 'array';
  const title = document.createElement('div'); title.className = 'hierarchy-title'; const strong = document.createElement('strong'); strong.textContent = schema.title ?? key;
  const description = document.createElement('span'); description.className = 'muted'; description.textContent = schema.description ?? ''; title.append(strong, description); host.appendChild(title);
  const toolbar = document.createElement('div'); toolbar.className = 'hierarchy-toolbar'; const list = document.createElement('div'); list.className = 'hierarchy-list';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = `Search ${schema.title ?? key}…`; search.setAttribute('aria-label', `Search ${schema.title ?? key}`);
  const applySearch = () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const row of Array.from(list.children) as HTMLElement[]) {
      const values = Array.from(row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map((control) => control.type === 'checkbox' ? String((control as HTMLInputElement).checked) : control.value);
      const searchableText = `${row.textContent ?? ''} ${values.join(' ')}`.toLocaleLowerCase();
      row.hidden = Boolean(query) && !searchableText.includes(query);
    }
  };
  search.addEventListener('input', applySearch); if (schema.searchable !== false) toolbar.appendChild(search);
  toolbar.append(button('Expand all', () => list.querySelectorAll<HTMLDetailsElement>('details').forEach((item) => item.open = true)), button('Collapse all', () => list.querySelectorAll<HTMLDetailsElement>('details').forEach((item) => item.open = false)));
  host.append(toolbar, list);
  const addItem = (itemValue: unknown) => {
    const record = objectValue(itemValue); const details = document.createElement('details'); details.className = 'hierarchy-row'; details.open = true; details.dataset.hierarchyRow = 'true';
    const summary = document.createElement('summary'); const summaryTitle = document.createElement('span'); summaryTitle.className = 'hierarchy-summary-title';
    const remove = iconButton('trash', `Delete ${schema.title ?? key} item`, () => details.remove()); remove.addEventListener('click', (event) => event.stopPropagation()); summary.append(summaryTitle, remove);
    const body = document.createElement('div'); body.className = 'hierarchy-body'; body.dataset.hierarchyBody = 'true';
    for (const [propertyKey, propertySchema] of Object.entries(schema.items.properties)) { const child = field(propertyKey, propertySchema, record[propertyKey]); child.dataset.propertyKey = propertyKey; body.appendChild(child); }
    const updateTitle = () => { summaryTitle.textContent = itemTitle(schema.itemTitle, body, schema.items.properties); applySearch(); };
    body.addEventListener('input', updateTitle); body.addEventListener('change', updateTitle); details.append(summary, body); list.appendChild(details); updateTitle();
  };
  const initial = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : []; initial.forEach(addItem);
  const empty = document.createElement('div'); empty.className = 'hierarchy-empty muted'; empty.textContent = `No ${schema.title ?? key}.`; host.appendChild(empty);
  const refreshEmpty = () => empty.hidden = list.children.length > 0; const observer = new MutationObserver(refreshEmpty); observer.observe(list, { childList: true }); refreshEmpty();
  const add = button(schema.addLabel ?? `Add ${schema.title ?? key}`, () => addItem(defaultObject(schema.items))); add.className = 'add-row'; host.appendChild(add); return host;
}

function objectField(key: string, schema: Extract<ConfigPropertySchema, { readonly type: 'object' }>, value: unknown): HTMLElement {
  const host = document.createElement('section'); host.className = 'object-field'; host.dataset.key = key; host.dataset.type = 'object'; const record = objectValue(value);
  for (const [propertyKey, propertySchema] of Object.entries(schema.properties)) { const child = field(propertyKey, propertySchema, record[propertyKey]); child.dataset.propertyKey = propertyKey; host.appendChild(child); }
  return host;
}

function itemTitle(template: string | undefined, body: HTMLElement, properties: Readonly<Record<string, ConfigPropertySchema>>): string {
  const fallback = template ?? 'Item';
  return fallback.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const schema = properties[key]; if (!schema || !isScalar(schema)) return '';
    const wrapper = directProperty(body, key); const control = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement>('[data-value-control="true"]'); return control ? String(readScalar(control)) : '';
  });
}

function defaultObject(schema: Extract<ConfigPropertySchema, { readonly type: 'object' }>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, defaultValue(property)]));
}
function defaultValue(schema: ConfigPropertySchema): unknown { if (isScalar(schema)) return schema.default ?? (schema.type === 'boolean' ? false : ''); if (schema.type === 'array') return structuredClone(schema.default ?? []); return defaultObject(schema); }
function isScalar(schema: ConfigPropertySchema): schema is ConfigScalarPropertySchema { return schema.type === 'string' || schema.type === 'number' || schema.type === 'integer' || schema.type === 'boolean'; }

function iconButton(icon: string, title: string, action: () => void): HTMLButtonElement { const control = document.createElement('button'); control.type = 'button'; control.className = 'icon'; control.title = title; control.setAttribute('aria-label', title); const glyph = document.createElement('i'); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true'); control.appendChild(glyph); control.addEventListener('click', action); return control; }

function readForm(form: HTMLFormElement, properties: Readonly<Record<string, ConfigPropertySchema>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const host = Array.from(form.children).find((child) => (child as HTMLElement).dataset.key === key) as HTMLElement | undefined;
    if (host) result[key] = readValue(host, schema);
  }
  return result;
}

function readValue(host: HTMLElement, schema: ConfigPropertySchema): unknown {
  if (isScalar(schema)) { const control = host.querySelector<HTMLInputElement | HTMLSelectElement>('[data-value-control="true"]'); return control ? readScalar(control) : schema.default; }
  if (schema.type === 'object') return readObject(host, schema.properties);
  if (schema.presentation === 'hierarchy') {
    const list = Array.from(host.children).find((child) => (child as HTMLElement).classList.contains('hierarchy-list')) as HTMLElement | undefined;
    return list ? Array.from(list.children).map((row) => { const body = Array.from(row.children).find((child) => (child as HTMLElement).dataset.hierarchyBody === 'true') as HTMLElement; return readObject(body, schema.items.properties); }) : [];
  }
  const body = host.querySelector('tbody'); if (!body) return [];
  return Array.from(body.children).map((row) => Object.fromEntries(Object.entries(schema.items.properties).filter(([, property]) => isScalar(property)).map(([column]) => {
    const control = row.querySelector<HTMLInputElement | HTMLSelectElement>('[data-column="' + CSS.escape(column) + '"]'); return [column, control ? readScalar(control) : undefined];
  })));
}

function readObject(host: HTMLElement, properties: Readonly<Record<string, ConfigPropertySchema>>): Record<string, unknown> { return Object.fromEntries(Object.entries(properties).map(([key, schema]) => { const wrapper = directProperty(host, key); return [key, wrapper ? readValue(wrapper, schema) : defaultValue(schema)]; })); }
function directProperty(host: HTMLElement, key: string): HTMLElement | undefined { return Array.from(host.children).find((child) => (child as HTMLElement).dataset.propertyKey === key) as HTMLElement | undefined; }

function readScalar(control: HTMLInputElement | HTMLSelectElement): string | number | boolean { const type = control.dataset.type; return type === 'boolean' ? (control as HTMLInputElement).checked : type === 'number' || type === 'integer' ? Number(control.value) : control.value; }

function showDiagnostics(items: readonly { severity: string; code: string; message: string }[]): void {
  const host = document.getElementById('diagnostics'); if (!host) return; host.replaceChildren();
  if (!items.length) { host.textContent = 'No Plugin diagnostics.'; host.className = 'card diagnostics muted'; return; }
  host.className = 'card diagnostics';
  for (const item of items) { const row = document.createElement('div'); row.className = 'diag-' + item.severity; row.textContent = item.severity.toUpperCase() + ' · ' + item.code + ': ' + item.message; host.appendChild(row); }
}
