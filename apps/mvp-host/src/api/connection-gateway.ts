import { randomUUID } from "node:crypto";
import { FrameSchema, ClientHelloV2Schema, ApplicationFrameSchema, BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, RecoveryCapability, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, AttentionCapability, AttentionMethodScopes, type SessionEvent } from "@flyx/mvp-protocol";
import { z } from "zod";
import { OrchestratorError } from "../session/orchestrator.js";
import { DeviceRegistry } from "../auth/device-registry.js";
import { AccessError, assertMethodScope, requiredScopeForMethod } from "../auth/connection-authorizer.js";
import { publicEvent, publicValue, toRpcError } from "./public-projection.js";
import { RpcDispatcher, assertSynchronousAuthorization, type RpcDispatcherOptions } from "./rpc-dispatcher.js";
import { ACCESS_RECEIPTS_CAPABILITY, type AccessCommandReceipts, type AccessReceiptContext } from "./access-command-receipts.js";
import type { ContentStore } from "../content/content-store.js";
import { FrameBudget } from "../content/frame-budget.js";
import { BoundedRpcProjection } from "../content/bounded-rpc.js";
import type { HostViewConnection } from "../timeline/host-views.js";
import type { OpenedTimelineView } from "../timeline/timeline-subscriptions.js";
import { PublicTextStream } from "../content/public-text.js";

export interface DuplexTransport {
  readonly id: string;
  readonly kind: "direct" | "relay";
  readonly generation: number;
  send(frame: string | Uint8Array): Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: string | Uint8Array) => void): () => void;
  onClose(handler: (info: { code?: number; reason?: string }) => void): () => void;
}

export interface GatewayCredential { deviceId?: string; authSessionId?: string; remotePublicKey?: string; assertCurrent?(): void }
export interface AttentionGatewayPort {
  capabilities(): readonly string[];
  rpc(): { handle(context: { leaseId: string; generation: number }, method: string, payload: unknown): Promise<unknown>; disconnect(context: { leaseId: string; generation: number }): void } | undefined;
}
export interface ConnectionGatewayOptions extends RpcDispatcherOptions {
  hostId: string;
  fingerprint: string;
  devices: DeviceRegistry;
  assertIdentity?(): void;
  confirmPairing(): boolean | Promise<boolean>;
  heartbeatIntervalMs?: number;
  interactionCapabilities?(): readonly string[];
  recoveryCapabilities?(): readonly string[];
  assertSessionScope?(subjectId: string, sessionId: string, scope: "session:read" | "session:write" | "approval:write"): void;
  accessReceipts?: AccessCommandReceipts;
  attention?: AttentionGatewayPort;
  maxFrameBytes?: number;
  responseBudgetBytes?: number;
}

const MAX_FRAME_BYTES = 256 * 1024;
const HIGH_WATER = 1024 * 1024;
const CAPABILITIES = ["transport-neutral-rpc", "device-auth", "heartbeat", "command-receipts", "timeline-resume", "e2ee-relay"];
const Pair = z.object({ grant: z.string().min(1).max(256), proposedDevicePublicKey: z.string().min(1).max(128), deviceInfo: z.object({ displayName: z.string().max(128).optional(), platform: z.string().max(64).optional() }).optional() });
const Refresh = z.object({ proposedDevicePublicKey: z.string().min(1).max(128), refreshCredential: z.string().min(1).max(256).optional() });

/** All application frames enter here only after TLS/ticket or Noise authentication. */
export class ConnectionGateway {
  private readonly connections = new Set<(code?: number, reason?: string) => void>();
  private readonly dispatcher: RpcDispatcher;
  private readonly contentStore: ContentStore | undefined;
  constructor(private readonly options: ConnectionGatewayOptions) {
    this.contentStore = options.contentStore ?? options.views?.content ?? options.orchestrator.views?.content;
    if (this.contentStore && this.contentStore.db !== options.orchestrator.store.db || options.views && options.views.store !== options.orchestrator.store || options.accessReceipts && options.accessReceipts.devices !== options.devices || options.devices.store !== options.orchestrator.store || options.devices.hostId !== options.hostId) throw new OrchestratorError("HOST_SERVICE_BINDING_MISMATCH", "Transport services must share the authenticated Host Store");
    this.dispatcher = new RpcDispatcher({ ...options, ...(options.recovery ?? options.orchestrator.recovery ? { recovery: options.recovery ?? options.orchestrator.recovery } : {}), ...(this.contentStore ? { contentStore: this.contentStore } : {}) });
  }

