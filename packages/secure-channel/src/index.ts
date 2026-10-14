export { SecureChannelError, type SecureChannelErrorCode } from "./errors.js";
export {
  NOISE_SUITES,
  NoiseHandshake,
  createNoiseInitiator,
  createNoiseResponder,
  inspectNoiseHandshakePattern,
  type NoiseBinding,
  type NoiseInitiatorOptions,
  type NoiseResponderOptions,
} from "./handshake.js";
export {
  DEFAULT_SECURE_CHANNEL_LIMITS,
  MAX_SECURE_FRAME_BYTES,
  MAX_SECURE_PLAINTEXT_BYTES,
  NOISE_RECORD_PLAINTEXT_BYTES,
  SECURE_FRAME_HEADER_BYTES,
  SecureSession,
  type NoisePattern,
  type SecureChannelLimits,
  type SecureSessionOptions,
} from "./session.js";
export {
  MemoryNoiseKeyStore,
  NOISE_DEVICE_KEY_CAPABILITIES,
  generateNoiseKeyPair,
  noiseKeyPairFromSecretKey,
  type NoiseKeyPair,
  type NoiseStaticKeyStore,
} from "./key-store.js";
