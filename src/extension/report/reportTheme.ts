/**
 * The VS Code theme variables the SigMixa pages use, so a report looks like SigMixa outside VS Code.
 * Follows the browser's light/dark preference (VS Code "Dark Modern" / "Light Modern" colours).
 */
const DARK = `--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;
--vscode-panel-border:#2b2b2b;--vscode-widget-border:#313131;--vscode-descriptionForeground:#9d9d9d;--vscode-icon-foreground:#cccccc;
--vscode-focusBorder:#0078d4;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-border:transparent;--vscode-button-secondaryBackground:#313131;
--vscode-list-hoverBackground:#2a2d2e;--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-editorHoverWidget-background:#202020;
--vscode-editorCursor-foreground:#ffffff;--vscode-charts-red:#f14c4c;--vscode-charts-blue:#3794ff;--vscode-charts-orange:#d18616;--vscode-charts-green:#89d185;--vscode-charts-purple:#b180d7;
--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;--vscode-textLink-foreground:#4daafc;--vscode-editorGroupHeader-tabsBackground:#181818;
--vscode-menu-background:#1f1f1f;--vscode-menu-border:#454545;--vscode-menu-selectionBackground:#0078d4;color-scheme:dark;`;

const LIGHT = `--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;--vscode-foreground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;
--vscode-panel-border:#e5e5e5;--vscode-widget-border:#e5e5e5;--vscode-descriptionForeground:#717171;--vscode-icon-foreground:#3b3b3b;
--vscode-focusBorder:#005fb8;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;
--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-border:transparent;--vscode-button-secondaryBackground:#e5e5e5;
--vscode-list-hoverBackground:#f2f2f2;--vscode-toolbar-hoverBackground:#b8b8b850;--vscode-editorHoverWidget-background:#f8f8f8;
--vscode-editorCursor-foreground:#000000;--vscode-charts-red:#e51400;--vscode-charts-blue:#1a85ff;--vscode-charts-orange:#d18616;--vscode-charts-green:#388a34;--vscode-charts-purple:#652d90;
--vscode-errorForeground:#e51400;--vscode-editorWarning-foreground:#bf8803;--vscode-textLink-foreground:#005fb8;--vscode-editorGroupHeader-tabsBackground:#f8f8f8;
--vscode-menu-background:#ffffff;--vscode-menu-border:#cecece;--vscode-menu-selectionBackground:#005fb8;color-scheme:light;`;

export const REPORT_THEME = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Meiryo",sans-serif;--vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;${DARK}}
@media (prefers-color-scheme: light){:root{${LIGHT}}}`;