  /** Recomputed for each hello; cached factory presence never promotes Native capability. */
  capabilities(): readonly string[] {
    const caps = new Set(CAPABILITIES);
    const offer = (read: (() => readonly string[]) | undefined) => { try { for (const cap of read?.() ?? []) if (typeof cap === "string" && cap.length > 0 && cap.length <= 128) caps.add(cap); } catch { /* An unavailable service offers nothing. */ } };
    const views = this.options.views ?? this.options.orchestrator.views;
    if (this.contentStore && this.contentStore.db.open) caps.add(BOUNDED_CONTENT_CAPABILITY);
    if (views) {
      try {
        for (const row of views.store.db.prepare("SELECT id FROM sessions").iterate() as Iterable<{ id: string }>) {
          try { if (views.ready(row.id)) { caps.add(TIMELINE_PROJECTION_CAPABILITY); break; } } catch { /* Only resolved ready resources advertise views. */ }
        }
      } catch { /* A sealed Store has no live view capability. */ }
    }
    if (this.options.catalogPort?.ready !== false) offer(this.options.catalogPort?.capabilities?.bind(this.options.catalogPort));
    if (this.options.interactions || this.options.catalogPort?.interactionsForSession || this.options.orchestrator.interactionRpcPort) offer(this.options.interactionCapabilities);
    if (!caps.has(INTERACTION_CAPABILITY)) caps.delete(STRUCTURED_QUESTION_CAPABILITY);
    if (this.options.recoveryForSession) offer(this.options.recoveryCapabilities);
    else if (this.options.recovery ?? this.options.orchestrator.recovery) caps.add(RecoveryCapability);
    if (this.options.accessReceipts?.ready()) caps.add(ACCESS_RECEIPTS_CAPABILITY);
    for (const port of this.options.domainPorts ?? []) { try { if (port.ready() === true) offer(port.capabilities.bind(port)); } catch { /* Closed services are not advertised. */ } }
    try { if (this.options.attention?.rpc()) offer(this.options.attention.capabilities.bind(this.options.attention)); } catch { /* A sealed Attention port offers nothing. */ }
    return [...caps];
  }

  close(code = 1001, reason = "HOST_SHUTDOWN"): void { for (const stop of this.connections) stop(code, reason); }

