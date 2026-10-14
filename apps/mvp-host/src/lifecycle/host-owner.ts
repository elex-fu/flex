import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SystemProcessInspector, type ProcessIdentity, type ProcessInspector } from "./process-inspector.js";

export type HostOwnerMode = "host" | "maintenance" | "test";
export type OwnershipRecoveryProof = {
  ownerId: string;
  ownerGeneration: number;
  evidenceId: string;
  turnId: string;
  attemptId: string;
  resourceKeys: readonly string[];
};
export type OwnershipRecoveryContext = {
  resourceKey: string;
  ownerId: string;
  ownerGeneration: number;
  purpose: string;
  retainedReason: string;
};
/** The trusted caller must reload committed, revision-fenced Recovery facts. */
export type OwnershipRecoveryVerifier = (proof: OwnershipRecoveryProof, context: OwnershipRecoveryContext) => boolean;
export type OwnershipRecoveryAuthorization = { proof: OwnershipRecoveryProof; verifyProof: OwnershipRecoveryVerifier };

export type HostOwnerHandle = {
  readonly ownerId: string;
  readonly generation: number;
  readonly databasePath: string;
  readonly identityDirectory?: string;
  readonly coordinationDirectory?: string;
  readonly mode: HostOwnerMode;
  readonly recoveryOnly: boolean;
  readonly retainedReason?: string | undefined;
  readonly resourceKeys: readonly string[];
  assertActive(): void;
  assertStorePath(path: string): void;
  heartbeat(): void;
  retain(reason: string): void;
  clearRetention(proof: OwnershipRecoveryProof, verifyProof: OwnershipRecoveryVerifier): void;
  release(): void;
};

export type RecoveryMaintenanceOwnerHandle = HostOwnerHandle & {
  readonly recoveryOnly: true;
  /** End an unsuccessful recovery scope without deleting retained ownership. */
  closeMaintenance(): void;
};

export type HostOwnerOptions = {
  databasePath: string;
  identityDirectory?: string;
  coordinationDirectory?: string;
  mode?: "host" | "maintenance";
  /** Explicit offline maintenance only. Age/heartbeat never authorizes reclaim. */
  reclaimStale?: boolean;
  inspector?: ProcessInspector;
  recovery?: OwnershipRecoveryAuthorization;
};

export class HostOwnershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostOwnershipError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** Canonicalize through existing ancestors without creating the target. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // A dangling link is an existing alias, not a new path. Locking its link
    // name and then letting SQLite follow it could create an unowned target.
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new HostOwnershipError("OWNER_PATH_UNSAFE", "A dangling symbolic link cannot name a Host resource.");
    } catch (entryError) { if (errorCode(entryError) !== "ENOENT") throw entryError; }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), basename(absolute));
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  const contained = (parent: string, child: string) => {
    const suffix = relative(parent, child);
    return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
  };
  return contained(left, right) || contained(right, left);
}

export function assertWorkspacePrivacy(workspace: string, privatePaths: readonly string[]): void {
  const root = canonicalPath(workspace);
  for (const path of privatePaths) {
    if (pathsOverlap(root, canonicalPath(path))) {
      throw new HostOwnershipError("HOST_PRIVATE_PATH_OVERLAP", "Host private data overlaps the configured workspace; move Host data using offline maintenance before executing a Turn.");
    }
  }
}

export function defaultCoordinationDirectory(): string {
  return join(tmpdir(), `flyx-owners-${process.getuid?.() ?? "user"}`);
}

function privateCoordinationDirectory(path: string): string {
  const canonical = canonicalPath(path);
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new HostOwnershipError("OWNER_PATH_UNSAFE", "Host coordination directory must be a private directory owned by this user.");
  }
  return realpathSync(canonical);
}

type OwnerRecord = {
  v: 1;
  ownerId: string;
  ownerGeneration: number;
  resourceKey: string;
  purpose: string;
  process: ProcessIdentity;
  createdAt: string;
  heartbeatAt: string;
  retainedReason?: string;
  recoveryEvidence?: { evidenceId: string; turnId: string; attemptId: string; reconciledAt: string };
};

function exactResources(proof: OwnershipRecoveryProof, expected: readonly string[]): void {
  if (!proof.evidenceId || !proof.turnId || !proof.attemptId || !Array.isArray(proof.resourceKeys) ||
      proof.resourceKeys.some((key) => typeof key !== "string") ||
      JSON.stringify([...proof.resourceKeys].sort()) !== JSON.stringify([...expected].sort())) {
    throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Recovery evidence does not cover the exact retained resources.");
  }
}

