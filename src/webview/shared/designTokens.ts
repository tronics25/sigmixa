/**
 * Design tokens and the base control look shared by every SigMixa Webview (and the extension-rendered pages).
 * Colours come from VS Code theme variables; these tokens hold SigMixa's own type and shape scale.
 *
 * `legacy-*` tokens keep values that are still in use by one-off parts; deliberate exceptions
 * (compact table headings, pill chips, bit digits) keep their own values on purpose.
 */
export const DESIGN_TOKENS = `:root{
--sm-font-caption:11px;--sm-font-small:12px;--sm-font-body:13px;--sm-font-heading:16px;--sm-font-title:20px;
--sm-font-page-title:16px;--sm-font-section:13px;
--sm-font-legacy-8:8px;--sm-font-legacy-9:9px;--sm-font-legacy-10:10px;--sm-font-legacy-14:14px;--sm-font-legacy-15:15px;
--sm-weight-regular:400;--sm-weight-medium:500;--sm-weight-semibold:600;--sm-weight-legacy-650:650;
--sm-radius-sm:2px;--sm-radius-md:4px;--sm-radius-round:50%;
--sm-radius-control:3px;--sm-radius-menu:4px;--sm-radius-card:6px;
--sm-radius-legacy-3:3px;--sm-radius-legacy-5:5px;--sm-radius-legacy-6:6px;--sm-radius-legacy-8:8px;--sm-radius-legacy-9:9px;--sm-radius-legacy-10:10px;
--sm-control-height:26px;--sm-control-height-compact:22px;--sm-control-padding-x:var(--sm-space-md);--sm-control-padding-x-compact:var(--sm-space-sm);
--sm-trace-color:#d18616;
--sm-space-2xs:2px;--sm-space-xs:4px;--sm-space-sm:6px;--sm-space-md:8px;--sm-space-lg:12px;--sm-space-xl:16px;--sm-space-2xl:24px;--sm-space-3xl:32px;--sm-space-4xl:48px;
--sm-toolbar-padding:var(--sm-space-sm) var(--sm-space-md);--sm-toolbar-gap:var(--sm-space-md)}
/* The one base look of every screen's text, inputs, dropdowns and buttons. Pages add layout only; they do not restyle these. */
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--sm-font-body)}
input,select,textarea,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:var(--sm-radius-control);padding:var(--sm-space-xs) var(--sm-space-md)}
button{background:var(--vscode-button-secondaryBackground);cursor:pointer}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:disabled{opacity:.55;cursor:default}
:root:has(body.vscode-light),:root:has(body.vscode-high-contrast-light){--sm-trace-color:#a85e00}
@media (prefers-color-scheme: light){:root:not(:has(body[class*="vscode-"])){--sm-trace-color:#a85e00}}
`;

/**
 * Standard component sizes. Include after a page's own styles so one definition wins everywhere:
 * controls are 26px / 13px, and 22px / 12px inside tables.
 */
export const COMPONENT_STYLES = `
/* One keyboard-focus line for every control on every screen. Without it the browser draws its own ring in the system accent colour. */
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
input[aria-invalid=true],select[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground,var(--vscode-input-background))}
.table-wrap .cell input[aria-invalid=true],.table-wrap .cell select[aria-invalid=true]{border-color:var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground,var(--vscode-input-background))}
.cell:has([aria-invalid=true]),.data-table td:has([aria-invalid=true]){background:var(--vscode-inputValidation-errorBackground,var(--vscode-input-background));box-shadow:inset 0 0 0 1px var(--vscode-inputValidation-errorBorder)}
/* Number up/down: one button width split into upper and lower chevrons, everywhere; the browser's spin buttons are hidden. */
input[type=number]{appearance:textfield}input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{appearance:none;margin:0}
.stepper-buttons{display:flex;flex-direction:column;flex:0 0 20px;width:20px;height:var(--sm-control-height-compact)}
.stepper-buttons>button{display:flex;align-items:center;justify-content:center;flex:1 1 0;min-height:0;height:auto;width:100%;padding:0;border:0;border-radius:0;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}
.stepper-buttons>button:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground)}
.stepper-buttons>button>.codicon{font-size:10px;line-height:1}
.number-stepper{position:relative;display:inline-flex;align-items:center;min-width:0}.number-stepper>input{flex:1 1 auto;min-width:0;padding-right:22px}.number-stepper>.stepper-buttons{position:absolute;right:1px;top:50%;transform:translateY(-50%)}
/* Adding a row to any table: the table's last row is one dashed button as wide as the table. Blue when the row fits, error red when it will not. */
button.add-row-button{--add-row-color:var(--vscode-charts-blue);box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:var(--sm-control-height);min-height:0;padding:0;border-radius:var(--sm-radius-md);font-size:var(--sm-font-small);cursor:pointer;color:color-mix(in srgb,var(--add-row-color) 70%,var(--vscode-foreground));background:color-mix(in srgb,var(--add-row-color) 12%,var(--vscode-editor-background));border:1px dashed color-mix(in srgb,var(--add-row-color) 50%,var(--vscode-editor-background))}
button.add-row-button.is-full{--add-row-color:var(--vscode-errorForeground)}
button.add-row-button:hover{background:color-mix(in srgb,var(--add-row-color) 26%,var(--vscode-editor-background))}
.data-table td.add-row-cell{padding:var(--sm-space-sm) var(--sm-space-md);border-bottom:0}
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select{box-sizing:border-box;height:var(--sm-control-height);min-height:0;padding-top:0;padding-bottom:0;font-size:var(--sm-font-body);border-radius:var(--sm-radius-control)}
.choice-group>button,.segmented>button,.content-mode>button{box-sizing:border-box;height:var(--sm-control-height);min-height:0;padding:0 var(--sm-control-padding-x);font-size:var(--sm-font-body);line-height:1}
:is(.toolbar,.view-toolbar,.section-heading,.dialog-actions,.range-actions,footer)>button:not(.icon-button),button.primary:not(.icon-button){box-sizing:border-box;height:var(--sm-control-height);min-height:0;padding:0 var(--sm-control-padding-x);font-size:var(--sm-font-body);line-height:1;border-radius:var(--sm-radius-control)}
:is(.cell,.data-table td) input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),:is(.cell,.data-table td) select{height:var(--sm-control-height-compact);font-size:var(--sm-font-small)}
:is(.cell,.data-table td) .choice-group>button{height:var(--sm-control-height-compact);min-height:0;padding:0 var(--sm-control-padding-x-compact);font-size:var(--sm-font-small)}
.toolbar,.view-toolbar{gap:var(--sm-toolbar-gap)}
/* In toolbars a labelled choice reads inline, like the checkboxes beside it. */
:is(.axis-mode,.chart-axis-mode).choice-field{flex-direction:row;align-items:center;gap:var(--sm-space-sm)}
/* Icon buttons inside a joined group keep the standard hover shape. */
.segmented>button.icon-button{border-radius:var(--sm-radius-control)}
`;
