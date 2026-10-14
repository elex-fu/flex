import type { HibernatingSocket, ObjectState, ObjectStorage } from "./runtime.js";

export class MemoryStorage implements ObjectStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(time: number | Date): Promise<void> { this.alarm = +time; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

export class MemoryState implements ObjectState {
  readonly storage = new MemoryStorage();
  readonly sockets: HibernatingSocket[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => undefined);
    return result;
  }
  acceptWebSocket(socket: HibernatingSocket): void { this.sockets.push(socket); }
  getWebSockets(): HibernatingSocket[] { return this.sockets.filter((socket) => socket.readyState !== 3); }
}