function verifyRecovery(record: OwnerRecord, recovery: OwnershipRecoveryAuthorization): void {
  const proof = recovery.proof;
  if (proof.ownerId !== record.ownerId || proof.ownerGeneration !== record.ownerGeneration ||
      !proof.evidenceId || !proof.turnId || !proof.attemptId || !proof.resourceKeys.includes(record.resourceKey) ||
      typeof recovery.verifyProof !== "function" || recovery.verifyProof(proof, {
        resourceKey: record.resourceKey, ownerId: record.ownerId, ownerGeneration: record.ownerGeneration,
        purpose: record.purpose, retainedReason: record.retainedReason ?? "",
      }) !== true) {
    throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Committed recovery evidence did not prove execution stopped for this retained resource.");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRecord(path: string): { record: OwnerRecord; stat: Stats } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe_lock");
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<OwnerRecord>;
    if (value.v !== 1 || typeof value.ownerId !== "string" || !Number.isSafeInteger(value.ownerGeneration) ||
        typeof value.resourceKey !== "string" || !value.process || !Number.isSafeInteger(value.process.pid) ||
        typeof value.process.platform !== "string" || value.process.pid <= 0 ||
        (value.process.birth && (value.process.platform !== "linux" || value.process.birth.kind !== "linux" ||
          !/^[a-f0-9-]{36}$/i.test(value.process.birth.bootId) || !/^\d+$/.test(value.process.birth.startTicks)))) throw new Error("invalid_lock");
    return { record: value as OwnerRecord, stat };
  } finally { closeSync(fd); }
}

/** Shared by Host owner and checkout lease; every mutation uses the guard. */
export class ExclusiveFileLock {
  private released = false;
  private recoveryCleared = false;
  private readonly identity: Stats;

  private constructor(readonly path: string, private readonly fd: number, private readonly record: OwnerRecord,
    private readonly heldGuard?: { path: string; fd: number; identity: Stats; maintenanceId: string }) {
    this.identity = fstatSync(fd);
  }

  static acquire(options: {
    directory: string; resourceKey: string; ownerId: string; ownerGeneration: number;
    purpose: string; inspector: ProcessInspector; reclaimStale?: boolean; recovery?: OwnershipRecoveryAuthorization;
  }): ExclusiveFileLock {
    const directory = privateCoordinationDirectory(options.directory);
    const key = createHash("sha256").update(options.resourceKey).digest("hex");
    const path = join(directory, `${key}.owner`);
    return this.guarded(path, () => {
      try {
        const current = readRecord(path);
        if (!options.reclaimStale) throw new HostOwnershipError("HOST_ALREADY_OWNED", "Another Host or unresolved owner holds this resource. Offline maintenance must verify that owner has exited.");
        if (current.record.retainedReason || options.recovery) {
          if (!options.recovery) throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Previous Host retained this resource because execution could not be proven stopped; reconcile execution before releasing it.");
          verifyRecovery(current.record, options.recovery);
        }
        const inspection = options.inspector.inspect(current.record.process);
        if (inspection.state !== "exited") {
          throw new HostOwnershipError(inspection.state === "alive" ? "HOST_ALREADY_OWNED" : "HOST_OWNER_UNKNOWN", "Previous Host process cannot be proven exited; the owner must remain in place.");
        }
        const verified = readRecord(path);
        if (verified.record.ownerId !== current.record.ownerId || verified.record.ownerGeneration !== current.record.ownerGeneration || !sameFile(verified.stat, current.stat)) {
          throw new HostOwnershipError("HOST_OWNER_LOST", "Host owner changed during offline inspection.");
        }
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          if (error instanceof HostOwnershipError) throw error;
          throw new HostOwnershipError("HOST_OWNER_UNKNOWN", "Existing owner file cannot be safely verified; it must remain in place.");
        }
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const timestamp = new Date().toISOString();
      const record: OwnerRecord = { v: 1, ownerId: options.ownerId, ownerGeneration: options.ownerGeneration,
        resourceKey: options.resourceKey, purpose: options.purpose, process: options.inspector.currentIdentity(),
        createdAt: timestamp, heartbeatAt: timestamp,
        ...(options.recovery ? { recoveryEvidence: { evidenceId: options.recovery.proof.evidenceId,
          turnId: options.recovery.proof.turnId, attemptId: options.recovery.proof.attemptId, reconciledAt: timestamp } } : {}) };
      try {
        writeSync(fd, JSON.stringify(record));
        fsyncSync(fd);
        return new ExclusiveFileLock(path, fd, record);
      } catch (error) {
        const stat = fstatSync(fd);
        closeSync(fd);
        if (sameFile(lstatSync(path), stat)) unlinkSync(path);
        throw error;
      }
    });
  }

