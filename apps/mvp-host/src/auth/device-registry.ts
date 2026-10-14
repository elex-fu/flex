import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SqliteStore, type DeviceRecord, type PairingGrantRecord, type ProtocolSessionRecord } from "../storage/db.js";
import { AccessError, DEFAULT_DEVICE_SCOPES, validateScopes } from "./connection-authorizer.js";

export type { DeviceRecord } from "../storage/db.js";

const PAIRING_TTL_MS = 5 * 60_000;
const LEASE_TTL_MS = 60 * 60_000;
export const REFRESH_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;

export type ConnectionPrincipal = {
  hostId: string;
  deviceId: string;
  sessionId: string;
  scopes: Set<string>;
  leaseId: string;
  expiresAt: string;
  transportKind: string;
  transportGeneration: number;
  protocolVersion: number;
};

export type ConnectionLease = ConnectionPrincipal;

export type PairingProposal = {
  grantId: string;
  hostId: string;
  proposedDevicePublicKey: string;
  displayName?: string;
  platform: string;
  scopes: string[];
};

export type PairingConfirmation = (proposal: PairingProposal) => boolean | Promise<boolean>;

export type RefreshCredential = {
  deviceId: string;
  refreshCredential: string;
  credentialRevision: number;
  expiresAt: string;
  scopes: string[];
};

export type OpenLeaseOptions = {
  kind: string;
  generation: number;
  protocolVersion: number;
  capabilities?: string[];
  authSessionId?: string;
  expiresAt?: string;
  close: (code: number, reason: string) => void;
};

export type CredentialAfterCommit = (effect: () => unknown) => void;

export type DeviceRegistryOptions = {
  now?: () => number;
  leaseTtlMs?: number;
  /** CLI inspection must not claim ownership of another running host's leases. */
  recoverLeases?: boolean;
  /** Poll external SQLite revocations (for the local device-management CLI). */
  revocationPollMs?: number;
  /** Local diagnostics only; a post-commit effect failure cannot undo committed credentials. */
  onCredentialEffectError?: (error: unknown) => void;
};

type ActiveSocket = { close: OpenLeaseOptions["close"]; timer: ReturnType<typeof setTimeout> };

export class DeviceRegistry {
  private readonly now: () => number;
  private readonly leaseTtlMs: number;
  private readonly pollMs: number;
  private readonly sockets = new Map<string, ActiveSocket>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private readonly credentialEffects: Array<Array<() => unknown>> = [];
  private readonly credentialEffectError: ((error: unknown) => void) | undefined;

  constructor(readonly store: SqliteStore, readonly hostId: string, options: DeviceRegistryOptions = {}) {
    if (!hostId) throw new AccessError("HOST_IDENTITY_INVALID", "Host identity is required");
    this.now = options.now ?? Date.now;
    this.leaseTtlMs = positiveDuration(options.leaseTtlMs ?? LEASE_TTL_MS);
    this.pollMs = positiveDuration(options.revocationPollMs ?? 1_000);
    this.credentialEffectError = options.onCredentialEffectError;
    if (options.recoverLeases !== false) {
      this.store.db.transaction(() => {
        for (const lease of this.store.listActiveProtocolSessions(hostId)) {
          this.store.disconnectProtocolSession(lease.id, "HOST_RESTART", this.timestamp());
        }
      })();
    }
  }

  createPairingGrant(options: { scopes?: string[]; ttlMs?: number } = {}): { id: string; grant: string; expiresAt: string } {
    const grant = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expiresAt = new Date(this.now() + Math.min(PAIRING_TTL_MS, positiveDuration(options.ttlMs ?? PAIRING_TTL_MS))).toISOString();
    const scopes = validateScopes(options.scopes ?? DEFAULT_DEVICE_SCOPES);
    this.store.createPairingGrant(hashSecret(grant), expiresAt, id, { hostId: this.hostId, scopes });
    return { id, grant, expiresAt };
  }

