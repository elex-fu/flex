import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type JsonRpcId = string | number;
export type JsonObject = Record<string, unknown>;

export type AppServerNotification = {
  method: string;
  params: JsonObject;
};

export type AppServerRequest = AppServerNotification & {
  id: JsonRpcId;
};

export type AppServerClientHandlers = {
  onNotification(notification: AppServerNotification): void;
  onRequest(request: AppServerRequest): void;
  onExit(error: Error): void;
};

export interface AppServerClient {
  start(): Promise<void>;
  request<T = JsonObject>(method: string, params?: JsonObject, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: JsonObject): void;
  respond(id: JsonRpcId, result: JsonObject): boolean;
  respondError(id: JsonRpcId, code: number, message: string): boolean;
  close(): void;
}

export type AppServerClientFactory = (handlers: AppServerClientHandlers) => AppServerClient;

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type RpcErrorShape = { code?: unknown; message?: unknown; data?: unknown };
const MAX_RPC_LINE_BYTES = 2 * 1024 * 1024;

/**
 * Minimal bidirectional JSON-RPC peer for `codex app-server`'s default stdio
 * transport. The app-server intentionally omits the `jsonrpc` field and uses
 * exactly one JSON object per line.
 */
export class StdioAppServerClient implements AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(
    private readonly options: {
      executable: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      args?: readonly string[];
      handlers: AppServerClientHandlers;
    },
  ) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("CODEX_APP_SERVER_CLOSED"));
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async request<T = JsonObject>(method: string, params: JsonObject = {}, timeoutMs = 30_000): Promise<T> {
    await this.start();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  notify(method: string, params: JsonObject = {}): void {
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: JsonObject): boolean {
    return this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): boolean {
    return this.write({ id, error: { code, message } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("CODEX_APP_SERVER_CLOSED"));
    this.lines?.close();
    this.process?.kill("SIGTERM");
    this.process = undefined;
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.options.executable, this.options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    // Always drain stderr so a noisy runtime cannot block. Provider logs may
    // contain local paths, URLs or account metadata, so they are deliberately
    // not copied into remotely visible errors.
    child.stderr.on("data", (_chunk: string) => {});
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
    });

    await this.sendRequest("initialize", {
      clientInfo: { name: "flyx", title: "Flyx Mobile Host", version: "0.0.1" },
      capabilities: { experimentalApi: false },
    }, 30_000);
    this.notify("initialized", {});
  }

  private sendRequest<T>(method: string, params: JsonObject, timeoutMs: number): Promise<T> {
    if (this.closed || !this.process) return Promise.reject(new Error("CODEX_APP_SERVER_UNAVAILABLE"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      if (!this.write({ method, id, params })) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(new Error(`Could not write Codex app-server request: ${method}`));
      }
    });
  }

  private write(message: JsonObject): boolean {
    if (this.closed || !this.process?.stdin.writable) return false;
    try {
      // A false return only signals stream backpressure; the frame was still
      // accepted into Node's write buffer and must not be treated as failure.
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
      this.handleExit(new Error("Codex app-server emitted an oversized JSONL frame"));
      this.process?.kill("SIGTERM");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.handleExit(new Error("Codex app-server emitted invalid JSONL"));
      this.process?.kill("SIGTERM");
      return;
    }
    if (!isRecord(message)) return;
    if ((typeof message.id === "string" || typeof message.id === "number") && ("result" in message || "error" in message) && typeof message.method !== "string") {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        const rpcError = message.error as RpcErrorShape;
        pending.reject(new Error(`Codex ${pending.method} failed (${String(rpcError.code ?? "unknown")}): ${String(rpcError.message ?? "unknown error")}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = isRecord(message.params) ? message.params : {};
    if (typeof message.id === "string" || typeof message.id === "number") {
      this.options.handlers.onRequest({ id: message.id, method: message.method, params });
    } else {
      this.options.handlers.onNotification({ method: message.method, params });
    }
  }

  private handleExit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    this.options.handlers.onExit(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
