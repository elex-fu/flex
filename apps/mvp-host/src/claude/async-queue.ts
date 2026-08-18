export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("Cannot push to a closed queue");
    const resolve = this.waiters.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
