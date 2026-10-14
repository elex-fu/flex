import { z } from "zod";
import { decodeProtocolJson, ProtocolFrameError } from "./application-frames.js";
import { ProtocolIdentifierSchema } from "./handshake.js";
import { base64UrlBytesSchema, RelayRouteIdSchema, validateConnectionUrl } from "./host-descriptor.js";

export const RELAY_PROTOCOL_VERSION = 1;
export const MAX_RELAY_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_RELAY_CIPHERTEXT_FRAME_BYTES = 256 * 1024 + 1024;
export const RELAY_SEND_HIGH_WATER_BYTES = 1024 * 1024;

export const RelayConnectionIdSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const RelayGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Relay credentials are exactly 256 random bits in canonical, unpadded base64url. */
export const RelayCredentialSchema = base64UrlBytesSchema(32);
export const RouteRegistrationSchema = z.object({
  v: z.literal(1),
  routeId: RelayRouteIdSchema,
  relayCredential: RelayCredentialSchema,
}).strict();
export type RouteRegistration = z.infer<typeof RouteRegistrationSchema>;

export const RelayErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1).max(128),
  message: z.string().max(512).optional(),
  retryable: z.boolean().optional(),
}).strict();

export const RelayControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("registered"),
    connectionIds: z.array(RelayConnectionIdSchema).max(1024)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate connection ID"),
    generation: RelayGenerationSchema.optional(),
  }).strict(),
  z.object({ type: z.literal("connected"), connectionId: RelayConnectionIdSchema }).strict(),
  z.object({ type: z.literal("disconnected"), connectionId: RelayConnectionIdSchema }).strict(),
  z.object({ type: z.literal("ping"), nonce: ProtocolIdentifierSchema }).strict(),
  z.object({ type: z.literal("pong"), nonce: ProtocolIdentifierSchema }).strict(),
  RelayErrorMessageSchema,
]);
export type RelayControlMessage = z.infer<typeof RelayControlMessageSchema>;

export const RelayDataAckMessageSchema = z.object({
  type: z.literal("ack"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type RelayDataAckMessage = z.infer<typeof RelayDataAckMessageSchema>;

export const RelayDataMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("client.connected"), connectionId: RelayConnectionIdSchema }).strict(),
  z.object({
    type: z.literal("data.paired"),
    connectionId: RelayConnectionIdSchema,
    generation: RelayGenerationSchema.optional(),
  }).strict(),
  RelayDataAckMessageSchema,
  RelayErrorMessageSchema,
]);
export type RelayDataMessage = z.infer<typeof RelayDataMessageSchema>;

function parseMessage<T>(schema: z.ZodType<T>, frame: string): T {
  // WebSocket framing is part of the protocol: control and ACK envelopes are
  // text, while every binary frame is opaque Noise/application ciphertext.
  if (typeof frame !== "string") throw new ProtocolFrameError("INVALID_FRAME", "Relay control envelope must be a text frame");
  const parsed = schema.safeParse(decodeProtocolJson(frame, MAX_RELAY_CONTROL_FRAME_BYTES));
  if (!parsed.success) throw new ProtocolFrameError("INVALID_FRAME", "Relay control envelope has an invalid shape");
  return parsed.data;
}

function encodeMessage<T>(schema: z.ZodType<T>, message: T): string {
  const parsed = schema.safeParse(message);
  if (!parsed.success) throw new ProtocolFrameError("INVALID_FRAME", "Relay control envelope has an invalid shape");
  const json = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(json).byteLength > MAX_RELAY_CONTROL_FRAME_BYTES) {
    throw new ProtocolFrameError("FRAME_TOO_LARGE", "Relay control envelope exceeds the byte limit");
  }
  return json;
}

export const parseRelayControlMessage = (frame: string): RelayControlMessage => parseMessage(RelayControlMessageSchema, frame);
export const parseRelayDataMessage = (frame: string): RelayDataMessage => parseMessage(RelayDataMessageSchema, frame);
export const encodeRelayControlMessage = (message: RelayControlMessage): string => encodeMessage(RelayControlMessageSchema, message);
export const encodeRelayDataMessage = (message: RelayDataMessage): string => encodeMessage(RelayDataMessageSchema, message);

export type RelaySocketTarget =
  | { role: "client"; routeId: string }
  | { role: "control"; routeId: string; generation: number }
  | { role: "data"; routeId: string; connectionId: string; generation: number };

export function buildRelaySocketUrl(baseWssUrl: string, target: RelaySocketTarget): string {
  const base = validateConnectionUrl(baseWssUrl, "relay");
  const routeId = RelayRouteIdSchema.parse(target.routeId);
  const path = `/v1/routes/${routeId}/${target.role}`;
  if (target.role === "client") return `${base}${path}`;
  const generation = RelayGenerationSchema.parse(target.generation);
  return target.role === "control"
    ? `${base}${path}?generation=${generation}`
    : `${base}${path}/${RelayConnectionIdSchema.parse(target.connectionId)}?generation=${generation}`;
}

/** Parses only canonical public Relay paths. Callers still authenticate control/data before upgrading. */
export function parseRelaySocketUrl(value: string | URL): RelaySocketTarget {
  const url = value instanceof URL ? value : new URL(value);
  if (!["wss:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid Relay URL");
  const match = /^\/v1\/routes\/([A-Za-z0-9_-]+)\/(client|control|data)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
  if (!match) throw new Error("Invalid Relay socket path");
  const routeId = RelayRouteIdSchema.parse(match[1]);
  const role = match[2];
  if (role === "client") {
    if (match[3] || url.search) throw new Error("Invalid Relay client path");
    return { role, routeId };
  }
  if (!/^\?generation=[1-9][0-9]*$/.test(url.search)) throw new Error("Relay generation is required");
  const generation = RelayGenerationSchema.parse(Number(url.searchParams.get("generation")));
  if (role === "control") {
    if (match[3]) throw new Error("Invalid Relay control path");
    return { role, routeId, generation };
  }
  return { role: "data", routeId, generation, connectionId: RelayConnectionIdSchema.parse(match[3]) };
}

export function buildRelayRegistrationUrl(baseWssUrl: string): string {
  return `${validateConnectionUrl(baseWssUrl, "relay").replace(/^wss:/, "https:")}/v1/routes`;
}
