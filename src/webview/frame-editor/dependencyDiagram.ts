import { definitionGraph } from '../../core/manual/definitionGraph';
import type { ManualFrameDefinition } from '../../core/manual/manualDefinition';
import { t } from '../shared/i18n';

export function dependencyDiagram(frame: ManualFrameDefinition, target: string, select: (id: string) => void): HTMLElement {
  const graph = definitionGraph(frame, target); const wrap = document.createElement('div'); wrap.className = 'dependency-diagram'; wrap.style.cssText = 'position:relative;overflow:auto;max-height:340px;padding:8px;border-bottom:1px solid var(--vscode-panel-border)';
  const counts = new Map<number, number>(); const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) { const row = counts.get(node.level) ?? 0; counts.set(node.level, row + 1); positions.set(node.id, { x: 10 + node.level * 220, y: 10 + row * 68 }); }
  const width = Math.max(220, ...graph.nodes.map((node) => 210 + node.level * 220)); const height = Math.max(88, ...[...counts.values()].map((count) => count * 68 + 16));
  const content = document.createElement('div'); content.style.cssText = `position:relative;width:${width}px;height:${height}px`; const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.style.cssText = 'position:absolute;inset:0;pointer-events:none'; svg.setAttribute('aria-hidden', 'true');
  for (const edge of graph.edges) { const from = positions.get(edge.from)!; const to = positions.get(edge.to)!; const path = document.createElementNS(ns, 'path'); path.setAttribute('d', `M${from.x + 174},${from.y + 24} C${from.x + 198},${from.y + 24} ${to.x - 24},${to.y + 24} ${to.x - 4},${to.y + 24} l-5,-4 m5,4 l-5,4`); path.setAttribute('stroke', 'var(--vscode-descriptionForeground)'); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '1.5'); svg.append(path); }
  content.append(svg);
  const kinds = { signal: 'Signal', expression: t('Expression', '式'), lookup: t('Linear interpolation', '線形補間'), filter: t('Filter', 'フィルター'), missing: t('Unresolved input', '参照先なし') };
  for (const node of graph.nodes) { const position = positions.get(node.id)!; const button = document.createElement('button'); button.type = 'button'; button.dataset.nodeId = node.id; button.style.cssText = `position:absolute;left:${position.x}px;top:${position.y}px;width:174px;height:48px;text-align:left;padding:5px 8px;border-radius:5px;overflow:hidden;border:1px solid ${node.id === target ? 'var(--vscode-focusBorder)' : node.kind === 'missing' ? 'var(--vscode-errorForeground)' : 'var(--vscode-panel-border)'}`;
    button.title = `${node.name} · ${kinds[node.kind]}`; const kind = document.createElement('small'); kind.textContent = kinds[node.kind]; kind.style.cssText = 'display:block;font-size:10px;color:var(--vscode-descriptionForeground)'; const name = document.createElement('span'); name.textContent = node.name; name.style.cssText = 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; button.append(kind, name); button.disabled = node.kind === 'missing'; button.addEventListener('click', () => select(node.id)); content.append(button);
  }
  wrap.append(content); if (graph.errors.length) { const error = document.createElement('div'); error.className = 'inline-error'; error.textContent = `${t('Check definition', '定義を確認')}: ${graph.errors.join(' · ')}`; wrap.append(error); } return wrap;
}