  async pair(input: {
    grant: string;
    proposedDevicePublicKey: string;
    deviceInfo?: { displayName?: string | undefined; platform?: string | undefined } | undefined;
    scopes?: string[] | undefined;
  }, confirm: PairingConfirmation): Promise<DeviceRecord> {
    const publicKey = canonicalPublicKey(input.proposedDevicePublicKey);
    const tokenHash = hashSecret(input.grant);
    const grant = this.assertPairingGrant(tokenHash);
    const permitted = validateScopes(grant.requestedScopes ?? DEFAULT_DEVICE_SCOPES);
    const scopes = validateScopes(input.scopes ?? permitted);
    if (scopes.some((scope) => !permitted.includes(scope))) throw new AccessError("FORBIDDEN", "Pairing cannot increase the grant's permissions");
    const info = deviceInfo(input.deviceInfo);
    const proposal: PairingProposal = { grantId: grant.id, hostId: this.hostId, proposedDevicePublicKey: publicKey, ...info, scopes };
    if (!(await confirm(proposal))) {
      this.audit("pair", "PAIRING_DENIED", { targetType: "pairing_grant", targetId: grant.id });
      throw new AccessError("PAIRING_DENIED", "Pairing was denied on the Host");
    }
    const device: DeviceRecord = {
      id: randomUUID(), hostId: this.hostId, ...info, credentialKind: "noise-static-key", publicKey, scopes, createdAt: this.timestamp(),
      credentialRevision: 0,
    };
    // Recheck after asynchronous local confirmation; the grant may have expired
    // or been consumed while the user considered another request.
    this.store.db.transaction(() => {
      this.assertPairingGrant(tokenHash);
      const existing = this.store.findDeviceByPublicKey(this.hostId, publicKey);
      if (existing) throw new AccessError("DEVICE_ALREADY_PAIRED", "This device key has already been registered; create a new key to pair again");
      if (!this.store.createDeviceFromPairingGrant(tokenHash, device)) throw new AccessError("PAIRING_INVALID", "Pairing grant is invalid or expired");
      this.audit("pair", "OK", { deviceId: device.id, targetType: "device", targetId: device.id });
    })();
    return device;
  }

  /** Used only after the direct browser pairing flow has obtained local
   * confirmation and consumed its one-use grant. It must not consume twice. */
  createBrowserDevice(input: { displayName?: string; platform?: string; scopes?: string[]; pairingGrant?: string } = {}): DeviceRecord {
    const device: DeviceRecord = {
      id: randomUUID(), hostId: this.hostId, ...deviceInfo(input), credentialKind: "browser-session",
      scopes: validateScopes(input.scopes ?? DEFAULT_DEVICE_SCOPES), credentialRevision: 0, createdAt: this.timestamp(),
    };
    this.store.db.transaction(() => {
      if (input.pairingGrant) {
        const grant = this.store.getPairingGrant(hashSecret(input.pairingGrant));
        const permitted = validateScopes(grant?.requestedScopes ?? DEFAULT_DEVICE_SCOPES);
        device.scopes = validateScopes(input.scopes ?? permitted);
        if (device.scopes.some((scope) => !permitted.some((allowed) => allowed === scope))) throw new AccessError("FORBIDDEN", "Pairing cannot increase the grant's permissions");
      }
      this.store.createDevice(device);
      if (input.pairingGrant) {
        const result = this.store.db.prepare(`
          UPDATE pairing_grants SET device_id = ?, host_id = ?
          WHERE token_hash = ? AND consumed_at IS NOT NULL AND approved_at IS NOT NULL AND device_id IS NULL
            AND (host_id IS NULL OR host_id = ?)
        `).run(device.id, this.hostId, hashSecret(input.pairingGrant), this.hostId);
        if (result.changes !== 1) throw new AccessError("PAIRING_INVALID", "Browser pairing was not approved or has already been registered");
      }
      this.audit("pair.browser", "OK", { deviceId: device.id, targetType: "device", targetId: device.id });
    })();
    return device;
  }

