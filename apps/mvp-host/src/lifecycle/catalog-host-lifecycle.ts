import type { SqliteStore } from "../storage/db.js";
import { assertHostOwner, type HostOwnerHandle } from "./host-owner.js";
import { HostLifecycle } from "./host-lifecycle.js";
import { OperationRegistry, type OperationKind } from "./operation-registry.js";
import type { RuntimeCloseReport } from "../session/orchestrator.js";
import type { RuntimeCloseReport as CatalogRuntimeCloseReport } from "../session/session-registry.js";

/** Global services use an absolute deadline; Session runtimes use a remaining duration. */
export type CatalogGlobalService = {
  drain(deadlineAt: number): Promise<void | boolean>;
  seal?(): void;
  close?(): Promise<void> | void;
};
export type CatalogHostLifecycleOptions = {
  store: SqliteStore;
  owner: HostOwnerHandle;
  catalog: { closeAndWait(deadlineMs: number): Promise<readonly CatalogRuntimeCloseReport[]> };
  operations?: OperationRegistry;
  services?: readonly CatalogGlobalService[];
  /** Only actual accepted work may be recorded as unknown by this callback. */
  recordUnknown?(reason: string): Promise<void> | void;
  sealJournals?(): void;
  afterTransportsClosed?(): Promise<void> | void;
};

/** Owns the shared Store; an individual Session never closes this boundary. */
export class CatalogHostLifecycle {
  readonly operations: OperationRegistry;
  private readonly lifecycle: HostLifecycle;
  private readonly transports = new Set<() => Promise<void>>();
  private readonly services: CatalogGlobalService[];
  private reports: Promise<readonly CatalogRuntimeCloseReport[]> | undefined;
  private closing: Promise<RuntimeCloseReport> | undefined;
  private deadlineAt = Infinity;
  private sealed = false;
  private admitting = true;

  constructor(private readonly options: CatalogHostLifecycleOptions) {
    assertHostOwner(options.owner);
    options.owner.assertStorePath(options.store.db.name);
    options.store.assertWriterOwner();
    if (options.owner.recoveryOnly || options.owner.mode === "maintenance") throw new Error("HOST_RECOVERY_ONLY");
    this.operations = options.operations ?? new OperationRegistry();
    this.services = [...(options.services ?? [])];
    this.lifecycle = new HostLifecycle({
      stopAdmission: () => {
        this.admitting = false;
        this.operations.beginDrain();
        // Calling Catalog close synchronously fences new runtime loads before any await.
        this.reports = options.catalog.closeAndWait(this.remaining());
      },
      stopDispatch: () => {}, // Catalog close owns every selected Session's Worker.
      stopProducers: async () => {
        const reports = await this.reports!;
        return { stopped: reports.every((report) => report.clean && report.producerStopped) && !options.owner.retainedReason };
      },
      drainIngestion: async () => true, // Each runtime's close report includes ingestion drain.
      drainOperations: async () => this.operations.drain(["producer", "control", "ingestion", "checkpoint"], this.remaining()),
      drainServices: async () => {
        let drained = true;
        for (const service of this.services) {
          try { drained = await service.drain(this.deadlineAt) !== false && drained; }
          catch { drained = false; }
        }
        return drained;
      },
      fenceCallbacks: () => this.operations.seal(),
      recordUnknown: (reason) => options.recordUnknown?.(reason),
      retainOwnership: (reason) => options.owner.retain(reason),
      closeTransports: async () => {
        const results = await Promise.allSettled([...this.transports].map((close) => Promise.resolve().then(close)));
        this.sealServices();
        for (const service of this.services) await service.close?.();
        await options.afterTransportsClosed?.();
        if (results.some((result) => result.status === "rejected")) throw new Error("HOST_TRANSPORT_CLOSE_FAILED");
      },
      sealJournal: () => {
        let failure: unknown;
        try { this.sealServices(); } catch (error) { failure = error; }
        try { options.sealJournals?.(); } catch (error) { failure ??= error; }
        if (failure) throw failure;
      },
      closeStore: () => options.store.close(),
      releaseOwnership: () => options.owner.release(),
    });
  }

  get readiness() { return this.lifecycle.readiness; }
  markReady(): void { this.lifecycle.markReady(true); }
  assertAdmission(): void {
    if (!this.admitting) throw new Error("HOST_DRAINING");
    assertHostOwner(this.options.owner);
    this.options.store.assertWriterOwner();
    this.lifecycle.assertWritable();
  }
  trackOperation<T>(kind: OperationKind, work: () => Promise<T>): Promise<T> {
    try { this.assertAdmission(); } catch (error) { return Promise.reject(error); }
    return this.operations.track(kind, work);
  }
  registerService(service: CatalogGlobalService): () => void {
    if (!this.admitting) throw new Error("HOST_DRAINING");
    this.services.push(service);
    return () => { if (this.admitting) { const index = this.services.indexOf(service); if (index !== -1) this.services.splice(index, 1); } };
  }
  registerTransportShutdown(close: () => Promise<void>): () => void {
    if (!this.admitting) throw new Error("HOST_DRAINING");
    this.transports.add(close);
    return () => { if (this.admitting) this.transports.delete(close); };
  }
  closeAndWait(deadlineMs = 5000): Promise<RuntimeCloseReport> {
    if (this.closing) return this.closing;
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 60000) throw new Error("HOST_SHUTDOWN_DEADLINE_INVALID");
    this.deadlineAt = Date.now() + deadlineMs;
    this.closing = this.lifecycle.shutdown(deadlineMs).then((result) => ({
      ...result, closed: !this.options.store.db.open, producerStopped: result.stopped,
      clean: result.stopped && !result.recoveryRequired && !this.options.owner.retainedReason,
      state: result.stopped && !result.recoveryRequired ? "stopped" : "recovery_required",
    }));
    return this.closing;
  }
  private remaining(): number { return Math.max(0, this.deadlineAt - Date.now()); }
  private sealServices(): void {
    if (this.sealed) return;
    this.sealed = true;
    let failure: unknown;
    for (const service of this.services) { try { service.seal?.(); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  }
}