  attach(transport: DuplexTransport, credential: GatewayCredential = {}): () => void {
    const { devices, orchestrator } = this.options;
    const frameBudget = new FrameBudget({ ...(this.options.maxFrameBytes ? { maxFrameBytes: this.options.maxFrameBytes } : {}), ...(this.options.responseBudgetBytes ? { responseBytes: this.options.responseBudgetBytes } : {}) });
    const boundFor = (sessionId = orchestrator.sessionId) => new BoundedRpcProjection(sessionId, orchestrator.store.getSession(sessionId)?.workspacePath ?? orchestrator.workspace, this.contentStore);
    const bounded = boundFor();
    const hostViews = this.options.views ?? orchestrator.views;
    let clientCapabilities = new Set<string>();
    const textStreams = new Map<string, PublicTextStream>();
    let deviceId = credential.deviceId;
    if (credential.remotePublicKey) {
      try { deviceId = devices.authenticatePublicKey(credential.remotePublicKey).id; }
      catch (error) { transport.close(1008, authenticationCloseReason(error)); return () => {}; }
    }
    let generation = transport.generation;
    let version: 1 | 2 | undefined;
    let leaseId: string | undefined;
    let views: HostViewConnection | undefined;
    let attentionPort: ReturnType<AttentionGatewayPort["rpc"]>;
    let viewRequestId = "\u0000".repeat(128);
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    let removeMessage: (() => void) | undefined;
    let removeClose: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let helloTimeout: ReturnType<typeof setTimeout> | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let deferOwnClose = false;
    let pendingClose: { code: number; reason: string } | undefined;
    let outboundBytes = 0;
    let outbound = Promise.resolve();
    let inbound = Promise.resolve();
    let inboundCount = 0;
    let inboundBytes = 0;
    let pendingPing: { nonce: string; at: number } | undefined;
    let catchingUp = false;
    let eventBuffer: SessionEvent[] = [];
    let bufferBytes = 0;

    const cleanup = (closeReason = "TRANSPORT_CLOSED") => {
      if (stopped) return;
      stopped = true;
      unsubscribe?.(); views?.close(); removeMessage?.(); removeClose?.();
      clearInterval(heartbeat); clearTimeout(helloTimeout); clearTimeout(closeDeadline);
      if (leaseId) { attentionPort?.disconnect({ leaseId, generation }); devices.closeLease(leaseId, closeReason); }
      eventBuffer = []; bufferBytes = 0; textStreams.clear();
      this.connections.delete(stop);
    };
    const stop = (code = 1001, reason = "HOST_SHUTDOWN") => { cleanup(reason); transport.close(code, reason); };
    const requestClose = (code = 1008, reason = "DEVICE_REVOKED") => {
      // cleanup() marks the connection stopped before closing its persisted
      // lease. Ignore the registry callback in that direction so it cannot
      // mask the gateway's more precise close reason.
      if (stopped) return;
      if (deferOwnClose) {
        pendingClose = { code, reason };
        closeDeadline ??= setTimeout(() => stop(code, reason), 100);
        closeDeadline.unref?.();
      }
      else stop(code, reason);
    };
    const withGeneration = (frame: Record<string, unknown>) => version === 2 ? { ...frame, transportGeneration: generation } : frame;
    const publicError = (error: unknown, envelope: (error: unknown) => unknown) => {
      const rpc = error instanceof z.ZodError ? { code: "INVALID_REQUEST", message: "Invalid RPC payload", retryable: false } : toRpcError(error);
      let value = publicValue(rpc, orchestrator.workspace) as typeof rpc & { details?: unknown };
      if (!frameBudget.fits(envelope(value))) value = { code: rpc.code.length <= 128 ? rpc.code : "INTERNAL_ERROR", message: "Host request failed; error details truncated", retryable: rpc.retryable, details: { truncated: true } };
      frameBudget.assert(envelope(value));
      return value;
    };
    const send = (frame: Record<string, unknown>, assertCurrent?: () => void): Promise<void> => {
      if (stopped) return Promise.resolve();
      // Business overflow is returned as an RPC error; it must not tear down a healthy lease.
      const payload = frameBudget.encode(withGeneration(frame));
      const size = Buffer.byteLength(payload);
      if (outboundBytes + size > HIGH_WATER) { stop(1013, "RESYNC_REQUIRED"); return Promise.reject(new Error("Backpressure")); }
      outboundBytes += size;
      const sent = outbound.then(async () => { if (!stopped) { assertCurrent?.(); await transport.send(payload); } });
      outbound = sent.catch(() => { stop(1013, "RESYNC_REQUIRED"); }).finally(() => { outboundBytes -= size; });
      return sent;
    };
    const ensureLease = () => {
      this.options.assertIdentity?.();
      credential.assertCurrent?.();
      if (!deviceId) throw new OrchestratorError("UNAUTHENTICATED", "Pair this device first");
      if (!leaseId) {
        const lease = devices.openLease(deviceId, {
          kind: transport.kind, generation, protocolVersion: version ?? 1,
          ...(credential.authSessionId ? { authSessionId: credential.authSessionId } : {}),
          capabilities: [...clientCapabilities], close: (code, reason) => requestClose(code, reason),
        });
        leaseId = lease.leaseId;
      }
      return devices.assertLease(leaseId, generation);
    };
    const assertTarget = (sessionId: string, scope: "session:read" | "session:write" | "approval:write") => {
      const principal = ensureLease();
      if (!principal.scopes.has(scope)) throw new AccessError("FORBIDDEN", "Device permission denied");
      const guard = this.options.assertSessionScope ?? this.options.catalogPort?.assertActorSession?.bind(this.options.catalogPort);
      if (guard) assertSynchronousAuthorization(guard(principal.deviceId, sessionId, scope) as unknown);
      else if (this.options.catalogPort) throw new OrchestratorError("SESSION_SCOPE_REQUIRED", "Session authorization is unavailable");
      else if (sessionId !== orchestrator.sessionId) throw new OrchestratorError("SESSION_NOT_FOUND", "Session does not exist");
    };
    const accessContext = (): AccessReceiptContext => { const principal = ensureLease(); return { subjectId: principal.deviceId, leaseId: principal.leaseId, transportGeneration: generation, protocolVersion: version ?? 1, capabilities: clientCapabilities }; };
    const viewOwner = () => { const principal = ensureLease(); return { subjectId: principal.deviceId, leaseId: principal.leaseId, generation }; };
    const canonicalViews = (sessionId?: string) => {
      if (stopped || version !== 2 || !clientCapabilities.has(TIMELINE_PROJECTION_CAPABILITY) || !clientCapabilities.has(BOUNDED_CONTENT_CAPABILITY) || !hostViews) throw new OrchestratorError("CAPABILITY_REQUIRED", "Canonical Timeline capability is required");
      if (sessionId !== undefined) { assertTarget(sessionId, "session:read"); if (!hostViews.ready(sessionId)) throw new OrchestratorError("TIMELINE_UNAVAILABLE", "Session Timeline is not ready"); }
      views ??= hostViews.connect(viewOwner(), {
        fits: (payload) => frameBudget.fits(withGeneration({ type: "response", id: viewRequestId, ok: true, payload }))
          && frameBudget.fits(withGeneration({ type: "event", sessionId: "\u0000".repeat(256), event: { id: "\u0000".repeat(128), sessionId: "\u0000".repeat(256), sequence: Number.MAX_SAFE_INTEGER, type: "timeline.updated", payload, occurredAt: "2026-10-14T00:00:00.000Z" } })),
      }, () => {
        if (stopped) throw new OrchestratorError("LEASE_EXPIRED", "Connection has closed");
        assertMethodScope(ensureLease().scopes, "timeline.subscribe");
      });
      return views;
    };
    const deliverCanonical = async (event: SessionEvent) => {
      const current = () => assertTarget(event.sessionId, "session:read"); current();
      await send({ type: "event", sessionId: event.sessionId, event }, current);
    };
    const eventFrame = (event: SessionEvent, streamText = true) => {
      let projected = publicEvent(event, orchestrator.workspace);
      const payload = event.payload;
      if (event.type === "assistant.message.delta" && payload && typeof payload === "object" && "itemId" in payload && typeof payload.itemId === "string" && "text" in payload && typeof payload.text === "string") {
        const stored = this.contentStore?.publicDelta(event.sessionId, payload.itemId, event.sequence);
        if (stored !== undefined) projected = publicEvent({ ...event, payload: { ...payload, text: stored } }, orchestrator.workspace);
        else if (streamText) {
          const stream = textStreams.get(payload.itemId) ?? new PublicTextStream([orchestrator.workspace]);
          textStreams.set(payload.itemId, stream);
          projected = publicEvent({ ...event, payload: { ...payload, text: stream.append(payload.text) } }, orchestrator.workspace);
        }
      }
      if (event.type === "assistant.message.completed" && payload && typeof payload === "object" && "itemId" in payload && typeof payload.itemId === "string") textStreams.delete(payload.itemId);
      const wrap = (body: unknown) => withGeneration({ type: "event", sessionId: projected.sessionId, event: { ...projected, payload: body } });
      return { type: "event", sessionId: projected.sessionId, event: { ...projected, payload: bounded.bound(projected.payload, frameBudget, wrap, { allowRefs: clientCapabilities.has(BOUNDED_CONTENT_CAPABILITY), pinOwner: `event:${transport.id}:${event.sequence}` }) } };
    };
    const sendEvent = (event: SessionEvent) => {
      if (stopped) return;
      try { assertTarget(event.sessionId, "session:read"); } catch (error) { stop(1008, authenticationCloseReason(error)); return; }
      if (catchingUp) {
        // Buffer the bounded public value, not a multi-megabyte raw payload.
        const buffered = eventFrame(event, false);
        bufferBytes += frameBudget.bytes(withGeneration(buffered));
        if (bufferBytes > HIGH_WATER) { stop(1013, "RESYNC_REQUIRED"); return; }
        eventBuffer.push(buffered.event);
      } else {
        try { void send(eventFrame(event), () => assertTarget(event.sessionId, "session:read")).catch(() => {}); }
        catch (error) { void send({ type: "event", sessionId: event.sessionId, event: { ...event, payload: { boundedContent: { truncated: true, requiresUpgrade: true, originalBytes: Buffer.byteLength(JSON.stringify(event.payload)) }, error: toRpcError(error) } } }).catch(() => {}); }
      }
    };
    const subscribe = async (afterSequence: number) => {
      assertTarget(orchestrator.sessionId, "session:read");
      unsubscribe?.();
      catchingUp = true; eventBuffer = []; bufferBytes = 0; textStreams.clear();
      unsubscribe = orchestrator.subscribe(sendEvent);
      const head = orchestrator.snapshot().session.headSequence;
      if (afterSequence > head) {
        unsubscribe(); unsubscribe = undefined;
        catchingUp = false; eventBuffer = []; bufferBytes = 0;
        throw new OrchestratorError("SEQUENCE_AHEAD", "Timeline cursor is ahead of this Host");
      }
      let cursor = afterSequence;
      try {
        for (;;) {
          const page = orchestrator.timeline(cursor, 200, head);
          for (const event of page.events) {
            if (stopped) throw new Error("Connection closed");
            await send(eventFrame(event), () => assertTarget(event.sessionId, "session:read"));
            cursor = event.sequence;
          }
          if (!page.hasMore || page.events.length === 0) break;
        }
        while (eventBuffer.length) {
          const batch = eventBuffer; eventBuffer = []; bufferBytes = 0;
          batch.sort((a, b) => a.sequence - b.sequence);
          for (const event of batch) if (event.sequence > cursor) {
            await send(eventFrame(event), () => assertTarget(event.sessionId, "session:read"));
            cursor = event.sequence;
          }
        }
        return { sessionId: orchestrator.sessionId, afterSequence: cursor, headSequence: orchestrator.snapshot().session.headSequence };
      } catch (error) {
        unsubscribe?.(); unsubscribe = undefined;
        eventBuffer = []; bufferBytes = 0;
        throw error;
      } finally { catchingUp = false; }
    };
    const access = async (method: string, raw: unknown) => {
      if (method === "access.pair") {
        if (transport.kind !== "relay" || deviceId) throw new OrchestratorError("PAIRING_INVALID", "Pairing requires a new secure channel");
        const payload = Pair.parse(raw);
        const device = await devices.pair(payload, this.options.confirmPairing);
        return devices.issueRefreshCredential(device.id, payload.proposedDevicePublicKey);
      }
      if (method === "access.refresh") {
        const payload = Refresh.parse(raw);
        if (payload.refreshCredential) return devices.refreshDeviceCredential({ refreshCredential: payload.refreshCredential, proposedDevicePublicKey: payload.proposedDevicePublicKey });
        return devices.issueRefreshCredential(ensureLease().deviceId, payload.proposedDevicePublicKey);
      }
      const principal = ensureLease();
      switch (method) {
        case "access.listDevices": return {
          devices: devices.listDevices().map(({ id, hostId, displayName, platform, credentialKind, scopes, createdAt, lastSeenAt, revokedAt }) => ({ id, hostId, displayName, platform, credentialKind, scopes, createdAt, lastSeenAt, revokedAt })),
          currentDeviceId: principal.deviceId,
        };
        case "access.revokeSelf": devices.revokeSelf(principal.deviceId); return { ok: true };
        case "access.revokeDevice": {
          const payload = z.object({ deviceId: z.string().min(1).max(128) }).parse(raw);
          devices.revokeDevice(principal.deviceId, payload.deviceId); return { ok: true };
        }
        case "access.revokeAllDevices":
        case "access.revokeAll": {
          const count = devices.listDevices().filter((device) => !device.revokedAt).length;
          devices.revokeAll(principal.deviceId); return { revoked: count };
        }
        default: throw new OrchestratorError("METHOD_NOT_FOUND", "Unknown access method");
      }
    };
    const handle = async (raw: string | Uint8Array) => {
      if (stopped) return;
      try { this.options.assertIdentity?.(); } catch { stop(1008, "IDENTITY_MISMATCH"); return; }
      const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
      if (Buffer.byteLength(text) > MAX_FRAME_BYTES) { stop(1009, "FRAME_TOO_LARGE"); return; }
      let json: unknown;
      try { json = JSON.parse(text); } catch { stop(1003, "INVALID_JSON"); return; }
      const rejectProtocol = async (code: string, message: string, closeCode = 1002) => {
        try { await send({ type: "protocol.error", error: { code, message, retryable: false } }); }
        finally { stop(closeCode, code); }
      };
      if (json && typeof json === "object" && "type" in json && json.type === "client.hello") {
        if (version !== undefined) { await rejectProtocol("HELLO_ALREADY_RECEIVED", "Protocol hello was already received"); return; }
        const parsed = ClientHelloV2Schema.safeParse(json);
        if (!parsed.success) { await rejectProtocol("INVALID_HELLO", "Protocol hello has an invalid shape"); return; }
        const hello = parsed.data;
        if (hello.hostId !== this.options.hostId || (hello.deviceId !== undefined && hello.deviceId !== deviceId)) {
          await rejectProtocol("HOST_IDENTITY_MISMATCH", "Protocol hello does not match this Host or device", 1008); return;
        }
        if (hello.protocol.min > 2 || hello.protocol.max < 2) {
          await rejectProtocol("PROTOCOL_INCOMPATIBLE", "No mutually supported protocol version"); return;
        }
        const available = this.capabilities();
        if (hello.requiredCapabilities?.some((capability) => !available.includes(capability))) {
          await rejectProtocol("CAPABILITY_UNSUPPORTED", "A required protocol capability is unavailable"); return;
        }
        if (hello.requiredCapabilities?.includes(TIMELINE_PROJECTION_CAPABILITY) && !hello.capabilities.includes(BOUNDED_CONTENT_CAPABILITY)) { await rejectProtocol("CAPABILITY_UNSUPPORTED", "Canonical Timeline requires bounded content"); return; }
        clientCapabilities = new Set(hello.capabilities.filter((capability) => available.includes(capability)));
        if (!clientCapabilities.has(BOUNDED_CONTENT_CAPABILITY)) clientCapabilities.delete(TIMELINE_PROJECTION_CAPABILITY);
        generation = hello.transportGeneration; version = 2; clearTimeout(helloTimeout);
        let lease;
        try { lease = deviceId ? ensureLease() : undefined; }
        catch (error) { stop(1008, authenticationCloseReason(error)); return; }
        const interval = this.options.heartbeatIntervalMs ?? 15_000;
        await send({ type: "server.hello", hostId: this.options.hostId, hostFingerprint: this.options.fingerprint, protocolVersion: 2, capabilities: available, leaseId: lease?.leaseId ?? `pairing-${transport.id}`, heartbeatIntervalMs: interval, maxFrameBytes: frameBudget.maxFrameBytes });
        heartbeat = setInterval(() => {
          if (pendingPing && Date.now() - pendingPing.at >= interval * 2) { stop(1001, "HEARTBEAT_TIMEOUT"); return; }
          if (!pendingPing) { pendingPing = { nonce: randomUUID(), at: Date.now() }; void send({ type: "ping", nonce: pendingPing.nonce }).catch(() => {}); }
        }, interval);
        heartbeat.unref?.();
        return;
      }
      if (version === undefined) {
        if (transport.kind !== "direct" || !deviceId) { stop(1002, "HELLO_REQUIRED"); return; }
        version = 1; clearTimeout(helloTimeout);
        try { ensureLease(); } catch (error) { stop(1008, authenticationCloseReason(error)); return; }
      }
      const parsed = (version === 2 ? ApplicationFrameSchema : FrameSchema).safeParse(json);
      if (!parsed.success) { stop(1003, "INVALID_FRAME"); return; }
      const frame = parsed.data;
      if (version === 2 && (!('transportGeneration' in frame) || frame.transportGeneration !== generation)) { stop(1008, "STALE_GENERATION"); return; }
      if (frame.type === "ping") { await send({ type: "pong", nonce: frame.nonce }); return; }
      if (frame.type === "pong") { if (pendingPing?.nonce === frame.nonce) pendingPing = undefined; return; }
      if (frame.type !== "request") { stop(1003, "INVALID_REQUEST"); return; }
      if (frame.id.length > 128 || frame.method.length > 128 || (frame.commandId?.length ?? 0) > 128) { stop(1009, "IDENTIFIER_TOO_LARGE"); return; }
      deferOwnClose = frame.method.startsWith("access.");
      viewRequestId = frame.id;
      const gates: OpenedTimelineView[] = [];
      const admittedTargets = new Map<string, Set<"session:read" | "session:write" | "approval:write">>();
      let replied = false;
      try {
        const context: Parameters<RpcDispatcher["dispatch"]>[1] = {
          subjectId: deviceId ?? "unpaired",
          protocolVersion: version,
          ...(leaseId ? { leaseId } : {}),
          transportGeneration: generation,
          capabilities: clientCapabilities,
          frameBudget,
          responseEnvelope: (payload) => withGeneration({ type: "response", id: frame.id, ok: true, payload }),
          assertSessionScope: (id, scope) => { assertTarget(id, scope); const scopes = admittedTargets.get(id) ?? new Set(); scopes.add(scope); admittedTargets.set(id, scopes); },
          assertContentScope: (scope) => { const principal = ensureLease(); if (!principal.scopes.has(scope)) throw new AccessError("FORBIDDEN", "Content requires additional permission"); },
          assertAuthorized: (method) => {
            if (!deviceId && transport.kind === "relay" && (method === "access.pair" || method === "access.refresh" || method === "host.getDescriptor")) return;
            const principal = ensureLease();
            try {
              const domain = (this.options.domainPorts ?? []).find((port) => Object.hasOwn(port.methodScopes, method));
              const scope = requiredScopeForMethod(method) ?? (Object.hasOwn(AttentionMethodScopes, method) && this.options.attention ? AttentionMethodScopes[method as keyof typeof AttentionMethodScopes] : domain?.methodScopes[method]);
              if (!scope) throw new AccessError("METHOD_NOT_FOUND", "RPC method is not supported");
              if (!principal.scopes.has(scope)) throw new AccessError("FORBIDDEN", "Device permission denied");
            }
            catch (error) {
              if (error instanceof AccessError && error.code === "FORBIDDEN") devices.auditScopeDenied(principal.deviceId, method);
              throw error;
            }
          },
          viewOwner,
          openView: (request) => { const opened = canonicalViews(request.sessionId).openView(request, deliverCanonical); gates.push(opened); return opened.response; },
          timelinePage: (request) => canonicalViews(request.sessionId).getPage(request),
          timelineSubscribe: (request) => { const opened = canonicalViews(request.sessionId).subscribe(request, deliverCanonical); gates.push(opened); return opened.response; },
          timelineUnsubscribe: (id) => canonicalViews().unsubscribe(id),
          subscribe, access,
          ...(this.options.accessReceipts ? {
            accessCommand: (method, payload, commandId) => this.options.accessReceipts!.command({ method, payload, commandId }, accessContext()),
            accessReceipt: (payload) => this.options.accessReceipts!.getReceipt(payload, accessContext()),
          } : {}),
        };
        let result: unknown;
        if (Object.hasOwn(AttentionMethodScopes, frame.method)) {
          context.assertAuthorized(frame.method);
          const port = this.options.attention?.rpc();
          if (version !== 2 || !clientCapabilities.has(AttentionCapability) || !this.options.attention?.capabilities().includes(AttentionCapability) || !port) throw new OrchestratorError("CAPABILITY_REQUIRED", "Attention capability is required");
          attentionPort = port;
          const principal = ensureLease();
          try { result = await port.handle({ leaseId: principal.leaseId, generation }, frame.method, frame.payload); }
          catch (error) { const code = error && typeof error === "object" && "code" in error ? error.code : undefined; if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) throw new OrchestratorError(code, "Attention request rejected"); throw error; }
        } else result = await this.dispatcher.dispatch(frame, context);
        // Revocation intentionally delivers its committed response before its own deferred closure.
        const responseCurrent = frame.method.startsWith("access.") ? undefined : () => {
          context.assertAuthorized(frame.method);
          for (const [id, scopes] of admittedTargets) for (const scope of scopes) assertTarget(id, scope);
        };
        responseCurrent?.();
        const targetId = frame.payload && typeof frame.payload === "object" && "sessionId" in frame.payload && typeof frame.payload.sessionId === "string" ? frame.payload.sessionId : admittedTargets.size === 1 ? admittedTargets.keys().next().value! : orchestrator.sessionId;
        const envelope = (payload: unknown) => withGeneration({ type: "response", id: frame.id, ok: true, payload });
        const canonical = frame.method === "session.openView" || frame.method.startsWith("timeline.");
        const payload = frame.method === "content.getChunk" || canonical ? result : boundFor(targetId).bound(result, frameBudget, envelope, { allowRefs: clientCapabilities.has(BOUNDED_CONTENT_CAPABILITY) && admittedTargets.size <= 1 && !frame.method.startsWith("attention."), method: frame.method, subjectId: deviceId ?? "unpaired", pinOwner: `request:${transport.id}:${frame.id}` });
        await send({ type: "response", id: frame.id, ok: true, payload }, responseCurrent);
        replied = true;
        for (const opened of gates) await opened.activate();
      } catch (error) {
        if (process.env.FLYX_DEBUG_DISPATCH) console.error("[dispatch]", frame.method, error);
        if (replied) for (const opened of gates) opened.cancel();
        else await send({ type: "response", id: frame.id, ok: false, error: publicError(error, (error) => withGeneration({ type: "response", id: frame.id, ok: false, error })) });
      } finally {
        if (!replied) for (const opened of gates) opened.cancel();
        deferOwnClose = false;
        if (pendingClose) stop(pendingClose.code, pendingClose.reason);
      }
    };
    removeMessage = transport.onMessage((raw) => {
      if (stopped) return;
      const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
      if (size > MAX_FRAME_BYTES) { stop(1009, "FRAME_TOO_LARGE"); return; }
      inboundBytes += size;
      if (++inboundCount > 32 || inboundBytes > HIGH_WATER) { stop(1013, "RATE_LIMITED"); return; }
      inbound = inbound.then(() => handle(raw)).catch(() => stop(1003, "INVALID_FRAME")).finally(() => { inboundCount -= 1; inboundBytes -= size; });
    });
    removeClose = transport.onClose((info) => cleanup(info.reason ?? (info.code === undefined ? "TRANSPORT_CLOSED" : String(info.code))));
    helloTimeout = setTimeout(() => stop(1002, "HELLO_TIMEOUT"), 10_000);
    helloTimeout.unref?.();
    this.connections.add(stop);
    return stop;
  }
}

function authenticationCloseReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "DEVICE_REVOKED") return "DEVICE_REVOKED";
  if (code.includes("CREDENTIAL")) return "CREDENTIAL_EXPIRED";
  if (code === "DEVICE_EXPIRED" || code === "LEASE_EXPIRED" || code === "AUTH_EXPIRED") return "CREDENTIAL_EXPIRED";
  return "AUTHENTICATION_REQUIRED";
}
