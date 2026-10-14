/** The Workers capabilities used by this adapter, kept separate from Node types. */
export interface HibernatingSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(frame: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface ObjectState {
  readonly storage: ObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: HibernatingSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatingSocket[];
  setHibernatableWebSocketEventTimeout?(milliseconds: number): void;
}

export interface ObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RelayEnvironment {
  RELAY_ROOMS: ObjectNamespace;
  RELAY_QUOTAS: ObjectNamespace;
  /** No secret is needed when anonymous creation is explicitly enabled. */
  RELAY_REGISTRATION_TOKEN?: string;
  RELAY_ALLOW_ANONYMOUS_REGISTRATION?: string;
  RELAY_ALLOW_INSECURE_LOCAL?: string;
  RELAY_ALLOWED_ORIGINS?: string;
  RELAY_MAX_CREATES_PER_IP_HOUR?: string;
  RELAY_MAX_CREATES_PER_DAY?: string;
  RELAY_MAX_CONNECTS_PER_IP_MINUTE?: string;
  RELAY_MAX_CLIENTS_PER_ROUTE?: string;
  RELAY_MAX_CONNECTS_PER_ROUTE_MINUTE?: string;
  RELAY_MAX_FRAMES_PER_SOCKET_SECOND?: string;
  RELAY_MAX_BYTES_PER_SOCKET_SECOND?: string;
  RELAY_MAX_ROUTE_BYTES_PER_SECOND?: string;
  RELAY_IDLE_TIMEOUT_MS?: string;
  RELAY_PENDING_TIMEOUT_MS?: string;
  RELAY_METRICS?: {
    writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
  };
}

export interface CloudflareRuntime {
  now(): number;
  createPair(): { client: HibernatingSocket; server: HibernatingSocket };
  upgrade(socket: HibernatingSocket, headers: Headers): Response;
}

export const defaultRuntime: CloudflareRuntime = {
  now: () => Date.now(),
  createPair() {
    const runtime = globalThis as unknown as {
      WebSocketPair: new () => { 0: HibernatingSocket; 1: HibernatingSocket };
    };
    const pair = new runtime.WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  upgrade(socket, headers) {
    const init: ResponseInit & { webSocket: HibernatingSocket } = {
      status: 101,
      headers,
      webSocket: socket,
    };
    return new Response(null, init);
  },
};

export function stubFor(namespace: ObjectNamespace, name: string) {
  return namespace.get(namespace.idFromName(name));
}
