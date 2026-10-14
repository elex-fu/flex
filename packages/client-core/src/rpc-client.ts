import {
  AttentionCapability, BOUNDED_CONTENT_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, ContentChunkRequestSchema, ContentChunkSchema, MAX_APPLICATION_FRAME_BYTES,
  OpenViewRequestSchema, OpenViewResponseSchema, parseApplicationFrame, TIMELINE_PROJECTION_CAPABILITY,
  TimelinePageRequestSchema, TimelinePageSchema, TimelineSubscribeRequestSchema, TimelineSubscribeResponseSchema, TimelineUnsubscribeRequestSchema, TimelineUnsubscribeResponseSchema,
} from "@flyx/mvp-protocol";
import type { ContentChunk, ContentChunkRequest, OpenViewRequest, OpenViewResponse, ServerHelloV2, SessionEvent, TimelinePage, TimelinePageRequest, TimelineSubscribeResponse, TimelineUnsubscribeResponse } from "@flyx/mvp-protocol";
import { ClientError, isRecord, Signal } from "./common.js";
import type { ClientTransport, Unsubscribe } from "./types.js";

export const ACCESS_RECEIPTS_CAPABILITY = "access-receipts-v1";
export type AccessReceipt =
  | { found: false; commandId: string }
  | { found: true; commandId: string; method: string; state: "accepted" | "completed" | "failed" | "cancelled" | "outcome_unknown"; response?: unknown; updatedAt?: string };

interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
export class RpcClient {
  private transport: ClientTransport | undefined;
  private off: Unsubscribe[] = [];
  private pending = new Map<string, Pending>();
  private events = new Signal<SessionEvent>();
  private helloPending: Pending | undefined;
  private pongs = new Signal<string>();
  private errors = new Signal<ClientError>();
  private negotiated: ServerHelloV2 | undefined;
  constructor(private timeoutMs = 30_000) {}
  get generation(): number { return this.transport?.generation ?? -1; }
  getNegotiatedHello(): ServerHelloV2 | undefined { return this.negotiated ? structuredClone(this.negotiated) : undefined; }
  supports(capability: string): boolean { return this.negotiated?.capabilities.includes(capability) ?? false; }
  onEvent(handler: (event: SessionEvent) => void): Unsubscribe { return this.events.subscribe(handler); }
  onPong(handler: (nonce: string) => void): Unsubscribe { return this.pongs.subscribe(handler); }
  onError(handler: (error: ClientError) => void): Unsubscribe { return this.errors.subscribe(handler); }

