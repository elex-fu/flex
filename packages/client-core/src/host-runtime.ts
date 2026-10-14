import type { ClientState, ClientStore, Unsubscribe } from "./types.js";

/** One owner contains the connection, RPC, outbox and domain replica. */
export interface HostRuntime {
  readonly store: ClientStore;
  bindHostOwner?(hostId: string): void;
  start(): Promise<void>;
  stop(): void;
  getState(): ClientState;
  onState(handler: (state: ClientState) => void): Unsubscribe;
  forgetLocalHost?(hostId: string): Promise<void>;
}
