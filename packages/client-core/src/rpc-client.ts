import { MAX_APPLICATION_FRAME_BYTES, parseApplicationFrame } from "@flyx/mvp-protocol";
import type { SessionEvent } from "@flyx/mvp-protocol";
import { ClientError, isRecord, Signal } from "./common.js";
import type { ClientTransport, Unsubscribe } from "./types.js";

interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
export class RpcClient {
  private transport: ClientTransport | undefined;
  private off: Unsubscribe[] = [];
  private pending = new Map<string, Pending>();
  private events = new Signal<SessionEvent>();
  private helloPending: Pending | undefined;
  private pongs = new Signal<string>();
  private errors = new Signal<ClientError>();
  constructor(private timeoutMs = 30_000) {}
  get generation(): number { return this.transport?.generation ?? -1; }
  onEvent(handler: (event: SessionEvent) => void): Unsubscribe { return this.events.subscribe(handler); }
  onPong(handler: (nonce: string) => void): Unsubscribe { return this.pongs.subscribe(handler); }
  onError(handler: (error: ClientError) => void): Unsubscribe { return this.errors.subscribe(handler); }

  bind(transport: ClientTransport): void {
    this.unbind();
    this.transport = transport;
    this.off = [transport.onMessage((text) => {
      if (this.transport !== transport) return;
      let frame: unknown;
      try { frame = parseApplicationFrame(text); }
      catch (error) { console.error("AUDIT PARSE", error); transport.close(1002, "INVALID_FRAME"); return; }
      if (!isRecord(frame)) return;
      if (frame.type === "protocol.error" && (frame.transportGeneration === undefined || frame.transportGeneration === transport.generation) && isRecord(frame.error)) {
        const error = new ClientError(String(frame.error.code), String(frame.error.message));
        this.errors.emit(error);
        this.unbind(error);
        transport.close(1002, "PROTOCOL_ERROR");
        return;
      }
      if (frame.transportGeneration !== transport.generation) return;
      if (frame.type === "response" && typeof frame.id === "string") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(frame.payload);
        else {
          const error = isRecord(frame.error) ? frame.error : {};
          pending.reject(new ClientError(typeof error.code === "string" ? error.code : "RPC_FAILED", typeof error.message === "string" ? error.message : "RPC failed", error.details));
        }
      } else if (frame.type === "event") {
        this.events.emit(frame.event as SessionEvent);
      } else if (frame.type === "server.hello") {
        if (this.helloPending) { clearTimeout(this.helloPending.timer); this.helloPending.resolve(frame); this.helloPending = undefined; }
      } else if (frame.type === "ping" && typeof frame.nonce === "string") {
        void this.send({ type: "pong", nonce: frame.nonce }).catch(() => transport.close(1011, "PONG_FAILED"));
      } else if (frame.type === "pong" && typeof frame.nonce === "string") this.pongs.emit(frame.nonce);
    }), transport.onClose((close) => {
      if (this.transport !== transport) return;
      const code = /(?:DEVICE_REVOKED|AUTHENTICATION_REQUIRED|PAIRING_REQUIRED|CREDENTIAL_EXPIRED)/.exec(close.reason)?.[0] ?? "CONNECTION_CLOSED";
      const error = new ClientError(code, code === "CONNECTION_CLOSED" ? "Host connection closed" : "Device authorization is no longer valid");
      if (code !== "CONNECTION_CLOSED") this.errors.emit(error);
      this.unbind(error);
    })];
  }

  unbind(error = new ClientError("CONNECTION_REPLACED", "Host connection was replaced")): void {
    this.transport = undefined;
    for (const off of this.off) off();
    this.off = [];
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.helloPending) { clearTimeout(this.helloPending.timer); this.helloPending.reject(error); this.helloPending = undefined; }
  }

  private async send(frame: Record<string, unknown>): Promise<void> {
    const transport = this.transport;
    if (!transport) throw new ClientError("NOT_CONNECTED", "Host is not connected");
    const encoded = JSON.stringify({ ...frame, transportGeneration: transport.generation });
    if (new TextEncoder().encode(encoded).byteLength > MAX_APPLICATION_FRAME_BYTES) throw new ClientError("FRAME_TOO_LARGE", "Request exceeds the application frame limit");
    await transport.send(encoded);
  }

  async hello(profile: { hostId: string; fingerprint: string }, deviceId?: string): Promise<Record<string, unknown>> {
    const generation = this.generation;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.helloPending = undefined; reject(new ClientError("HELLO_TIMEOUT", "Host did not finish protocol negotiation")); }, 10_000);
      this.helloPending = { resolve: (value) => resolve(value as Record<string, unknown>), reject, timer };
    });
    void this.send({ type: "client.hello", hostId: profile.hostId, clientId: "flyx-web", ...(deviceId ? { deviceId } : {}), protocol: { min: 2, max: 2 }, capabilities: ["heartbeat", "transport-neutral-rpc", "durable-outbox", "timeline-watermark"], requiredCapabilities: [] }).catch((error: unknown) => {
      if (this.helloPending) { clearTimeout(this.helloPending.timer); this.helloPending.reject(error); this.helloPending = undefined; }
    });
    const hello = await response;
    if (this.generation !== generation) throw new ClientError("CONNECTION_REPLACED", "Host connection changed during negotiation");
    if (hello.hostId !== profile.hostId || hello.hostFingerprint !== profile.fingerprint) throw new ClientError("IDENTITY_MISMATCH", "Endpoint identity differs from the pinned Host");
    if (hello.protocolVersion !== 2) throw new ClientError("PROTOCOL_UNSUPPORTED", "Host does not support protocol version 2");
    return hello;
  }

  request<T>(method: string, payload: unknown = {}, commandId?: string): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new ClientError("REQUEST_TIMEOUT", "Host request timed out")); }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void this.send({ type: "request", id, method, payload, ...(commandId ? { commandId } : {}) }).catch((error: unknown) => {
        if (this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  ping(nonce: string): Promise<void> { return this.send({ type: "ping", nonce }); }
}