  static acquireRetainedForMaintenance(options: { directory: string; resourceKey: string; inspector: ProcessInspector; allowUnretainedCrash?: true }): ExclusiveFileLock {
    const directory = privateCoordinationDirectory(options.directory);
    const path = join(directory, `${createHash("sha256").update(options.resourceKey).digest("hex")}.owner`);
    const guardPath = `${path}.maintenance`;
    let guardFd: number;
    try { guardFd = openSync(guardPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new HostOwnershipError("OWNER_MAINTENANCE_BUSY", "Another maintenance scope holds the retained owner.");
      throw error;
    }
    const heldGuard = { path: guardPath, fd: guardFd, identity: fstatSync(guardFd), maintenanceId: randomUUID() };
    let ownerFd: number | undefined;
    try {
      writeSync(guardFd, JSON.stringify({ v: 1, maintenanceId: heldGuard.maintenanceId, resourceKey: options.resourceKey, process: options.inspector.currentIdentity() }));
      fsyncSync(guardFd);
      const current = readRecord(path);
      if ((!current.record.retainedReason && !options.allowUnretainedCrash) || current.record.resourceKey !== options.resourceKey) {
        throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Recovery maintenance requires the exact retained owner resource.");
      }
      const inspected = options.inspector.inspect(current.record.process);
      if (inspected.state !== "exited") throw new HostOwnershipError(inspected.state === "alive" ? "HOST_ALREADY_OWNED" : "HOST_OWNER_UNKNOWN", "The original Host process cannot be proven exited; recovery maintenance is blocked.");
      const verified = readRecord(path);
      if (verified.record.ownerId !== current.record.ownerId || verified.record.ownerGeneration !== current.record.ownerGeneration ||
          verified.record.resourceKey !== options.resourceKey || JSON.stringify(verified.record) !== JSON.stringify(current.record) || !sameFile(verified.stat, current.stat)) {
        throw new HostOwnershipError("HOST_OWNER_LOST", "Retained ownership changed during process inspection.");
      }
      ownerFd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      if (!sameFile(fstatSync(ownerFd), verified.stat)) throw new HostOwnershipError("HOST_OWNER_LOST", "Retained owner file changed while opening recovery scope.");
      return new ExclusiveFileLock(path, ownerFd, verified.record, heldGuard);
    } catch (error) {
      if (ownerFd !== undefined) closeSync(ownerFd);
      ExclusiveFileLock.closeHeldGuard(heldGuard);
      throw error;
    }
  }

  ownership(): { ownerId: string; ownerGeneration: number; resourceKey: string; retainedReason?: string } {
    return { ownerId: this.record.ownerId, ownerGeneration: this.record.ownerGeneration, resourceKey: this.record.resourceKey,
      ...(this.record.retainedReason ? { retainedReason: this.record.retainedReason } : {}) };
  }

  /** Verify every resource before the caller clears any retained file. */
  validateRecovery(proof: OwnershipRecoveryProof, verifyProof: OwnershipRecoveryVerifier): OwnershipRecoveryContext {
    return this.withGuard(() => {
      this.assertActive();
      const current = readRecord(this.path);
      verifyRecovery(current.record, { proof, verifyProof });
      this.assertActive();
      return { resourceKey: current.record.resourceKey, ownerId: current.record.ownerId, ownerGeneration: current.record.ownerGeneration,
        purpose: current.record.purpose, retainedReason: current.record.retainedReason ?? "" };
    });
  }

  closeMaintenance(): void {
    if (this.released) return;
    if (!this.heldGuard) throw new HostOwnershipError("OFFLINE_OWNER_REQUIRED", "Only a held recovery scope can close without releasing ownership.");
    this.released = true;
    try { closeSync(this.fd); } finally { ExclusiveFileLock.closeHeldGuard(this.heldGuard); }
  }

  private assertHeldGuard(): void {
    if (!this.heldGuard) return;
    const stat = lstatSync(this.heldGuard.path);
    const value = JSON.parse(readFileSync(this.heldGuard.path, "utf8")) as {maintenanceId?:string};
    if (!sameFile(stat, this.heldGuard.identity) || value.maintenanceId !== this.heldGuard.maintenanceId) {
      throw new HostOwnershipError("HOST_OWNER_LOST", "Recovery maintenance guard changed ownership.");
    }
  }

  private withGuard<T>(operation: () => T): T {
    if (!this.heldGuard) return ExclusiveFileLock.guarded(this.path, operation);
    this.assertHeldGuard();
    return operation();
  }

  private static closeHeldGuard(guard: { path: string; fd: number; identity: Stats; maintenanceId: string }): void {
    try {
      const stat = lstatSync(guard.path);
      const record = JSON.parse(readFileSync(guard.path, "utf8")) as {maintenanceId?:string};
      if (!sameFile(stat, guard.identity) || record.maintenanceId !== guard.maintenanceId) {
        throw new HostOwnershipError("HOST_OWNER_LOST", "Recovery maintenance guard must not delete a successor's exclusion.");
      }
      unlinkSync(guard.path);
    } finally { closeSync(guard.fd); }
  }

  assertActive(): void {
    if (this.released) throw new HostOwnershipError("HOST_OWNER_LOST", "Host owner has already been released.");
    try {
      this.assertHeldGuard();
      const current = readRecord(this.path);
      if (current.record.ownerId !== this.record.ownerId || current.record.ownerGeneration !== this.record.ownerGeneration || current.record.resourceKey !== this.record.resourceKey ||
          !sameFile(current.stat, this.identity) || (this.heldGuard && JSON.stringify(current.record) !== JSON.stringify(this.record))) throw new Error("owner_replaced");
    } catch {
      throw new HostOwnershipError("HOST_OWNER_LOST", "Host owner file no longer matches this invocation.");
    }
  }

  heartbeat(): void {
    if (this.heldGuard) throw new HostOwnershipError("HOST_RECOVERY_ONLY", "Recovery scope cannot rewrite retained ownership before evidence commits.");
    this.withGuard(() => {
      this.assertActive();
      this.record.heartbeatAt = new Date().toISOString();
      ftruncateSync(this.fd, 0);
      writeSync(this.fd, JSON.stringify(this.record), 0, "utf8");
      fsyncSync(this.fd);
    });
  }

  retain(reason: string): void {
    if (this.heldGuard) throw new HostOwnershipError("HOST_RECOVERY_ONLY", "Recovery scope cannot rewrite retained ownership before evidence commits.");
    if (!reason) throw new Error("Owner retention requires a reason");
    this.withGuard(() => {
      this.assertActive();
      this.record.retainedReason = reason.slice(0, 1024);
      ftruncateSync(this.fd, 0);
      writeSync(this.fd, JSON.stringify(this.record), 0, "utf8");
      fsyncSync(this.fd);
    });
  }

  clearRetention(proof: OwnershipRecoveryProof, verifyProof: OwnershipRecoveryVerifier): void {
    this.withGuard(() => {
      this.assertActive();
      const current = readRecord(this.path);
      verifyRecovery(current.record, { proof, verifyProof });
      this.assertActive(); // The verifier must not replace the checked lock.
      delete this.record.retainedReason;
      this.recoveryCleared = true;
      this.record.recoveryEvidence = { evidenceId: proof.evidenceId, turnId: proof.turnId, attemptId: proof.attemptId, reconciledAt: new Date().toISOString() };
      ftruncateSync(this.fd, 0);
      writeSync(this.fd, JSON.stringify(this.record), 0, "utf8");
      fsyncSync(this.fd);
    });
  }

  release(): void {
    if (this.released) return;
    if (this.heldGuard && !this.recoveryCleared) throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Held crash recovery cannot release original ownership without committed stop evidence.");
    if (this.record.retainedReason) throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Host owner must remain in place until retained execution is reconciled.");
    try {
      this.withGuard(() => {
        this.assertActive();
        unlinkSync(this.path);
      });
    } finally {
      this.released = true;
      try { closeSync(this.fd); } finally { if (this.heldGuard) ExclusiveFileLock.closeHeldGuard(this.heldGuard); }
    }
  }

  private static guarded<T>(path: string, operation: () => T): T {
    const guardPath = `${path}.maintenance`;
    let guard: number;
    try { guard = openSync(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new HostOwnershipError("OWNER_MAINTENANCE_BUSY", "Host owner maintenance is in progress or requires offline inspection.");
      throw error;
    }
    const identity = fstatSync(guard);
    try { return operation(); }
    finally {
      closeSync(guard);
      try { if (sameFile(lstatSync(guardPath), identity)) unlinkSync(guardPath); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
  }
}

const handles = new WeakSet<object>();

export function assertHostOwner(owner: HostOwnerHandle): void {
  if (!handles.has(owner)) throw new HostOwnershipError("HOST_OWNER_REQUIRED", "A verified Host owner handle is required before opening a writer.");
  owner.assertActive();
}

export class HostOwnerLock {
  /** Offline journal/evidence scope. Retained records are unchanged until committed proof clears them. */
  static acquireForRecoveryMaintenance(options: Omit<HostOwnerOptions, "mode" | "reclaimStale" | "recovery">): RecoveryMaintenanceOwnerHandle {
    if (options.databasePath === ":memory:") throw new HostOwnershipError("OFFLINE_OWNER_REQUIRED", "Recovery maintenance requires an existing retained file-backed Host.");
    const databasePath = canonicalPath(options.databasePath);
    const identityDirectory = canonicalPath(options.identityDirectory ?? join(dirname(databasePath), "identity"));
    const coordinationDirectory = privateCoordinationDirectory(options.coordinationDirectory ?? defaultCoordinationDirectory());
    const resourceKeys = [`db:${databasePath}`, `identity:${identityDirectory}`].sort();
    const locks: ExclusiveFileLock[] = [];
    try {
      for (const resourceKey of resourceKeys) locks.push(ExclusiveFileLock.acquireRetainedForMaintenance({ directory: coordinationDirectory, resourceKey, inspector: options.inspector ?? new SystemProcessInspector(), allowUnretainedCrash: true }));
      const first = locks[0]!.ownership();
      if (locks.some((lock) => lock.ownership().ownerId !== first.ownerId || lock.ownership().ownerGeneration !== first.ownerGeneration)) {
        throw new HostOwnershipError("HOST_OWNER_UNKNOWN", "Retained DB and identity resources belong to different Host invocations.");
      }
    } catch (error) {
      for (const lock of [...locks].reverse()) lock.closeMaintenance();
      throw error;
    }
    const original = locks[0]!.ownership();
    let retainedReason: string | undefined = original.retainedReason;
    let closed = false;
    let recoveryAuthorized = false;
    const handle: RecoveryMaintenanceOwnerHandle = {
      ownerId: original.ownerId, generation: original.ownerGeneration, databasePath, identityDirectory, coordinationDirectory,
      mode: "maintenance", recoveryOnly: true, resourceKeys: Object.freeze(resourceKeys), get retainedReason() { return retainedReason; },
      assertActive: () => {
        if (closed) throw new HostOwnershipError("HOST_OWNER_LOST", "Recovery maintenance scope has closed.");
        locks.forEach((lock) => { lock.assertActive(); lock.ownership(); });
      },
      assertStorePath: (path) => { handle.assertActive(); if (canonicalPath(path) !== databasePath) throw new HostOwnershipError("OWNER_STORE_MISMATCH", "Recovery scope belongs to another database."); },
      heartbeat: () => handle.assertActive(),
      retain: () => { throw new HostOwnershipError("HOST_RECOVERY_ONLY", "Recovery scope preserves its original retained ownership."); },
      clearRetention: (proof, verifyProof) => {
        handle.assertActive(); exactResources(proof, resourceKeys);
        const verified = locks.map((lock) => lock.validateRecovery(proof, verifyProof));
        const cachedVerifier: OwnershipRecoveryVerifier = (_, context) => verified.some((originalContext) =>
          JSON.stringify(originalContext) === JSON.stringify(context));
        locks.forEach((lock) => lock.clearRetention(proof, cachedVerifier));
        recoveryAuthorized = true;
        retainedReason = undefined;
      },
      release: () => {
        if (closed) return;
        if (!recoveryAuthorized || retainedReason) throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Recovery maintenance cannot release original ownership without committed stop evidence.");
        const failures: unknown[] = [];
        for (const lock of [...locks].reverse()) { try { lock.release(); } catch (error) { failures.push(error); } }
        closed = true;
        if (failures.length) throw new AggregateError(failures, "Recovery owner release could not verify every resource.");
      },
      closeMaintenance: () => {
        if (closed) return;
        const failures: unknown[] = [];
        for (const lock of [...locks].reverse()) { try { lock.closeMaintenance(); } catch (error) { failures.push(error); } }
        closed = true;
        if (failures.length) throw new AggregateError(failures, "Recovery maintenance exclusion could not safely close.");
      },
    };
    handles.add(handle);
    return Object.freeze(handle);
  }

  static acquire(options: HostOwnerOptions): HostOwnerHandle {
    if (options.databasePath === ":memory:") throw new HostOwnershipError("HOST_OWNER_REQUIRED", "Use an explicit test owner for an in-memory Store.");
    const mode = options.mode ?? "host";
    if (options.reclaimStale && mode !== "maintenance") throw new HostOwnershipError("OFFLINE_OWNER_REQUIRED", "Stale owner reclaim requires offline maintenance.");
    const databasePath = canonicalPath(options.databasePath);
    const identityDirectory = canonicalPath(options.identityDirectory ?? join(dirname(databasePath), "identity"));
    const coordinationDirectory = privateCoordinationDirectory(options.coordinationDirectory ?? defaultCoordinationDirectory());
    const ownerId = randomUUID();
    const generation = randomInt(1, 2_147_483_647);
    const resourceKeys = [`db:${databasePath}`, `identity:${identityDirectory}`].sort();
    if (options.recovery) {
      if (!options.reclaimStale || mode !== "maintenance") throw new HostOwnershipError("OFFLINE_OWNER_REQUIRED", "Offline recovery ownership requires explicit stale reclamation.");
      exactResources(options.recovery.proof, resourceKeys);
    }
    const locks: ExclusiveFileLock[] = [];
    try {
      for (const resourceKey of resourceKeys) {
        locks.push(ExclusiveFileLock.acquire({ directory: coordinationDirectory, resourceKey, ownerId,
          ownerGeneration: generation, purpose: mode, inspector: options.inspector ?? new SystemProcessInspector(),
          ...(options.reclaimStale ? { reclaimStale: true } : {}),
          ...(options.recovery ? { recovery: options.recovery } : {}) }));
      }
    } catch (error) {
      for (const lock of locks.reverse()) lock.release();
      throw error;
    }
    let released = false;
    let retainedReason: string | undefined;
    const handle: HostOwnerHandle = { ownerId, generation, databasePath, identityDirectory, coordinationDirectory, mode, recoveryOnly: false,
      resourceKeys: Object.freeze(resourceKeys),
      get retainedReason() { return retainedReason; },
      assertActive: () => {
        if (released) throw new HostOwnershipError("HOST_OWNER_LOST", "Host owner has been released.");
        locks.forEach((lock) => lock.assertActive());
      },
      assertStorePath: (path) => {
        handle.assertActive();
        if (canonicalPath(path) !== databasePath) throw new HostOwnershipError("OWNER_STORE_MISMATCH", "Host owner belongs to a different database.");
      },
      heartbeat: () => { handle.assertActive(); locks.forEach((lock) => lock.heartbeat()); },
      retain: (reason) => {
        if (!reason) throw new Error("Owner retention requires a reason");
        handle.assertActive(); retainedReason = reason.slice(0, 1024); locks.forEach((lock) => lock.retain(reason));
      },
      clearRetention: (proof, verifyProof) => {
        handle.assertActive();
        exactResources(proof, resourceKeys);
        locks.forEach((lock) => lock.clearRetention(proof, verifyProof));
        retainedReason = undefined;
      },
      release: () => {
        if (released) return;
        if (retainedReason) throw new HostOwnershipError("OWNER_RECOVERY_REQUIRED", "Host owner remains retained until execution is reconciled.");
        const failures: unknown[] = [];
        for (const lock of [...locks].reverse()) { try { lock.release(); } catch (error) { failures.push(error); } }
        released = true;
        if (failures.length) throw new AggregateError(failures, "Host owner release could not verify every resource.");
      },
    };
    handles.add(handle);
    return Object.freeze(handle);
  }
}

/** Explicit ephemeral owner. It cannot authorize opening any file-backed Store. */
export function createTestHostOwner(): HostOwnerHandle {
  let active = true;
  const handle: HostOwnerHandle = { ownerId: `test-${randomUUID()}`, generation: 1, databasePath: ":memory:", mode: "test", recoveryOnly: false, resourceKeys: [],
    assertActive: () => { if (!active) throw new HostOwnershipError("HOST_OWNER_LOST", "Test owner has been released."); },
    assertStorePath: (path) => { handle.assertActive(); if (path !== ":memory:") throw new HostOwnershipError("OWNER_STORE_MISMATCH", "Test owner can only open an in-memory Store."); },
    heartbeat: () => handle.assertActive(), release: () => { active = false; },
    retain: () => handle.assertActive(),
    clearRetention: () => handle.assertActive(),
  };
  handles.add(handle);
  return Object.freeze(handle);
}
