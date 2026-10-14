import { z } from "zod";
import {
  ClientHelloV2Schema,
  MAX_APPLICATION_FRAME_BYTES,
  ProtocolIdentifierSchema,
  ServerHelloV2Schema,
  TransportGenerationSchema,
} from "./handshake.js";

const ApplicationRpcErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
  retryable: z.boolean().default(false),
  details: z.unknown().optional(),
  traceId: z.string().max(256).optional(),
}).strict();

const ApplicationSessionEventSchema = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.string().min(1).max(256),
  payload: z.unknown(),
  occurredAt: z.string().min(1).max(64),
}).strict();

export const RequestFrameV2Schema = z.object({
  type: z.literal("request"),
  id: ProtocolIdentifierSchema,
  method: z.string().min(1).max(256).regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/),
  commandId: ProtocolIdentifierSchema.optional(),
  payload: z.unknown().default({}),
  transportGeneration: TransportGenerationSchema,
}).strict();
export type RequestFrameV2 = z.infer<typeof RequestFrameV2Schema>;

export const ResponseFrameV2Schema = z.union([
  z.object({
    type: z.literal("response"),
    id: ProtocolIdentifierSchema,
    ok: z.literal(true),
    payload: z.unknown(),
    transportGeneration: TransportGenerationSchema,
  }).strict(),
  z.object({
    type: z.literal("response"),
    id: ProtocolIdentifierSchema,
    ok: z.literal(false),
    error: ApplicationRpcErrorSchema,
    transportGeneration: TransportGenerationSchema,
  }).strict(),
]);
export type ResponseFrameV2 = z.infer<typeof ResponseFrameV2Schema>;

export const EventFrameV2Schema = z.object({
  type: z.literal("event"),
  sessionId: z.string().min(1).max(256),
  event: ApplicationSessionEventSchema,
  transportGeneration: TransportGenerationSchema,
}).strict().refine((frame) => frame.sessionId === frame.event.sessionId, "Event belongs to a different session");
export type EventFrameV2 = z.infer<typeof EventFrameV2Schema>;

export const PingFrameV2Schema = z.object({
  type: z.literal("ping"),
  nonce: ProtocolIdentifierSchema,
  transportGeneration: TransportGenerationSchema,
}).strict();
export type PingFrameV2 = z.infer<typeof PingFrameV2Schema>;

export const PongFrameV2Schema = z.object({
  type: z.literal("pong"),
  nonce: ProtocolIdentifierSchema,
  transportGeneration: TransportGenerationSchema,
}).strict();
export type PongFrameV2 = z.infer<typeof PongFrameV2Schema>;

export const ProtocolErrorFrameV2Schema = z.object({
  type: z.literal("protocol.error"),
  error: ApplicationRpcErrorSchema,
  transportGeneration: TransportGenerationSchema.optional(),
}).strict();
export type ProtocolErrorFrameV2 = z.infer<typeof ProtocolErrorFrameV2Schema>;

export const ApplicationFrameSchema = z.union([
  ClientHelloV2Schema,
  ServerHelloV2Schema,
  RequestFrameV2Schema,
  ResponseFrameV2Schema,
  EventFrameV2Schema,
  PingFrameV2Schema,
  PongFrameV2Schema,
  ProtocolErrorFrameV2Schema,
]);
export type ApplicationFrame = z.infer<typeof ApplicationFrameSchema>;

export class ProtocolFrameError extends Error {
  constructor(readonly code: "FRAME_TOO_LARGE" | "INVALID_FRAME", message: string) {
    super(message);
    this.name = "ProtocolFrameError";
  }
}

/** Reject oversized/invalid UTF-8 before JSON parsing. Error messages never include frame contents. */
export function decodeProtocolJson(frame: string | Uint8Array, maximumBytes: number): unknown {
  const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  if (bytes.byteLength > maximumBytes) {
    throw new ProtocolFrameError("FRAME_TOO_LARGE", "Protocol frame exceeds the byte limit");
  }
  try {
    return JSON.parse(typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
  } catch {
    throw new ProtocolFrameError("INVALID_FRAME", "Protocol frame is not valid JSON UTF-8");
  }
}

export function parseApplicationFrame(frame: string | Uint8Array): ApplicationFrame {
  const parsed = ApplicationFrameSchema.safeParse(decodeProtocolJson(frame, MAX_APPLICATION_FRAME_BYTES));
  if (!parsed.success) throw new ProtocolFrameError("INVALID_FRAME", "Application frame has an invalid shape");
  return parsed.data;
}

export function encodeApplicationFrame(frame: ApplicationFrame): string {
  const parsed = ApplicationFrameSchema.safeParse(frame);
  if (!parsed.success) throw new ProtocolFrameError("INVALID_FRAME", "Application frame has an invalid shape");
  let result: string;
  try {
    result = JSON.stringify(parsed.data);
  } catch {
    throw new ProtocolFrameError("INVALID_FRAME", "Application frame cannot be encoded as JSON");
  }
  if (new TextEncoder().encode(result).byteLength > MAX_APPLICATION_FRAME_BYTES) {
    throw new ProtocolFrameError("FRAME_TOO_LARGE", "Application frame exceeds the byte limit");
  }
  return result;
}
