export type Unsubscribe = () => void;
export type ConnectionState = "idle" | "connecting" | "authenticating" | "online" | "degraded" | "reconnecting" | "failed" | "closed";
export type SyncState = "unknown" | "catching_up" | "synced" | "resync_required";
export type EndpointAvailability = "unknown" | "available" | "unavailable";
export type ConnectionEndpoint = {
  id: string;
  availability: EndpointAvailability;
  lastRttMs?: number;
} & ({ kind: "direct-https"; source: "tailscale" | "lan" | "manual"; baseUrl: string }
  | { kind: "relay-wss"; relayUrl: string; routeId: string });

export interface HostProfile {
  hostId: string;
  label: string;
  hostPublicKey: string;
  signingPublicKey: string;
  fingerprint: string;
  endpoints: ConnectionEndpoint[];
  preferredEndpointId?: string;
}

/** The Noise implementation cannot use nonextractable WebCrypto X25519 keys.
 * Only this bounded, revocable token is persisted; static secret keys stay in memory. */
export interface DeviceCredential {
  hostId: string;
  deviceId: string;
  refreshCredential: string;
  expiresAt: string;
  scopes: string[];
  storage: "short-lived-refresh";
}

export interface ClientErrorInfo { code: string; message: string }
export interface ClientState {
  connection: ConnectionState;
  sync: SyncState;
  transportGeneration: number;
  pairingRequired: boolean;
  endpointId?: string;
  transportKind?: "direct" | "relay";
  profile?: HostProfile;
  error?: ClientErrorInfo;
  securityLevel?: "http-only-cookie" | "short-lived-refresh";
}

export interface TransportClose { code: number; reason: string }
/** How the physical connection authenticated. This lets the core distinguish
 * a same-origin HttpOnly browser session from a Hosted App device bearer, and
 * an anonymous Relay pairing channel from an authenticated Noise IK channel. */
export type TransportAuthentication = "direct-cookie" | "direct-device-ticket" | "relay-nk" | "relay-ik";
export interface ClientTransport {
  readonly id: string;
  readonly kind: "direct" | "relay";
  readonly generation: number;
  readonly deviceId?: string | undefined;
  readonly authentication?: TransportAuthentication | undefined;
  send(frame: string): Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: string) => void): Unsubscribe;
  onClose(handler: (close: TransportClose) => void): Unsubscribe;
}

export interface PendingCommand {
  commandId: string;
  hostId: string;
  method: string;
  payloadHash: string;
  payload: unknown;
  createdAt: string;
  state: "queued" | "sent" | "receipt_unknown" | "accepted" | "terminal";
  result?: unknown;
  error?: ClientErrorInfo;
  outcomeUnknown?: boolean;
  /** Persisted before a mutation crosses the sender boundary. Never infer absence from a missing receipt. */
  dispatchState?: "not_dispatched" | "possibly_dispatched";
}

export interface ClientStore {
  listProfiles(): Promise<HostProfile[]>;
  getProfile(hostId: string): Promise<HostProfile | undefined>;
  putProfile(profile: HostProfile): Promise<void>;
  getSelectedHost(): Promise<string | undefined>;
  setSelectedHost(hostId: string): Promise<void>;
  getCredential(hostId: string): Promise<DeviceCredential | undefined>;
  putCredential(credential: DeviceCredential): Promise<void>;
  deleteCredential(hostId: string): Promise<void>;
  listCommands(hostId: string): Promise<PendingCommand[]>;
  getCommand(commandId: string): Promise<PendingCommand | undefined>;
  putCommand(command: PendingCommand): Promise<void>;
}