  getDevice(id: string): DeviceRecord | undefined {
    const device = this.store.getDevice(id);
    return device?.hostId === this.hostId ? { ...device, scopes: validateScopes(device.scopes) } : undefined;
  }

  listDevices(): DeviceRecord[] {
    return this.store.listDevices(this.hostId).map((device) => ({ ...device, scopes: validateScopes(device.scopes) }));
  }

  bindAuthSession(authSessionId: string, deviceId: string): void {
    this.assertActiveDevice(deviceId);
    if (!this.store.bindAuthSession(authSessionId, deviceId, this.timestamp())) throw new AccessError("AUTH_EXPIRED", "Browser session is unavailable or belongs to another device");
  }

  getDeviceForAuthSession(authSessionId: string): DeviceRecord | undefined {
    const auth = this.store.getAuthSession(authSessionId);
    if (!auth || auth.revokedAt || !isFuture(auth.expiresAt, this.now()) || !auth.deviceId) return undefined;
    const device = this.getDevice(auth.deviceId);
    if (!device || device.revokedAt || (device.expiresAt && !isFuture(device.expiresAt, this.now()))) return undefined;
    return device;
  }

  /** Upgrades an existing, locally approved v1 cookie exactly once. A mapping
   * is immutable, so revoking its device can never mint a replacement device. */
  ensureBrowserSessionDevice(authSessionId: string): DeviceRecord {
    return this.store.db.transaction(() => {
      const auth = this.store.getAuthSession(authSessionId);
      if (!auth || auth.revokedAt || !isFuture(auth.expiresAt, this.now())) throw new AccessError("AUTH_EXPIRED", "Browser session is no longer active");
      if (auth.deviceId) {
        const device = this.assertActiveDevice(auth.deviceId);
        this.bindAuthSession(authSessionId, device.id);
        return device;
      }
      const device = this.createBrowserDevice({ displayName: "Previously paired browser" });
      this.bindAuthSession(authSessionId, device.id);
      return device;
    })();
  }

