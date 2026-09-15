import { compileExpression } from '../calculation/expression';
import type { ManualFrameDefinition } from './manualDefinition';

export interface DefinitionGraphNode { id: string; name: string; kind: 'signal' | 'expression' | 'lookup' | 'filter' | 'missing'; level: number }
export interface DefinitionGraph { nodes: DefinitionGraphNode[]; edges: Array<{ from: string; to: string }>; errors: string[] }
export function definitionGraph(frame: ManualFrameDefinition, targetId: string): DefinitionGraph {
  const graph: DefinitionGraph = { nodes: [], edges: [], errors: [] }; const known = new Map<string, DefinitionGraphNode>();
  const visit = (id: string): DefinitionGraphNode | undefined => {
    const cached = known.get(id); if (cached) return cached;
    if (known.size >= 128) { if (!graph.errors.includes('128-node limit')) graph.errors.push('128-node limit'); return; }
    const direct = frame.signals.find((item) => item.id === id); const derivedIndex = (frame.derivedSignals ?? []).findIndex((item) => item.id === id); const derived = frame.derivedSignals?.[derivedIndex];
    if (!direct && !derived) return;
    const node: DefinitionGraphNode = { id, name: (direct ?? derived)!.name, kind: derived?.operation.type ?? 'signal', level: 0 }; known.set(id, node);
    if (derived) {
      let inputs: string[] = []; try { inputs = derived.operation.type === 'expression' ? [...compileExpression(derived.operation.expression).variables] : [derived.operation.input]; } catch (error) { graph.errors.push(String(error)); }
      for (const name of inputs) {
        const source = frame.signals.find((item) => item.name === name) ?? frame.derivedSignals?.slice(0, derivedIndex).find((item) => item.name === name);
        let parent = source ? visit(source.id) : known.get(`missing:${name}`);
        if (!source && !parent) { parent = { id: `missing:${name}`, name, kind: 'missing', level: 0 }; known.set(parent.id, parent); graph.errors.push(name); }
        if (parent) { graph.edges.push({ from: parent.id, to: node.id }); node.level = Math.max(node.level, parent.level + 1); }
      }
    }
    return node;
  };
  visit(targetId); graph.nodes = [...known.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)); return graph;
}
