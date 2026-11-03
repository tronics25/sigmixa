type Typed = Float64Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;

/**
 * A growable typed array: values live outside the JavaScript heap, a few bytes each. Made through one class per element
 * type (`F64Column`…), each with its own `push`, so the engine keeps every push specialized to one array type.
 */
export abstract class Column<A extends Typed> {
  a: A; n = 0;
  constructor(size = 16) { this.a = this.make(size); }
  protected abstract make(size: number): A;
  protected abstract copy(): Column<A>;
  abstract push(value: number): void;
  get capacity(): number { return this.a.length; }
  /** `exact`: room for `size` values and no more (an estimate of the final size), instead of growing by half again. */
  reserve(size: number, exact = false): void {
    if (size <= this.a.length) return;
    const next = this.make(Math.max(size, exact ? 0 : Math.ceil(this.a.length * 1.5), 16)); (next as Uint8Array).set(this.a.subarray(0, this.n) as Uint8Array); this.a = next;
  }
  fill(value: number, count: number): void { this.reserve(this.n + count); this.a.fill(value, this.n, this.n + count); this.n += count; }
  /**
   * Gives back the spare room, when it is more than an eighth: a column reserved from an estimate keeps its few
   * percent, as copying tens of millions of values to give them back would briefly need room for both.
   */
  trim(): void { if (this.a.length - this.n > this.n / 8) { const next = this.make(this.n); (next as Uint8Array).set(this.a.subarray(0, this.n) as Uint8Array); this.a = next; } }
  /** Reorders the values: position `index` gets the value that was at `order[index]`. */
  permute(order: Uint32Array): void { const next = this.make(Math.max(16, this.n)); for (let index = 0; index < this.n; index++) next[index] = this.a[order[index]]; this.a = next; }
  clone(): Column<A> { const copy = this.copy(); copy.a = this.a.slice(0, Math.max(1, this.n)) as A; copy.n = this.n; return copy; }
}

export class F64Column extends Column<Float64Array> {
  protected make(size: number): Float64Array { return new Float64Array(size); }
  protected copy(): F64Column { return new F64Column(1); }
  push(value: number): void { if (this.n === this.a.length) this.reserve(this.n + 1); this.a[this.n++] = value; }
}
export class U32Column extends Column<Uint32Array> {
  protected make(size: number): Uint32Array { return new Uint32Array(size); }
  protected copy(): U32Column { return new U32Column(1); }
  push(value: number): void { if (this.n === this.a.length) this.reserve(this.n + 1); this.a[this.n++] = value; }
}
export class U16Column extends Column<Uint16Array> {
  protected make(size: number): Uint16Array { return new Uint16Array(size); }
  protected copy(): U16Column { return new U16Column(1); }
  push(value: number): void { if (this.n === this.a.length) this.reserve(this.n + 1); this.a[this.n++] = value; }
}
export class U8Column extends Column<Uint8Array> {
  protected make(size: number): Uint8Array { return new Uint8Array(size); }
  protected copy(): U8Column { return new U8Column(1); }
  push(value: number): void { if (this.n === this.a.length) this.reserve(this.n + 1); this.a[this.n++] = value; }
}
export class I32Column extends Column<Int32Array> {
  protected make(size: number): Int32Array { return new Int32Array(size); }
  protected copy(): I32Column { return new I32Column(1); }
  push(value: number): void { if (this.n === this.a.length) this.reserve(this.n + 1); this.a[this.n++] = value; }
}

/** Indexes 0..count-1 sorted by `compare`, equal ones kept in their order. */
export function stableOrder(count: number, compare: (left: number, right: number) => number): Uint32Array {
  const order = new Uint32Array(count); for (let index = 0; index < count; index++) order[index] = index;
  return order.sort((left, right) => compare(left, right) || left - right);
}