  /** The argument must be the remote static key authenticated by Noise IK,
   * never an unauthenticated publicKey field in an application message. */
  authenticatePublicKey(publicKey: string): DeviceRecord {
    const device = this.store.findDeviceByPublicKey(this.hostId, canonicalPublicKey(publicKey));
    if (!device) throw new AccessError("DEVICE_UNAUTHORIZED", "Device key is not registered with this Host");
    const active = this.assertActiveDevice(device.id);
    this.store.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.timestamp(), active.id);
    return active;
  }

  openLease(deviceId: string, input: OpenLeaseOptions): ConnectionLease {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !Number.isSafeInteger(input.protocolVersion) || input.protocolVersion < 1 || typeof input.kind !== "string" || !input.kind || input.kind.length > 64) {
      throw new AccessError("PROTOCOL_INVALID", "Connection version, transport or generation is invalid");
    }
    if (input.capabilities && (!Array.isArray(input.capabilities) || input.capabilities.length > 64 || input.capabilities.some((value) => typeof value !== "string" || value.length > 128))) {
      throw new AccessError("PROTOCOL_INVALID", "Connection capabilities are invalid");
    }
    const record = this.store.db.transaction(() => {
      const device = this.assertActiveDevice(deviceId);
      const expiresAt = this.leaseExpiry(device, input.authSessionId, input.expiresAt);
      const session: ProtocolSessionRecord = {
        id: randomUUID(), deviceId, protocolVersion: input.protocolVersion, transportKind: input.kind,
        transportGeneration: input.generation, capabilities: input.capabilities ?? [], connectedAt: this.timestamp(), expiresAt,
        ...(input.authSessionId ? { authSessionId: input.authSessionId } : {}),
      };
      this.store.createProtocolSession(session);
      this.store.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(session.connectedAt, deviceId);
      this.audit("lease.open", "OK", { deviceId, targetType: "lease", targetId: session.id, transportKind: input.kind });
      return session;
    })();
    this.trackSocket(record, input.close);
    return this.principal(record, this.assertActiveDevice(deviceId));
  }

  assertLease(leaseId: string, generation?: number): ConnectionPrincipal {
    const lease = this.store.getProtocolSession(leaseId);
    try {
      if (!lease || lease.disconnectedAt || !this.sockets.has(leaseId)) throw new AccessError(lease?.closeCode ?? "LEASE_CLOSED", "Connection lease is no longer active");
      const device = this.assertActiveDevice(lease.deviceId);
      if (!isFuture(lease.expiresAt, this.now())) throw new AccessError("LEASE_EXPIRED", "Connection lease has expired");
      if (lease.authSessionId && this.getDeviceForAuthSession(lease.authSessionId)?.id !== device.id) throw new AccessError("AUTH_EXPIRED", "Browser session is no longer active");
      if (generation !== undefined && generation !== lease.transportGeneration) throw new AccessError("STALE_GENERATION", "Transport generation does not match this connection");
      return this.principal(lease, device);
    } catch (error) {
      this.closeLease(leaseId, error instanceof AccessError ? error.code : "AUTH_INVALID");
      throw error;
    }
  }

  refreshLease(leaseId: string): ConnectionLease {
    this.assertLease(leaseId);
    const record = this.store.getProtocolSession(leaseId)!;
    const expiresAt = this.leaseExpiry(this.assertActiveDevice(record.deviceId), record.authSessionId);
    this.store.db.prepare("UPDATE protocol_sessions SET expires_at = ? WHERE id = ? AND disconnected_at IS NULL").run(expiresAt, leaseId);
    const socket = this.sockets.get(leaseId)!;
    this.trackSocket({ ...record, expiresAt }, socket.close);
    return this.assertLease(leaseId);
  }

  closeLease(leaseId: string, code: string | number = "CONNECTION_CLOSED"): void {
    if (this.credentialEffects.length) { this.credentialEffects.at(-1)!.push(() => this.closeLease(leaseId, code)); return; }
    if (this.store.db.inTransaction) throw new AccessError("CREDENTIAL_COMMIT_REQUIRED", "Connection closure requires the outer transaction to commit");
    const socket = this.sockets.get(leaseId);
    if (socket) {
      clearTimeout(socket.timer);
      this.sockets.delete(leaseId);
    }
    const record = this.store.getProtocolSession(leaseId);
    if (record && this.store.disconnectProtocolSession(leaseId, String(code), this.timestamp())) {
      this.audit("lease.close", String(code), { deviceId: record.deviceId, targetType: "lease", targetId: leaseId, transportKind: record.transportKind });
    }
    if (this.sockets.size === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
    if (socket) {
      try { socket.close(typeof code === "number" ? code : closeNumber(code), String(code)); } catch { /* A failed socket cannot keep its lease alive. */ }
    }
  }

  revokeAuthSession(authSessionId: string): void {
    this.store.db.transaction(() => {
      const auth = this.store.getAuthSession(authSessionId);
      if (auth?.deviceId && this.getDevice(auth.deviceId) === undefined) throw new AccessError("DEVICE_UNAUTHORIZED", "Browser session belongs to another Host");
      this.store.db.prepare("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(this.timestamp(), authSessionId);
      this.store.db.prepare(`
        UPDATE protocol_sessions SET disconnected_at = ?, close_code = 'AUTH_REVOKED'
        WHERE auth_session_id = ? AND disconnected_at IS NULL
      `).run(this.timestamp(), authSessionId);
      this.audit("session.revoke", "OK", { ...(auth?.deviceId ? { deviceId: auth.deviceId } : {}), targetType: "auth_session", targetId: authSessionId });
    })();
    this.closeDisconnectedSockets("AUTH_REVOKED");
  }

  /** Own the outer credential/receipt transaction. Nested calls join this commit boundary;
   * an unmanaged SQLite transaction is rejected before any mutation or socket publication. */
  credentialTransaction<T>(work: (afterCommit: CredentialAfterCommit) => T): T {
    const parent = this.credentialEffects.at(-1);
    if (this.store.db.inTransaction && !parent) throw new AccessError("CREDENTIAL_COMMIT_REQUIRED", "Credential mutations require an explicit outer commit boundary");
    const effects: Array<() => unknown> = [];
    let accepting = true;
    this.credentialEffects.push(effects);
    let result: T;
    try {
      result = this.store.db.transaction(() => {
        const value = work((effect) => {
          if (!accepting || typeof effect !== "function") throw new AccessError("CREDENTIAL_TRANSACTION_CLOSED", "Credential commit effects must be registered synchronously");
          effects.push(effect);
        });
        if (value && typeof value === "object" && "then" in value) throw new AccessError("CREDENTIAL_ASYNC_TRANSACTION", "Credential transactions must be synchronous");
        return value;
      })();
    } finally { accepting = false; this.credentialEffects.pop(); }
    if (parent) parent.push(...effects);
    else this.publishCredentialEffects(effects);
    return result;
  }

  revokeSelf(deviceId: string): boolean {
    return this.revoke(deviceId, deviceId, "DEVICE_REVOKED", "access:self");
  }

  revokeDevice(actorDeviceId: string, targetDeviceId: string): boolean {
    return this.revoke(targetDeviceId, actorDeviceId, "DEVICE_REVOKED", "access:admin");
  }

  revokeAll(actorDeviceId: string): number {
    return this.revokeAllInternal(actorDeviceId);
  }

  revokeFromLocal(deviceId: string): boolean {
    return this.revoke(deviceId, undefined, "DEVICE_REVOKED");
  }

  revokeAllFromLocal(): number {
    return this.revokeAllInternal();
  }

  issueRefreshCredential(deviceId: string, proposedDevicePublicKey?: string): RefreshCredential {
    const device = this.assertDeviceScope(deviceId, "access:self");
    const publicKey = canonicalPublicKey(proposedDevicePublicKey ?? device.publicKey ?? "");
    return this.rotateCredential(device, publicKey);
  }

  rotateRefreshCredential(deviceId: string, proposedDevicePublicKey?: string): RefreshCredential {
    return this.issueRefreshCredential(deviceId, proposedDevicePublicKey);
  }

  /** A pinned HTTPS endpoint may exchange this bearer for a one-use direct
   * ticket. Ticket consumption must revalidate the returned device and expiry. */
  authenticateRefreshCredential(refreshCredential: string): DeviceRecord {
    const device = this.store.findDeviceByCredentialHash(this.hostId, hashSecret(refreshCredential));
    if (!device || !device.expiresAt || !isFuture(device.expiresAt, this.now()) || device.revokedAt) throw new AccessError("REFRESH_INVALID", "Refresh credential is invalid or expired");
    const active = this.assertActiveDevice(device.id);
    // A rotation in another process between the hash lookup and the current
    // device read must not let an obsolete bearer inherit the new revision.
    if (active.credentialRevision !== device.credentialRevision) {
      throw new AccessError("REFRESH_INVALID", "Refresh credential is invalid or expired");
    }
    return active;
  }

  /** Validate a short-lived ticket against the exact refresh-credential epoch
   * from which it was minted. This is stable across processes and contains no
   * bearer hash that callers could accidentally retain or log. */
  assertCredentialRevision(deviceId: string, credentialRevision: number): DeviceRecord {
    if (!Number.isSafeInteger(credentialRevision) || credentialRevision < 0) {
      throw new AccessError("REFRESH_INVALID", "Refresh credential revision is invalid");
    }
    const device = this.assertActiveDevice(deviceId);
    if (device.credentialRevision !== credentialRevision) {
      throw new AccessError("CREDENTIAL_ROTATED", "Device credential has changed; reconnect with the current credential");
    }
    return device;
  }

  /** Only this hash-bound operation is allowed on an NK connection after
   * pairing. Rotation consumes the previous refresh credential exactly once. */
  refreshDeviceCredential(input: { refreshCredential: string; proposedDevicePublicKey: string }): RefreshCredential {
    const publicKey = canonicalPublicKey(input.proposedDevicePublicKey);
    const oldHash = hashSecret(input.refreshCredential);
    const device = this.authenticateRefreshCredential(input.refreshCredential);
    this.assertDeviceScope(device.id, "access:self");
    return this.rotateCredential(device, publicKey, oldHash);
  }

  /** Also used by deterministic expiry tests and a 1 s cross-process watcher. */
  expireLeases(): void {
    for (const id of [...this.sockets.keys()]) {
      try { this.assertLease(id); } catch { /* assertLease closes invalid sockets. */ }
    }
  }

  auditScopeDenied(deviceId: string, method: string): void {
    // Method must be a fixed dispatcher name; no arbitrary application payload
    // or client-supplied method is persisted in the audit event.
    this.audit("scope.denied", "FORBIDDEN", { deviceId, targetType: "rpc", targetId: method });
  }

  dispose(): void {
    for (const id of [...this.sockets.keys()]) this.closeLease(id, "HOST_STOPPED");
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  close(): void { this.dispose(); }

  private assertPairingGrant(tokenHash: string): PairingGrantRecord {
    const grant = this.store.getPairingGrant(tokenHash);
    if (!grant || grant.consumedAt || !isFuture(grant.expiresAt, this.now()) || (grant.hostId && grant.hostId !== this.hostId)) {
      throw new AccessError("PAIRING_INVALID", "Pairing grant is invalid or expired");
    }
    return grant;
  }

  private assertActiveDevice(id: string): DeviceRecord {
    const device = this.getDevice(id);
    if (!device) throw new AccessError("DEVICE_UNAUTHORIZED", "Device is not registered with this Host");
    if (device.revokedAt) throw new AccessError("DEVICE_REVOKED", "Device access has been revoked");
    if (device.expiresAt && !isFuture(device.expiresAt, this.now())) throw new AccessError("DEVICE_EXPIRED", "Device credential has expired");
    return { ...device, scopes: validateScopes(device.scopes) };
  }

  private assertDeviceScope(deviceId: string, scope: string): DeviceRecord {
    const device = this.assertActiveDevice(deviceId);
    if (!device.scopes.includes(scope)) throw new AccessError("FORBIDDEN", `This device does not have ${scope} permission`);
    return device;
  }

  private leaseExpiry(device: DeviceRecord, authSessionId?: string, expiresAt?: string): string {
    let expiry = this.now() + this.leaseTtlMs;
    if (expiresAt !== undefined) expiry = Math.min(expiry, Date.parse(expiresAt));
    if (device.expiresAt) expiry = Math.min(expiry, Date.parse(device.expiresAt));
    if (authSessionId) {
      if (this.getDeviceForAuthSession(authSessionId)?.id !== device.id) throw new AccessError("AUTH_EXPIRED", "Browser session is no longer active");
      expiry = Math.min(expiry, Date.parse(this.store.getAuthSession(authSessionId)!.expiresAt));
    }
    if (!Number.isFinite(expiry) || expiry <= this.now()) throw new AccessError("LEASE_EXPIRED", "Connection authorization has expired");
    return new Date(expiry).toISOString();
  }

  private principal(lease: ProtocolSessionRecord, device: DeviceRecord): ConnectionPrincipal {
    return {
      hostId: this.hostId, deviceId: device.id, sessionId: lease.id, leaseId: lease.id, scopes: new Set(device.scopes), expiresAt: lease.expiresAt,
      transportKind: lease.transportKind, transportGeneration: lease.transportGeneration, protocolVersion: lease.protocolVersion,
    };
  }

  private trackSocket(record: ProtocolSessionRecord, close: OpenLeaseOptions["close"]): void {
    const previous = this.sockets.get(record.id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.expireLeases(), Math.max(1, Math.min(2_147_483_647, Date.parse(record.expiresAt) - this.now())));
    timer.unref();
    this.sockets.set(record.id, { close, timer });
    if (!this.poller) {
      this.poller = setInterval(() => this.expireLeases(), this.pollMs);
      this.poller.unref();
    }
  }

  private revoke(deviceId: string, actorDeviceId: string | undefined, code: string, requiredScope?: string): boolean {
    this.assertCredentialBoundary();
    const changed = this.store.db.transaction(() => {
      if (actorDeviceId && requiredScope) this.assertDeviceScope(actorDeviceId, requiredScope);
      const target = this.getDevice(deviceId);
      if (!target || target.revokedAt) return false;
      const timestamp = this.timestamp();
      this.store.db.prepare("UPDATE devices SET revoked_at = ?, credential_hash = NULL WHERE id = ? AND revoked_at IS NULL").run(timestamp, deviceId);
      this.store.db.prepare("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?").run(timestamp, deviceId);
      this.store.db.prepare("UPDATE protocol_sessions SET disconnected_at = ?, close_code = ? WHERE device_id = ? AND disconnected_at IS NULL").run(timestamp, code, deviceId);
      this.audit("device.revoke", "OK", { ...(actorDeviceId ? { deviceId: actorDeviceId } : {}), targetType: "device", targetId: deviceId });
      return true;
    })();
    this.deferCredentialEffect(() => this.closeDisconnectedSockets(code));
    return changed;
  }

  private revokeAllInternal(actorDeviceId?: string): number {
    this.assertCredentialBoundary();
    const changed = this.store.db.transaction(() => {
      if (actorDeviceId) this.assertDeviceScope(actorDeviceId, "access:admin");
      const timestamp = this.timestamp();
      const count = this.store.db.prepare("UPDATE devices SET revoked_at = ?, credential_hash = NULL WHERE host_id = ? AND revoked_at IS NULL").run(timestamp, this.hostId).changes;
      this.store.db.prepare(`
        UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE device_id IS NULL OR device_id IN (SELECT id FROM devices WHERE host_id = ?)
      `).run(timestamp, this.hostId);
      this.store.db.prepare(`
        UPDATE protocol_sessions SET disconnected_at = ?, close_code = 'DEVICE_REVOKED'
        WHERE device_id IN (SELECT id FROM devices WHERE host_id = ?) AND disconnected_at IS NULL
      `).run(timestamp, this.hostId);
      this.store.db.prepare("UPDATE pairing_grants SET expires_at = ? WHERE consumed_at IS NULL AND (host_id = ? OR host_id IS NULL)").run(this.timestamp(), this.hostId);
      this.audit("device.revoke_all", "OK", { ...(actorDeviceId ? { deviceId: actorDeviceId } : {}), targetType: "host", targetId: this.hostId });
      return count;
    })();
    this.deferCredentialEffect(() => this.closeDisconnectedSockets("DEVICE_REVOKED"));
    return changed;
  }

  private rotateCredential(device: DeviceRecord, publicKey: string, expectedHash?: string): RefreshCredential {
    const refreshCredential = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + REFRESH_CREDENTIAL_TTL_MS).toISOString();
    let credentialRevision = -1;
    this.store.db.transaction(() => {
      this.assertDeviceScope(device.id, "access:self");
      const other = this.store.findDeviceByPublicKey(this.hostId, publicKey);
      if (other && other.id !== device.id) throw new AccessError("DEVICE_ALREADY_PAIRED", "The proposed key belongs to another device");
      const result = this.store.db.prepare(`
        UPDATE devices SET public_key = ?, credential_kind = 'noise-static-key', credential_hash = ?, credential_revision = credential_revision + 1, expires_at = ?, last_seen_at = ?
        WHERE id = ? AND host_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
          AND (? IS NULL OR credential_hash = ?)
      `).run(publicKey, hashSecret(refreshCredential), expiresAt, this.timestamp(), device.id, this.hostId, this.timestamp(), expectedHash ?? null, expectedHash ?? null);
      if (result.changes !== 1) throw new AccessError("REFRESH_INVALID", "Refresh credential is invalid or expired");
      credentialRevision = this.store.getDevice(device.id)!.credentialRevision;
      this.store.db.prepare(`
        UPDATE protocol_sessions SET disconnected_at = ?, close_code = 'CREDENTIAL_ROTATED'
        WHERE device_id = ? AND disconnected_at IS NULL
      `).run(this.timestamp(), device.id);
      this.audit("credential.rotate", "OK", { deviceId: device.id, targetType: "device", targetId: device.id });
    })();
    this.closeDisconnectedSockets("CREDENTIAL_ROTATED");
    return { deviceId: device.id, refreshCredential, credentialRevision, expiresAt, scopes: [...device.scopes] };
  }

  private assertCredentialBoundary(): void {
    if (this.store.db.inTransaction && this.credentialEffects.length === 0) throw new AccessError("CREDENTIAL_COMMIT_REQUIRED", "Credential mutations require an explicit outer commit boundary");
  }

  private deferCredentialEffect(effect: () => unknown): void {
    const pending = this.credentialEffects.at(-1);
    if (pending) pending.push(effect);
    else { this.assertCredentialBoundary(); this.publishCredentialEffects([effect]); }
  }

  private publishCredentialEffects(effects: Array<() => unknown>): void {
    if (this.store.db.inTransaction) throw new AccessError("CREDENTIAL_COMMIT_REQUIRED", "Credential effects require the outer transaction to commit");
    const report = (error: unknown) => { try { this.credentialEffectError?.(error); } catch { /* diagnostics cannot change the committed result */ } };
    for (const effect of effects) {
      try {
        const result = effect();
        if (result && typeof result === "object" && "then" in result) void Promise.resolve(result).catch(report);
      } catch (error) { report(error); }
    }
  }

  private closeDisconnectedSockets(code: string): void {
    for (const id of [...this.sockets.keys()]) {
      const lease = this.store.getProtocolSession(id);
      if (!lease || lease.disconnectedAt) this.closeLease(id, lease?.closeCode ?? code);
    }
  }

  private audit(action: string, resultCode: string, detail: { deviceId?: string; targetType?: string; targetId?: string; transportKind?: string } = {}): void {
    this.store.recordAccessAudit({ ...detail, action, resultCode, occurredAt: this.timestamp() });
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }
}

export function canonicalPublicKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AccessError("DEVICE_KEY_INVALID", "Device public key must be a 32-byte base64url value");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value || bytes.every((byte) => byte === 0)) throw new AccessError("DEVICE_KEY_INVALID", "Device public key is invalid");
  return value;
}

