import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  HostDescriptorV1Schema,
  UnsignedHostDescriptorV1Schema,
  canonicalJson,
  hostDescriptorSigningBytes,
  type HostDescriptorV1,
  type UnsignedHostDescriptorV1,
} from "@flyx/mvp-protocol";
import { z } from "zod";

export const HOST_IDENTITY_FILENAME = "host-identity.json";
const MAX_IDENTITY_FILE_BYTES = 16 * 1024;
const RawKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().refine((value) => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
});

const HostIdentityFileV1Schema = z.strictObject({
  v: z.literal(1),
  hostId: z.string().uuid(),
  x25519PublicKey: RawKeySchema,
  x25519SecretKey: RawKeySchema,
  ed25519PublicKey: RawKeySchema,
  ed25519SecretKey: RawKeySchema,
  fingerprint: FingerprintSchema,
  createdAt: IsoTimestampSchema,
});

/** The canonical private record. Only publicHostIdentity() may enter a response or QR. */
export type HostIdentityFileV1 = Readonly<z.infer<typeof HostIdentityFileV1Schema>>;

export interface HostIdentityMirror {
  hostId: string;
  fingerprint: string;
}

export interface LoadHostIdentityOptions {
  directory: string;
  /** Supply the SQLite mirror on every persistent startup. A missing file then fails closed. */
  expectedMirror?: HostIdentityMirror | null;
}

export type HostIdentityErrorCode =
  | "IDENTITY_MISSING"
  | "IDENTITY_MISMATCH"
  | "IDENTITY_INVALID"
  | "IDENTITY_PERMISSIONS"
  | "IDENTITY_UNSAFE_PATH"
  | "IDENTITY_BUSY"
  | "IDENTITY_ROTATION_UNAUTHORIZED"
  | "IDENTITY_IO_ERROR";

const ERROR_MESSAGES: Record<HostIdentityErrorCode, string> = {
  IDENTITY_MISSING: "Host identity is missing; restore the original identity or explicitly establish a new Host and pair again.",
  IDENTITY_MISMATCH: "Host identity does not match its persisted mirror; remote access must remain disabled.",
  IDENTITY_INVALID: "Host identity is invalid; remote access must remain disabled.",
  IDENTITY_PERMISSIONS: "Host identity must be owned by the current user with directory mode 0700 and file mode 0600.",
  IDENTITY_UNSAFE_PATH: "Host identity must use a regular private file and directory, without symbolic links.",
  IDENTITY_BUSY: "Host identity rotation is already in progress; an interrupted rotation requires local recovery.",
  IDENTITY_ROTATION_UNAUTHORIZED: "Host identity rotation requires explicit local or authorized-device confirmation and revocation.",
  IDENTITY_IO_ERROR: "Host identity could not be safely read or persisted.",
};

