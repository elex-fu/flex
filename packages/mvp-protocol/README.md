# Flyx MVP protocol

`@flyx/mvp-protocol` contains the schemas shared by the Direct, Relay, Host,
and client transports. Protocol v2 application frames are strict and carry a
transport generation. The legacy v1 Direct frame and bootstrap decoders remain
available only for the authenticated Direct compatibility path; a v2-shaped
frame is not accepted as v1 merely by omitting `client.hello`.

Pairing offers are unpadded base64url of canonical JSON. Their schemas reject
unknown properties, non-canonical encodings, unsafe transport URLs, identity
fingerprint mismatches, expired grants, and grants outside the bounded pairing
window. Host descriptor signatures cover canonical JSON for every unsigned
field. Descriptor verification separately pins both the Noise and Ed25519
public keys and revalidates endpoint transport policy after signature parsing.

New Relay route IDs are exactly 24 random bytes encoded as 32 base64url
characters. Pairing grants and Relay credentials are exactly 32 random bytes
in canonical base64url. Randomness is supplied and tested by the Relay/Host
component that creates each value; schemas can enforce encoding and entropy
length, but cannot prove that a caller used a secure random generator.

Relay control and data-control envelopes are strict JSON text messages.
Application and Noise traffic is binary. A Relay ACK is the fixed text shape
`{"type":"ack","sequence":n}` where `n` is a positive safe integer and is a
cumulative count of physical binary deliveries, including handshake flights.
ACKs are Relay backpressure metadata, contain no application payload, and are
not part of the end-to-end encrypted application stream.

The Noise prologue accepts the prior v1 variable-length route locator during
migration, but authenticates its exact value in the transcript. All newly
minted offers and Relay registrations use the fixed 192-bit route-ID schema.
