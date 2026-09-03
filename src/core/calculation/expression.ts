export interface CompiledExpression {
  readonly variables: ReadonlySet<string>;
  evaluate(values: Readonly<Record<string, number>>): number;
}

type Node =
  | { type: 'number'; value: number }
  | { type: 'variable'; name: string }
  | { type: 'unary'; operator: '+' | '-'; value: Node }
  | { type: 'binary'; operator: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { type: 'call'; name: string; arguments: Node[] };

interface Token { readonly type: 'number' | 'identifier' | 'operator' | 'left' | 'right' | 'comma' | 'end'; readonly text: string; }

export function compileExpression(source: string): CompiledExpression {
  const parser = new Parser(tokenize(source)); const root = parser.parse();
  const variables = new Set<string>(); collect(root, variables);
  return {
    variables,
    evaluate(values) {
      const result = evaluate(root, values);
      if (!Number.isFinite(result)) throw new Error('Expression result is not finite.');
      return result;
    },
  };
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Node {
    const result = this.expression();
    if (this.current().type !== 'end') throw new Error(`Unexpected token “${this.current().text}”.`);
    return result;
  }

  private expression(): Node {
    let result = this.term();
    while (this.matchOperator('+', '-')) { const operator = this.previous().text as '+' | '-'; result = { type: 'binary', operator, left: result, right: this.term() }; }
    return result;
  }

  private term(): Node {
    let result = this.power();
    while (this.matchOperator('*', '/')) { const operator = this.previous().text as '*' | '/'; result = { type: 'binary', operator, left: result, right: this.power() }; }
    return result;
  }

  private power(): Node {
    let result = this.unary();
    if (this.matchOperator('^')) result = { type: 'binary', operator: '^', left: result, right: this.power() };
    return result;
  }

  private unary(): Node {
    if (this.matchOperator('+', '-')) return { type: 'unary', operator: this.previous().text as '+' | '-', value: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    const token = this.current();
    if (token.type === 'number') { this.index++; return { type: 'number', value: Number(token.text) }; }
    if (token.type === 'identifier') {
      this.index++;
      if (this.current().type !== 'left') return { type: 'variable', name: token.text };
      this.index++; const args: Node[] = [];
      if (this.current().type !== 'right') {
        do { args.push(this.expression()); } while (this.match('comma'));
      }
      this.consume('right', 'Expected “)” after function arguments.');
      return { type: 'call', name: token.text, arguments: args };
    }
    if (this.match('left')) { const result = this.expression(); this.consume('right', 'Expected “)”.'); return result; }
    throw new Error(`Expected a number, variable, or function at “${token.text || 'end'}”.`);
  }

  private current(): Token { return this.tokens[this.index]; }
  private previous(): Token { return this.tokens[this.index - 1]; }
  private match(type: Token['type']): boolean { if (this.current().type !== type) return false; this.index++; return true; }
  private matchOperator(...operators: string[]): boolean { if (this.current().type !== 'operator' || !operators.includes(this.current().text)) return false; this.index++; return true; }
  private consume(type: Token['type'], message: string): void { if (!this.match(type)) throw new Error(message); }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) { index++; continue; }
    if (/[0-9.]/.test(character)) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error(`Invalid number at position ${index + 1}.`);
      tokens.push({ type: 'number', text: match[0] }); index += match[0].length; continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      tokens.push({ type: 'identifier', text: match[0] }); index += match[0].length; continue;
    }
    if (character === '[') {
      const end = source.indexOf(']', index + 1);
      if (end < 0) throw new Error(`Expected “]” for Signal name at position ${index + 1}.`);
      const name = source.slice(index + 1, end).trim();
      if (!name) throw new Error(`Signal name is empty at position ${index + 1}.`);
      tokens.push({ type: 'identifier', text: name }); index = end + 1; continue;
    }
    const type = character === '(' ? 'left' : character === ')' ? 'right' : character === ',' ? 'comma' : '+-*/^'.includes(character) ? 'operator' : undefined;
    if (!type) throw new Error(`Unsupported character “${character}” at position ${index + 1}.`);
    tokens.push({ type, text: character }); index++;
  }
  tokens.push({ type: 'end', text: '' }); return tokens;
}

function collect(node: Node, variables: Set<string>): void {
  if (node.type === 'variable') variables.add(node.name);
  else if (node.type === 'unary') collect(node.value, variables);
  else if (node.type === 'binary') { collect(node.left, variables); collect(node.right, variables); }
  else if (node.type === 'call') node.arguments.forEach((item) => collect(item, variables));
}

function evaluate(node: Node, values: Readonly<Record<string, number>>): number {
  if (node.type === 'number') return node.value;
  if (node.type === 'variable') {
    const value = values[node.name]; if (!Number.isFinite(value)) throw new Error(`Variable “${node.name}” is missing or invalid.`); return value;
  }
  if (node.type === 'unary') { const value = evaluate(node.value, values); return node.operator === '-' ? -value : value; }
  if (node.type === 'binary') {
    const left = evaluate(node.left, values); const right = evaluate(node.right, values);
    if (node.operator === '+') return left + right; if (node.operator === '-') return left - right; if (node.operator === '*') return left * right;
    if (node.operator === '/') { if (right === 0) throw new Error('Division by zero.'); return left / right; }
    return left ** right;
  }
  const args = node.arguments.map((item) => evaluate(item, values));
  if (node.name === 'abs' && args.length === 1) return Math.abs(args[0]);
  if (node.name === 'sqrt' && args.length === 1) return Math.sqrt(args[0]);
  if (node.name === 'min' && args.length >= 1) return Math.min(...args);
  if (node.name === 'max' && args.length >= 1) return Math.max(...args);
  if (node.name === 'clamp' && args.length === 3) return Math.min(args[2], Math.max(args[1], args[0]));
  throw new Error(`Unknown function “${node.name}” or invalid argument count.`);
}
