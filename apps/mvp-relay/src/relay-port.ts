/** The only transport contract used by the forwarding core. No Node/Worker types. */
export interface RelaySocket {
  readonly id: string;
  readonly bufferedAmount: number;
  send(frame: string | Uint8Array): void | Promise<void>;
  close(code: number, reason: string): void;
}

export interface RelayHostPrincipal { routeId: string }

export interface RelayLimits {
  maxClientsPerRoute: number;
  maxControlFrameBytes: number;
  maxCiphertextFrameBytes: number;
  maxBufferedBytes: number;
  maxUnackedFrames: number;
  maxSocketMessagesPerSecond: number;
  maxSocketBytesPerSecond: number;
  maxRouteBytesPerSecond: number;
  maxRouteConnectionsPerMinute: number;
  pairTimeoutMs: number;
  controlHeartbeatIntervalMs: number;
  controlIdleTimeoutMs: number;
  dataIdleTimeoutMs: number;
}

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxClientsPerRoute: 64,
  maxControlFrameBytes: 64 * 1024,
  maxCiphertextFrameBytes: 256 * 1024 + 1024,
  maxBufferedBytes: 1024 * 1024,
  maxUnackedFrames: 256,
  maxSocketMessagesPerSecond: 240,
  maxSocketBytesPerSecond: 2 * 1024 * 1024,
  maxRouteBytesPerSecond: 8 * 1024 * 1024,
  maxRouteConnectionsPerMinute: 120,
  pairTimeoutMs: 15_000,
  controlHeartbeatIntervalMs: 10_000,
  controlIdleTimeoutMs: 30_000,
  dataIdleTimeoutMs: 90_000,
});

export const RELAY_CLOSE = Object.freeze({
  BAD_FRAME: 4400, UNAUTHORIZED: 4401, QUOTA_EXCEEDED: 4403, TIMEOUT: 4408,
  STALE_GENERATION: 4409, FRAME_TOO_LARGE: 4413, RATE_LIMITED: 4429,
  RESYNC_REQUIRED: 4503, REPLACED: 4001, PEER_CLOSED: 4002, SHUTDOWN: 1001,
});

export type RelayReason = keyof typeof RELAY_CLOSE;

export interface RelayMetric {
  name: "routes_online" | "control_connections" | "client_connections" | "pairs_active"
    | "pair_duration_ms" | "bytes_forwarded" | "connect_rejected_total"
    | "backpressure_close_total" | "socket_closed_total";
  value: number;
  direction?: "client_to_host" | "host_to_client";
  reason?: RelayReason;
}

/** Observers receive bounded categories and counts, never IDs, credentials or frames. */
export interface RelayObserver { record(metric: RelayMetric): void }

export interface RelaySocketAttachment {
  v: 1;
  socketId: string;
  role: "control" | "client" | "data";
  connectionId?: string;
  generation: number;
  attachedAt: number;
  lastSeenAt: number;
  nextSequence: number;
  lastAckSequence: number;
  unacked: Array<{ sequence: number; bytes: number }>;
}

export interface RelayRoomSnapshot {
  v: 1;
  routeId: string;
  controlGeneration: number;
  lastPingAt?: number;
  outstandingPing?: string;
  sockets: RelaySocketAttachment[];
}

export interface RelayPort {
  attachControl(socket: RelaySocket, principal: RelayHostPrincipal, generation: number): Promise<void>;
  attachClient(socket: RelaySocket): Promise<string>;
  attachData(socket: RelaySocket, principal: RelayHostPrincipal, connectionId: string, generation: number): Promise<void>;
  receive(socketId: string, frame: string | Uint8Array): Promise<void>;
  detach(socketId: string): Promise<void>;
  tick(now?: number): Promise<void>;
  snapshot(): RelayRoomSnapshot;
  restoreSocket(socket: RelaySocket, attachment: RelaySocketAttachment): void;
  dispose(): void;
}

export class RelayError extends Error {
  constructor(readonly reason: RelayReason, readonly statusCode = 400) { super(reason); }
}
