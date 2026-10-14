import { describe, expect, it } from "vitest";
import { Handshake, type TransportState } from "salty-crypto";
import { keyPairFromSecret, nobleNoiseAlgorithms } from "./noble-provider.js";

// Cacophony interoperability vectors, preserved by snow (MIT/Apache-2.0).
// https://github.com/mcginty/snow/blob/main/tests/vectors/cacophony.txt
// Git blob b8a271ed1aba8b4a56bf429e559d7947827123b4. Fixed expected bytes
// originate independently of Flyx, not from this package's implementation.
const initEphemeral = "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a";
const respEphemeral = "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b";
const respStatic = "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893";
const respPublic = "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62";
const initStatic = "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1";
const prologue = "4a6f686e2047616c74";
const payloads = [
  "4c756477696720766f6e204d69736573",
  "4d757272617920526f746862617264",
  "462e20412e20486179656b",
  "4361726c204d656e676572",
  "4a65616e2d426170746973746520536179",
  "457567656e2042f6686d20766f6e2042617765726b",
];
const vectors = [
  {
    pattern: "NK",
    handshakeHash: "d7244d974066aae2376f7ba5534f60a6e4e82cd7c9751e226cae3928e6b49f14",
    ciphertexts: [
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794454ae7612d1724af42adb130160a9a94e67b5b169b4e00c189f6467cd17eb7cad",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843986a5c929337e337ac8b4a074af12ab9f76318a5f18c8b599a443af07383ce",
      "550027c7a5d450017bcb5e12b8253b1c53fd2213aeda84891d5f95",
      "dfbce0c38210ccee35e830aca9dd8b8b3997b933e75bfc8864b759",
      "4c487a88330c7c65e44d430addf3d92d2a15b081a2892b96693e00b68aec0adac2",
      "471cb9f8252d8ae7b25c93f4b4aebdbf25e5baa23f14bc743559e3ef7fd065e69cfaef55ee",
    ],
  },
  {
    pattern: "IK",
    handshakeHash: "48f3cb8bc9319da4ba1e9933991b1c4ed4034f1f126a76d3a1fbcfd7f94248d4",
    ciphertexts: [
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79440b03ddc7aac5123d06a1b23b71670e32e76c28239a7ca4ac8f784de7e44c1adbfc6e83fef7352a58d9d56157400c0a737b1d171ce368229c7b752ac25b8faf4eca690f6d896f543be02c996ab2b86b76",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d9b5a8927f0ac9655ef76833bc7e5561f42e691ac8404efd6fbd6308b6a27c",
      "2c256ed08fcd08c2980f954ee4beaccb61c9581340f5dd2fd1cf3b",
      "d6033f70eee20945c7c9dba304e397ee3b284ff5e00fd9efb095d3",
      "a9c068ca5d8babf72560652d8e851adbfac35c8a66e810d560863173e96adf4cfe",
      "2a09d8f459e5927e40fdd2eddc99bdafb04e13a26f145cb5cfe9e6ba34c94331ebc17d5156",
    ],
  },
];

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("fixed Noise interoperability vectors", () => {
  it.each(vectors)("matches all handshake/transport bytes for $pattern", (vector) => {
    const init = new Handshake(nobleNoiseAlgorithms, vector.pattern, "initiator", {
      prologue: bytes(prologue),
      pregeneratedEphemeralKeypair: keyPairFromSecret(bytes(initEphemeral)),
      remoteStaticPublicKey: bytes(respPublic),
      ...(vector.pattern === "IK" ? { staticKeypair: keyPairFromSecret(bytes(initStatic)) } : {}),
    });
    const resp = new Handshake(nobleNoiseAlgorithms, vector.pattern, "responder", {
      prologue: bytes(prologue),
      pregeneratedEphemeralKeypair: keyPairFromSecret(bytes(respEphemeral)),
      staticKeypair: keyPairFromSecret(bytes(respStatic)),
    });
    const engines = [init, resp];
    const states: (TransportState | null)[] = [null, null];
    for (let index = 0; index < payloads.length; index += 1) {
      const sender = index % 2;
      const receiver = 1 - sender;
      const payload = bytes(payloads[index]!);
      let packet: Uint8Array;
      if (index < 2) {
        const sent = engines[sender]!.writeMessage(payload);
        packet = sent.packet;
        states[sender] = sent.finished;
        const received = engines[receiver]!.readMessage(packet);
        states[receiver] = received.finished;
        expect(received.message).toEqual(payload);
      } else {
        packet = states[sender]!.send.encrypt(payload);
        expect(states[receiver]!.recv.decrypt(packet)).toEqual(payload);
      }
      expect(hex(packet)).toBe(vector.ciphertexts[index]);
    }
    expect(hex(init.handshakeHash)).toBe(vector.handshakeHash);
    expect(hex(resp.handshakeHash)).toBe(vector.handshakeHash);
  });
});
