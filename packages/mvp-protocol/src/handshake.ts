import { z } from "zod";

export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const MAX_SUPPORTED_PROTOCOL_VERSION = 2;
export const MAX_APPLICATION_FRAME_BYTES = 256 * 1024;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export const ProtocolRangeSchema = z.object({
  min: z.number().int().min(1).max(65_535),
  max: z.number().int().min(1).max(65_535),
}).strict().refine((range) => range.min <= range.max, "Protocol range is reversed");
export type ProtocolRange = z.infer<typeof ProtocolRangeSchema>;

export const ProtocolIdentifierSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** Relay routes are 192-bit random values encoded as unpadded base64url. */
export const RelayRouteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const TransportGenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CapabilitySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const CapabilitiesSchema = z.array(CapabilitySchema).max(64)
  .refine((values) => new Set(values).size === values.length, "Duplicate capability");

export const ClientHelloV2Schema = z.object({
  type: z.literal("client.hello"),
  clientId: ProtocolIdentifierSchema,
  deviceId: ProtocolIdentifierSchema.optional(),
  hostId: ProtocolIdentifierSchema,
  protocol: ProtocolRangeSchema,
  capabilities: CapabilitiesSchema,
  requiredCapabilities: CapabilitiesSchema.optional(),
  transportGeneration: TransportGenerationSchema,
}).strict().refine(
  (hello) => hello.requiredCapabilities?.every((capability) => hello.capabilities.includes(capability)) ?? true,
  "Required capabilities must also be advertised",
);
export type ClientHelloV2 = z.infer<typeof ClientHelloV2Schema>;

export const ServerHelloV2Schema = z.object({
  type: z.literal("server.hello"),
  hostId: ProtocolIdentifierSchema,
  hostFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  protocolVersion: z.literal(2),
  capabilities: CapabilitiesSchema,
  leaseId: ProtocolIdentifierSchema,
  heartbeatIntervalMs: z.number().int().min(1_000).max(120_000),
  maxFrameBytes: z.number().int().positive().max(MAX_APPLICATION_FRAME_BYTES),
  transportGeneration: TransportGenerationSchema,
}).strict();
export type ServerHelloV2 = z.infer<typeof ServerHelloV2Schema>;

export class ProtocolNegotiationError extends Error {
  constructor(readonly code: "PROTOCOL_VERSION_UNSUPPORTED" | "CAPABILITY_UNSUPPORTED", message: string) {
    super(message);
    this.name = "ProtocolNegotiationError";
  }
}

/** Select the highest mutually supported version, never a silent downgrade outside the advertised range. */
export function negotiateProtocolVersion(
  requested: ProtocolRange,
  supported: ProtocolRange = { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: MAX_SUPPORTED_PROTOCOL_VERSION },
): number {
  const client = ProtocolRangeSchema.parse(requested);
  const host = ProtocolRangeSchema.parse(supported);
  const selected = Math.min(client.max, host.max);
  if (selected < Math.max(client.min, host.min)) {
    throw new ProtocolNegotiationError("PROTOCOL_VERSION_UNSUPPORTED", "No mutually supported protocol version");
  }
  return selected;
}

export function negotiateCapabilities(
  requested: readonly string[],
  supported: readonly string[],
  required: readonly string[] = [],
): string[] {
  const advertised = CapabilitiesSchema.parse(requested);
  const available = new Set(CapabilitiesSchema.parse(supported));
  const mandatory = CapabilitiesSchema.parse(required);
  if (mandatory.some((value) => !advertised.includes(value) || !available.has(value))) {
    throw new ProtocolNegotiationError("CAPABILITY_UNSUPPORTED", "A required capability is unavailable");
  }
  return advertised.filter((capability) => available.has(capability));
}

/** The prologue is unambiguous JSON, bound to the route, connection, Host, and protocol range. */
export function buildNoisePrologue(binding: {
  hostId: string;
  routeId: string;
  connectionId: string;
  protocol: ProtocolRange;
}): Uint8Array {
  const hostId = ProtocolIdentifierSchema.parse(binding.hostId);
  // Random base64url identifiers may begin with '-' or '_'; unlike human-facing IDs they have no leading-alphanumeric rule.
  // The authenticated prologue also accepts legacy v1 route locators during
  // migration. New offers and Relay registrations use RelayRouteIdSchema's
  // exact 192-bit encoding, so no new variable-length IDs are minted.
  const routeId = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(binding.routeId);
  const connectionId = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(binding.connectionId);
  const protocol = ProtocolRangeSchema.parse(binding.protocol);
  // Array encoding fixes order and avoids delimiter ambiguity without depending on a JSON serializer package.
  return new TextEncoder().encode(JSON.stringify(["flyx-relay-v1", hostId, routeId, connectionId, protocol.min, protocol.max]));
}
