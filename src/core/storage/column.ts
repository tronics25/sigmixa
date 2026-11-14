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
/**
 * The stable time order of `times[0..count)` that are already in order in a few runs (rows added after the frames, such
 * as External CSV values): the runs are merged, so a log of tens of millions of rows is not sorted again from scratch.
 */
export function mergedOrder(times: Float64Array, count: number): Uint32Array {
  let order = new Uint32Array(count); for (let index = 0; index < count; index++) order[index] = index;
  const starts: number[] = [0];
  for (let index = 1; index < count; index++) if (times[index] < times[index - 1]) {
    // Many runs (rows far out of order): a plain sort, decided before the list of runs grows.
    if (starts.length >= 64) return stableOrder(count, (left, right) => times[left] - times[right]);
    starts.push(index);
  }
  let next = new Uint32Array(count);
  let runs = [...starts, count];
  while (runs.length > 2) {
    const merged: number[] = [0];
    for (let r = 0; r + 1 < runs.length; r += 2) {
      const from = runs[r]; const middle = runs[r + 1]; const to = r + 2 < runs.length ? runs[r + 2] : middle;
      let left = from; let right = middle; let out = from;
      // Ties keep the earlier run first: stable.
      while (left < middle && right < to) next[out++] = times[order[right]] < times[order[left]] ? order[right++] : order[left++];
      while (left < middle) next[out++] = order[left++];
      while (right < to) next[out++] = order[right++];
      merged.push(to);
    }
    runs = merged; [order, next] = [next, order];
  }
  return order;
}

export function stableOrder(count: number, compare: (left: number, right: number) => number): Uint32Array {
  const order = new Uint32Array(count); for (let index = 0; index < count; index++) order[index] = index;
  return order.sort((left, right) => compare(left, right) || left - right);
}