function hashSecret(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new AccessError("CREDENTIAL_INVALID", "Credential is invalid");
  return createHash("sha256").update(value).digest("hex");
}

function isFuture(timestamp: string, now: number): boolean { return Date.parse(timestamp) > now; }

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AccessError("CONFIG_INVALID", "Authorization duration must be a positive integer");
  return value;
}

function deviceInfo(input: { displayName?: string | undefined; platform?: string | undefined } | undefined): { displayName?: string; platform: string } {
  if (input?.displayName !== undefined && (typeof input.displayName !== "string" || input.displayName.length > 128 || /[\u0000-\u001f\u007f]/.test(input.displayName))) {
    throw new AccessError("DEVICE_INFO_INVALID", "Device display name is invalid");
  }
  if (input?.platform !== undefined && (typeof input.platform !== "string" || !/^[a-zA-Z0-9 _.-]{1,64}$/.test(input.platform))) throw new AccessError("DEVICE_INFO_INVALID", "Device platform is invalid");
  return { ...(input?.displayName ? { displayName: input.displayName } : {}), platform: input?.platform ?? "browser" };
}

function closeNumber(code: string): number {
  if (code === "CONNECTION_CLOSED" || code === "HOST_STOPPED") return 1000;
  if (code === "STALE_GENERATION") return 4409;
  return 4401;
}