  bind(transport: ClientTransport): void {
    this.unbind();
    this.transport = transport;
    this.off = [transport.onMessage((text) => {
      if (this.transport !== transport) return;
      let frame: unknown;
      try {
        if (new TextEncoder().encode(text).byteLength > (this.negotiated?.maxFrameBytes ?? MAX_APPLICATION_FRAME_BYTES)) throw new ClientError("FRAME_TOO_LARGE", "Response exceeds the negotiated frame limit");
        frame = parseApplicationFrame(text);
      } catch { transport.close(1002, "INVALID_FRAME"); return; }
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
    this.negotiated = undefined;
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
    if (new TextEncoder().encode(encoded).byteLength > (this.negotiated?.maxFrameBytes ?? MAX_APPLICATION_FRAME_BYTES)) throw new ClientError("FRAME_TOO_LARGE", "Request exceeds the application frame limit");
    await transport.send(encoded);
  }

  async hello(profile: { hostId: string; fingerprint: string }, deviceId?: string): Promise<ServerHelloV2> {
    const generation = this.generation;
    if (this.helloPending) throw new ClientError("HELLO_IN_PROGRESS", "Protocol negotiation is already in progress");
    this.negotiated = undefined;
    const response = new Promise<ServerHelloV2>((resolve, reject) => {
      const timer = setTimeout(() => { this.helloPending = undefined; reject(new ClientError("HELLO_TIMEOUT", "Host did not finish protocol negotiation")); }, 10_000);
      this.helloPending = { resolve: (value) => resolve(value as ServerHelloV2), reject, timer };
    });
    void this.send({ type: "client.hello", hostId: profile.hostId, clientId: "flyx-web", ...(deviceId ? { deviceId } : {}), protocol: { min: 2, max: 2 }, capabilities: ["heartbeat", "transport-neutral-rpc", "durable-outbox", "timeline-watermark", TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, AttentionCapability], requiredCapabilities: [] }).catch((error: unknown) => {
      if (this.helloPending) { clearTimeout(this.helloPending.timer); this.helloPending.reject(error); this.helloPending = undefined; }
    });
    const hello = await response;
    if (this.generation !== generation) throw new ClientError("CONNECTION_REPLACED", "Host connection changed during negotiation");
    if (hello.hostId !== profile.hostId || hello.hostFingerprint !== profile.fingerprint) throw new ClientError("IDENTITY_MISMATCH", "Endpoint identity differs from the pinned Host");
    if (hello.protocolVersion !== 2) throw new ClientError("PROTOCOL_UNSUPPORTED", "Host does not support protocol version 2");
    this.negotiated = structuredClone(hello);
    return structuredClone(hello);
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
  private requireCapability(capability: string): void {
    if (!this.supports(capability)) throw new ClientError("CAPABILITY_UNSUPPORTED", "Host has not negotiated this capability");
  }
  private async typedRequest<T>(method: string, payload: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    const response = await this.request<unknown>(method, payload);
    try { return schema.parse(response); }
    catch { throw new ClientError("INVALID_RPC_RESPONSE", "Host returned an invalid domain response", { method }); }
  }
  openView(request: OpenViewRequest): Promise<OpenViewResponse> {
    this.requireCapability(TIMELINE_PROJECTION_CAPABILITY);
    return this.typedRequest("session.openView", OpenViewRequestSchema.parse(request), OpenViewResponseSchema);
  }
  getTimelinePage(request: TimelinePageRequest): Promise<TimelinePage> {
    this.requireCapability(TIMELINE_PROJECTION_CAPABILITY);
    return this.typedRequest("timeline.getPage", TimelinePageRequestSchema.parse(request), TimelinePageSchema);
  }
  subscribeTimeline(request: { sessionId: string; epoch: string }): Promise<TimelineSubscribeResponse> {
    this.requireCapability(TIMELINE_PROJECTION_CAPABILITY);
    return this.typedRequest("timeline.subscribe", TimelineSubscribeRequestSchema.parse(request), TimelineSubscribeResponseSchema);
  }
  unsubscribeTimeline(request: { subscriptionId: string }): Promise<TimelineUnsubscribeResponse> {
    this.requireCapability(TIMELINE_PROJECTION_CAPABILITY);
    return this.typedRequest("timeline.unsubscribe", TimelineUnsubscribeRequestSchema.parse(request), TimelineUnsubscribeResponseSchema);
  }
  getContentChunk(request: ContentChunkRequest): Promise<ContentChunk> {
    this.requireCapability(BOUNDED_CONTENT_CAPABILITY);
    return this.typedRequest("content.getChunk", ContentChunkRequestSchema.parse(request), ContentChunkSchema);
  }
  getAccessReceipt(request: { commandId: string }): Promise<AccessReceipt> {
    this.requireCapability(ACCESS_RECEIPTS_CAPABILITY);
    if (!request.commandId || request.commandId.length > 128) throw new ClientError("INVALID_COMMAND_ID", "Invalid command identity");
    return this.typedRequest("access.getReceipt", { commandId: request.commandId }, { parse: (value): AccessReceipt => {
      if (!isRecord(value) || value.commandId !== request.commandId || typeof value.found !== "boolean") throw new Error("Invalid receipt identity");
      if (!value.found) return { found: false, commandId: request.commandId };
      if (typeof value.method !== "string" || !value.method.startsWith("access.") || !["accepted", "completed", "failed", "cancelled", "outcome_unknown"].includes(String(value.state)) || value.updatedAt !== undefined && typeof value.updatedAt !== "string") throw new Error("Invalid access receipt");
      return { found: true, commandId: request.commandId, method: value.method, state: value.state as Extract<AccessReceipt, { found: true }>["state"], ...(Object.hasOwn(value, "response") ? { response: value.response } : {}), ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}) };
    } });
  }
  ping(nonce: string): Promise<void> { return this.send({ type: "ping", nonce }); }
}