/** Error messages deliberately never include file contents, keys, or parser exceptions. */
export class HostIdentityError extends Error {
  constructor(readonly code: HostIdentityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HostIdentityError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function safeError(error: unknown): HostIdentityError {
  if (error instanceof HostIdentityError) return error;
  const code = errorCode(error);
  if (code === "ELOOP" || code === "ENOTDIR") return new HostIdentityError("IDENTITY_UNSAFE_PATH");
  if (code === "EACCES" || code === "EPERM") return new HostIdentityError("IDENTITY_PERMISSIONS");
  if (code === "ENOENT") return new HostIdentityError("IDENTITY_MISSING");
  return new HostIdentityError("IDENTITY_IO_ERROR");
}

function identityFingerprint(hostPublicKey: string, signingPublicKey: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ v: 1, hostPublicKey, signingPublicKey })).digest("hex")}`;
}

function privateKey(publicKey: string, secretKey: string, curve: "X25519" | "Ed25519") {
  return createPrivateKey({ key: { kty: "OKP", crv: curve, x: publicKey, d: secretKey }, format: "jwk" });
}

function isCanonicalRawKey(key: string): boolean {
  const decoded = Buffer.from(key, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === key;
}

function validateIdentity(value: unknown): HostIdentityFileV1 {
  const result = HostIdentityFileV1Schema.safeParse(value);
  if (!result.success) throw new HostIdentityError("IDENTITY_INVALID");
  const identity = result.data;
  try {
    for (const key of [identity.x25519PublicKey, identity.x25519SecretKey, identity.ed25519PublicKey, identity.ed25519SecretKey]) {
      if (!isCanonicalRawKey(key)) throw new Error("INVALID_KEY");
    }
    // Derive each public key from its private scalar/seed. Merely importing a JWK
    // containing both fields does not establish that they belong to one pair.
    const xPublic = createPublicKey(privateKey(identity.x25519PublicKey, identity.x25519SecretKey, "X25519")).export({ format: "jwk" });
    const signingPublic = createPublicKey(privateKey(identity.ed25519PublicKey, identity.ed25519SecretKey, "Ed25519")).export({ format: "jwk" });
    if (xPublic.x !== identity.x25519PublicKey || signingPublic.x !== identity.ed25519PublicKey) throw new Error("KEY_MISMATCH");
    if (identity.fingerprint !== identityFingerprint(identity.x25519PublicKey, identity.ed25519PublicKey)) throw new Error("FINGERPRINT_MISMATCH");
  } catch {
    throw new HostIdentityError("IDENTITY_INVALID");
  }
  return Object.freeze(identity);
}

/** For explicit ephemeral/in-memory hosts only; persistent hosts must use the loader. */
export function generateHostIdentity(options: { hostId?: string; createdAt?: string } = {}): HostIdentityFileV1 {
  const encryption = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  const signing = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return validateIdentity({
    v: 1,
    hostId: options.hostId ?? randomUUID(),
    x25519PublicKey: encryption.x,
    x25519SecretKey: encryption.d,
    ed25519PublicKey: signing.x,
    ed25519SecretKey: signing.d,
    fingerprint: identityFingerprint(encryption.x!, signing.x!),
    createdAt: options.createdAt ?? new Date().toISOString(),
  });
}

export function getHostIdentityMirror(identity: HostIdentityFileV1): HostIdentityMirror {
  return { hostId: identity.hostId, fingerprint: identity.fingerprint };
}

export function publicHostIdentity(identity: HostIdentityFileV1) {
  return {
    hostId: identity.hostId,
    hostPublicKey: identity.x25519PublicKey,
    signingPublicKey: identity.ed25519PublicKey,
    fingerprint: identity.fingerprint,
  };
}

function assertMirror(identity: HostIdentityFileV1, mirror: HostIdentityMirror | null | undefined): void {
  if (mirror && (identity.hostId !== mirror.hostId || identity.fingerprint !== mirror.fingerprint)) {
    throw new HostIdentityError("IDENTITY_MISMATCH");
  }
}

function assertPrivateMode(stat: Stats, directory: boolean): void {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new HostIdentityError("IDENTITY_UNSAFE_PATH");
  if ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw new HostIdentityError("IDENTITY_PERMISSIONS");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new HostIdentityError("IDENTITY_PERMISSIONS");
}

async function privateDirectory(directory: string, create: boolean): Promise<string> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink()) throw new HostIdentityError("IDENTITY_UNSAFE_PATH");
  assertPrivateMode(stat, true);
  return realpath(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertPrivateMode(await handle.stat(), true);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readIdentityFile(path: string): Promise<HostIdentityFileV1 | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    assertPrivateMode(stat, false);
    if (stat.size > MAX_IDENTITY_FILE_BYTES) throw new HostIdentityError("IDENTITY_INVALID");
    // Keep malformed or concurrently enlarged files bounded before JSON parsing.
    const bytes = Buffer.alloc(MAX_IDENTITY_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_IDENTITY_FILE_BYTES) throw new HostIdentityError("IDENTITY_INVALID");
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new HostIdentityError("IDENTITY_INVALID");
    }
    return validateIdentity(value);
  } finally {
    await handle.close();
  }
}

async function stageIdentity(directory: string, identity: HostIdentityFileV1): Promise<string> {
  const path = join(directory, `.${HOST_IDENTITY_FILENAME}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${canonicalJson(identity)}\n`, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return path;
}

/**
 * The initial publication is an atomic, no-clobber hard link to the fsynced temp
 * file. POSIX rename would overwrite a concurrent winner. Rotation uses rename
 * only under an exclusive lock and after matching the persisted identity.
 */
export async function loadOrCreateHostIdentity(options: LoadHostIdentityOptions): Promise<HostIdentityFileV1> {
  try {
    const directory = await privateDirectory(options.directory, !options.expectedMirror);
    const target = join(directory, HOST_IDENTITY_FILENAME);
    let identity = await readIdentityFile(target);
    if (!identity) {
      if (options.expectedMirror) throw new HostIdentityError("IDENTITY_MISSING");
      const candidate = generateHostIdentity();
      const temporary = await stageIdentity(directory, candidate);
      try {
        try {
          await link(temporary, target);
          await syncDirectory(directory);
          identity = candidate;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          identity = await readIdentityFile(target);
          if (!identity) throw new HostIdentityError("IDENTITY_MISSING");
        }
      } finally {
        await unlink(temporary);
        await syncDirectory(directory);
      }
    }
    assertMirror(identity, options.expectedMirror);
    return identity;
  } catch (error) {
    throw safeError(error);
  }
}

export interface RotateHostIdentityOptions {
  directory: string;
  expectedMirror: HostIdentityMirror;
  /** The caller must authenticate/authorize the device before constructing this value. */
  authorization: { kind: "local" } | { kind: "authorized-device"; deviceId: string };
  /**
   * Atomically revoke prior devices/leases and CAS the SQLite mirror here. This
   * runs before publishing the key; a crash or failure leaves access fail closed.
   * Only public mirrors are passed to prevent private keys entering the DB.
   */
  beforeCommit: (next: HostIdentityMirror, previous: HostIdentityMirror) => void | Promise<void>;
}

export async function rotateHostIdentity(options: RotateHostIdentityOptions): Promise<HostIdentityFileV1> {
  const authorization = options.authorization;
  if (!authorization || (authorization.kind !== "local" && (authorization.kind !== "authorized-device" || !authorization.deviceId)) || typeof options.beforeCommit !== "function") {
    throw new HostIdentityError("IDENTITY_ROTATION_UNAUTHORIZED");
  }
  if (!options.expectedMirror || !z.string().uuid().safeParse(options.expectedMirror.hostId).success || !FingerprintSchema.safeParse(options.expectedMirror.fingerprint).success) {
    throw new HostIdentityError("IDENTITY_MISMATCH");
  }
  try {
    const directory = await privateDirectory(options.directory, false);
    const target = join(directory, HOST_IDENTITY_FILENAME);
    const lockPath = join(directory, `.${HOST_IDENTITY_FILENAME}.rotate.lock`);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new HostIdentityError("IDENTITY_BUSY");
      throw error;
    }
    try {
      const previous = await readIdentityFile(target);
      if (!previous) throw new HostIdentityError("IDENTITY_MISSING");
      assertMirror(previous, options.expectedMirror);
      const next = generateHostIdentity({ hostId: previous.hostId });
      const temporary = await stageIdentity(directory, next);
      try {
        await options.beforeCommit(getHostIdentityMirror(next), getHostIdentityMirror(previous));
        // The hook may await I/O. Do not overwrite a file that was removed or
        // replaced by an operator/non-cooperating process while the mirror was
        // being committed; that state must remain visibly fail closed.
        const stillCurrent = await readIdentityFile(target);
        if (!stillCurrent || canonicalJson(stillCurrent) !== canonicalJson(previous)) {
          throw new HostIdentityError("IDENTITY_MISMATCH");
        }
        await rename(temporary, target);
        await syncDirectory(directory);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      await syncDirectory(directory);
    }
  } catch (error) {
    throw safeError(error);
  }
}

export type CreateHostDescriptorOptions = Pick<UnsignedHostDescriptorV1, "protocol" | "endpoints"> & {
  issuedAt?: string;
  expiresAt?: string;
  nonce?: string;
};

export function createHostDescriptor(identity: HostIdentityFileV1, options: CreateHostDescriptorOptions): HostDescriptorV1 {
  const validIdentity = validateIdentity(identity);
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error("INVALID_DESCRIPTOR_TIME");
  const unsigned = UnsignedHostDescriptorV1Schema.parse({
    v: 1,
    ...publicHostIdentity(validIdentity),
    protocol: options.protocol,
    endpoints: options.endpoints,
    issuedAt,
    expiresAt: options.expiresAt ?? new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
    nonce: options.nonce ?? randomBytes(24).toString("base64url"),
  });
  const signature = sign(null, hostDescriptorSigningBytes(unsigned), privateKey(validIdentity.ed25519PublicKey, validIdentity.ed25519SecretKey, "Ed25519"));
  return HostDescriptorV1Schema.parse({ ...unsigned, signature: signature.toString("base64url") });
}
