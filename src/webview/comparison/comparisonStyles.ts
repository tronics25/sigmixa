/** Layout of the comparison page. Card, options-panel and menu rules match the Visualize tab. */
export const COMPARISON_STYLES = `
*{box-sizing:border-box}
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--sm-font-body)}
#app{height:100vh;display:flex;flex-direction:column;min-width:0}

input[type=search],input[type=text],button{cursor:pointer}
.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:var(--sm-font-small)}
.view-toolbar{display:flex;align-items:center;gap:var(--sm-toolbar-gap);min-height:38px;padding:var(--sm-toolbar-padding);border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}

.targets{flex:0 0 auto;max-height:34vh;overflow:auto;border-bottom:1px solid var(--vscode-panel-border)}
.targets-head{display:flex;align-items:center;gap:var(--sm-space-md);padding:var(--sm-space-sm) var(--sm-space-lg)}
.targets-head strong{font-size:var(--sm-font-section)}
.target-row{display:grid;grid-template-columns:16px 20px 28px 18px minmax(160px,1fr) auto 28px 28px;gap:var(--sm-space-md);align-items:center;min-height:32px;padding:var(--sm-space-2xs) var(--sm-space-lg);border-top:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent)}
.target-row:hover{background:var(--vscode-list-hoverBackground)}
.target-row input{margin:0}
.target-row.hidden-target .target-label{opacity:.55}
.line-sample{width:28px;height:0;border-top:2px solid var(--vscode-foreground)}
.target-label{min-width:0;display:flex;flex-direction:column}
.target-label strong,.target-label small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.target-label strong{font-weight:var(--sm-weight-semibold)}
.target-label small{color:var(--vscode-descriptionForeground);font-size:var(--sm-font-caption)}
.target-row .kind{color:var(--vscode-descriptionForeground)}
.target-align{display:flex;align-items:center;gap:var(--sm-space-2xs);white-space:nowrap}
.target-align output{min-width:112px;padding:var(--sm-space-2xs) var(--sm-space-md);text-align:center;font:var(--sm-font-small) var(--vscode-editor-font-family);border:1px solid transparent;border-radius:var(--sm-radius-control);cursor:ew-resize;touch-action:none;user-select:none;-webkit-user-select:none}
.target-align output:hover,.target-align output:focus{border-color:var(--vscode-focusBorder);outline:none;background:var(--vscode-list-hoverBackground)}
.target-align output.dragging{border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 14%,transparent)}
.drag-handle{color:var(--vscode-descriptionForeground);cursor:grab}
.target-row.dragging{opacity:.45}
.target-row.drop-before{box-shadow:inset 0 2px 0 var(--vscode-focusBorder)}
.target-row.drop-after{box-shadow:inset 0 -2px 0 var(--vscode-focusBorder)}
.target-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.target-status{display:flex;align-items:center;gap:var(--sm-space-xs);font-size:var(--sm-font-small);white-space:nowrap}
.target-status.error{color:var(--vscode-errorForeground);white-space:normal}
.target-status .codicon-loading{animation:spin 1.2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.visualize-workspace{display:flex;flex:1;min-height:0;min-width:0}
.visualize-content{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.visualize-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:var(--sm-space-lg);padding-bottom:var(--sm-space-lg)}
.visualize-card{flex:0 0 auto;margin:0 var(--sm-space-lg);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-card);overflow:hidden;display:flex;flex-direction:column}
.visualize-card:first-child{margin-top:var(--sm-space-lg)}
.visualize-card.options-editing{border-color:var(--vscode-focusBorder)}
.visualize-card.view-unconfigured canvas{cursor:pointer}
.visualize-card-header{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sm-space-sm);padding:var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}
.visualize-card-header:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.visualize-card-title{flex:1 1 100px;width:100px;min-width:60px;text-align:left;font-size:var(--sm-font-body);font-weight:var(--sm-weight-semibold);background:transparent;border:0;color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.visualize-card-title:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.visualize-card-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:var(--sm-space-sm);min-width:0;max-width:100%}
.visualize-card-actions>.view-action-group{display:flex;align-items:center;gap:var(--sm-space-2xs);flex-wrap:wrap}
.visualize-card-actions>.view-action-group[hidden]{display:none}
.visualize-card-actions>.view-action-group:not([hidden])~.view-action-group:not([hidden]){border-left:1px solid var(--vscode-panel-border);padding-left:var(--sm-space-sm)}
/* As in Visualize: the title starts the legend row; the actions sit on the card's top edge and show on hover. */
.visualize-card{position:relative}
.visualize-list{padding-top:var(--sm-space-md)}
.visualize-card .visualize-card-actions{visibility:hidden}
.visualize-card:hover .visualize-card-actions,.visualize-card-actions:has(:focus-visible){visibility:visible}
.visualize-card.title-inline{overflow:visible}
.visualize-card.title-inline>.chart-legend-group{border-radius:var(--sm-radius-card) var(--sm-radius-card) 0 0}
.visualize-card.title-inline .visualize-card-header{position:absolute;top:-17px;right:var(--sm-space-lg);z-index:7;padding:0;border:0;background:transparent;flex-wrap:nowrap;pointer-events:none}
.visualize-card.title-inline .visualize-card-actions{pointer-events:auto;flex-wrap:nowrap;padding:0 var(--sm-space-xs);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:var(--sm-radius-card);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 2px 8px rgba(0,0,0,.28)}
.chart-legend-group .visualize-card-title{flex:0 0 auto;width:var(--title-width,120px);max-width:100%;margin:0 var(--sm-space-sm) 0 0;padding:var(--sm-space-2xs) var(--sm-space-xs)}
.view-toolbar .icon-text-button{margin:0}
.comparison-range{display:flex;align-items:center;gap:var(--sm-space-sm);min-width:0}.comparison-range[hidden]{display:none}.comparison-range .clip-range{white-space:nowrap;font-size:var(--sm-font-small);font-variant-numeric:tabular-nums}
.visualize-card>.chart-legend-group:empty{display:none}
.graph-notice{display:flex;align-items:center;gap:var(--sm-space-md);margin:var(--sm-space-sm) var(--sm-space-md) 0;padding:var(--sm-space-xs) var(--sm-space-md);border-radius:var(--sm-radius-md);font-size:var(--sm-font-small);background:color-mix(in srgb,var(--vscode-focusBorder) 10%,transparent);border:1px solid color-mix(in srgb,var(--vscode-focusBorder) 40%,transparent)}
.graph-notice[hidden]{display:none}
.chart-legend-group{display:flex;align-items:center;min-width:0}
.legend-warning{color:var(--vscode-editorWarning-foreground);margin-left:var(--sm-space-2xs)}
.chart-canvas-wrap{position:relative}
.view-resizer{flex:0 0 6px;height:6px;cursor:row-resize;touch-action:none;background:var(--vscode-panel-border)}
.view-resizer:hover,.view-resizer:focus-visible{background:var(--vscode-focusBorder);outline:none}
canvas{display:block}

.visualize-options{flex:0 0 310px;width:310px;max-width:42%;min-width:240px;overflow:auto;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.visualize-options[hidden],.view-specific-options[hidden],.options-empty[hidden]{display:none}
.visualize-options>header{display:flex;align-items:center;justify-content:space-between;gap:var(--sm-space-md);padding:var(--sm-space-sm) var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border)}
.options-view-name{display:flex;align-items:center;gap:var(--sm-space-sm);min-width:0;padding:var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);font-size:var(--sm-font-section);font-weight:var(--sm-weight-semibold)}
.options-view-name:empty{display:none}
.options-view-name>.codicon{color:var(--vscode-descriptionForeground)}
.options-empty{padding:0 var(--sm-space-lg)}
.view-settings{padding:0 var(--sm-space-md)}
.display-settings{border-bottom:1px solid var(--vscode-panel-border);margin:0 0 var(--sm-space-xs)}
.display-settings[open]{padding-bottom:var(--sm-space-md)}
.display-settings>summary{padding:var(--sm-space-md) 0;cursor:pointer;font-weight:var(--sm-weight-semibold)}
.settings-row{display:flex;align-items:center;flex-wrap:wrap;gap:var(--sm-space-md);margin:var(--sm-space-xs) 0}
.trajectory-axes{padding:var(--sm-space-md) 0;display:grid;gap:var(--sm-space-sm)}
.trajectory-axis-row{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:center;gap:var(--sm-space-sm);font-size:var(--sm-font-small)}
.trajectory-axis-row select{min-width:0;width:100%}
.visualize-card[data-kind=trajectory] canvas{cursor:grab}
.chart-option{display:flex;align-items:center;gap:var(--sm-space-xs);white-space:nowrap;font-size:var(--sm-font-small)}
.chart-option input{margin:0}
.axis-mode{display:flex;align-items:center;gap:var(--sm-space-sm);white-space:nowrap;font-size:var(--sm-font-small)}

.signal-selector{padding:var(--sm-space-md) 0;overflow-anchor:none}
.signal-selector>input{width:100%}
.selector-group{margin-top:var(--sm-space-xs)}
.selector-group-head{display:grid;grid-template-columns:24px 20px minmax(0,1fr);align-items:center;min-height:28px;font-weight:var(--sm-weight-semibold)}
.selector-group-head>span,.selector-signal>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.selector-expand{padding:1px;background:transparent;border:0}
.selector-signal{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) 22px;align-items:center;min-height:27px;padding-left:var(--sm-space-2xl);font-size:var(--sm-font-small)}
.color-button{width:18px;height:18px;padding:0;border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-control);cursor:pointer;box-shadow:inset 0 0 0 1px #0002}
.color-popup{position:fixed;z-index:30;display:grid;grid-template-columns:repeat(4,24px);gap:var(--sm-space-xs);padding:var(--sm-space-md);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-menu);background:var(--vscode-editor-background);box-shadow:0 3px 12px #0006}
.color-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:var(--sm-radius-md);box-shadow:inset 0 0 0 1px #0004;cursor:pointer}
.color-swatch.selected{border-color:var(--vscode-focusBorder);outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.selector-signal.option-revealed{animation:sm-option-reveal 1.6s ease-out}
@keyframes sm-option-reveal{0%,35%{background:color-mix(in srgb,var(--vscode-focusBorder) 30%,transparent)}100%{background:transparent}}

.context-menu{position:fixed;z-index:20;padding:var(--sm-space-xs);background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));box-shadow:0 4px 14px #0006}
.visualize-context-menu{max-height:calc(100vh - 8px);max-width:calc(100vw - 8px);min-width:210px;overflow:auto;border-radius:var(--sm-radius-menu)}
.visualize-context-menu button{display:flex;align-items:center;gap:var(--sm-space-md);width:100%;min-height:28px;padding:var(--sm-space-xs) var(--sm-space-md);text-align:left;font-size:var(--sm-font-small);border:0;border-radius:var(--sm-radius-control);background:transparent}
.visualize-context-menu button:hover,.visualize-context-menu button:focus-visible{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));outline:none}
.visualize-context-menu button .codicon{flex:0 0 16px;font-size:var(--sm-font-heading)}
.visualize-context-menu button:disabled{opacity:.4;background:transparent;cursor:default}
.visualize-context-menu [role=separator]{height:1px;background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:var(--sm-space-xs) var(--sm-space-sm)}

`;
