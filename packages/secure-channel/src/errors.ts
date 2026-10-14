export type SecureChannelErrorCode =
  | "INVALID_ARGUMENT"
  | "HANDSHAKE_FAILED"
  | "HANDSHAKE_STATE"
  | "AUTHENTICATION_FAILED"
  | "INVALID_FRAME"
  | "FRAME_TOO_LARGE"
  | "REPLAY_OR_OUT_OF_ORDER"
  | "NONCE_EXHAUSTED"
  | "CLOSED";

/** Messages are intentionally fixed codes: never forward crypto inputs into logs. */
export class SecureChannelError extends Error {
  constructor(readonly code: SecureChannelErrorCode) {
    super(code);
    this.name = "SecureChannelError";
  }
}
