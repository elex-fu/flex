import type { SessionEvent } from "@flyx/mvp-protocol";
import type { HostCatalog } from "./host-catalog.js";
import { OrchestratorError, type SessionOrchestrator, type RuntimeCloseReport, type StartTurnResponse, type ControlResponse } from "../session/orchestrator.js";
import type { AdapterStatus } from "../provider/types.js";
import { publicValue, publicEvent, publicGitDiff, publicGitStatus } from "../api/public-projection.js";
export type CatalogLegacyHostOptions = {
    /** Optional Host-global lifecycle, supplied by the local bootstrap. */
    closeAndWait?: (deadlineMs?: number) => Promise<RuntimeCloseReport>;
    registerTransportShutdown?: (close: () => Promise<void>) => () => void;
};
/** Server/Gateway compatibility reads use the stable default without an execution worker. */
export class CatalogLegacyHost {
    private readonly transports = new Set<() => Promise<void>>();
    private closing: Promise<RuntimeCloseReport> | undefined;
    constructor(readonly catalog: HostCatalog, private readonly options: CatalogLegacyHostOptions = {}) { }
    get store() { return this.catalog.store; }
    get owner() { return this.catalog.owner; }
    get sessionId() { return this.catalog.legacySessionId; }
    get workspace() { return this.catalog.registry.resolve(this.sessionId).workspace.canonicalRoot; }
    get checkoutRoot() { return this.catalog.registry.resolve(this.sessionId).workspace.worktreeRoot; }
    get views() { return this.catalog.views; }
    get interactionRpcPort() { return this.catalog.interactionsForSession(this.sessionId); }
    bootstrap() { return this.catalog.bootstrap(); }
    snapshot(): ReturnType<SessionOrchestrator["snapshot"]> {
        const snapshot = this.store.getSnapshot(this.sessionId);
        if (!snapshot)
            throw new OrchestratorError("SESSION_NOT_FOUND", "Default Session does not exist");
        return snapshot;
    }
    private public<T>(value: T): T { const projected = publicValue(value, this.workspace); return (this.checkoutRoot ? publicValue(projected, this.checkoutRoot) : projected) as T; }
    publicSnapshot(): ReturnType<SessionOrchestrator["publicSnapshot"]> { return this.public(this.catalog.legacy.publicSnapshot()); }
    timeline(after = 0, limit = 200, upTo?: number): ReturnType<SessionOrchestrator["timeline"]> {
        const page = this.catalog.registry.readEvents(this.sessionId, after, Math.max(1, Math.min(limit, 200)), upTo);
        return { ...page, events: page.events.map((event) => {
                const payload = event.payload;
                const text = event.type === "assistant.message.delta" && payload && typeof payload === "object" && "itemId" in payload && typeof payload.itemId === "string" ? this.views?.content.publicDelta(event.sessionId, payload.itemId, event.sequence) : undefined;
                return this.public(publicEvent(text !== undefined ? { ...event, payload: { ...payload as object, text } } : event, this.workspace));
            }) };
    }
    timelineItems() { return this.public(this.catalog.legacy.timelineItems()); }
    subscribe(listener: (event: SessionEvent) => void): () => void { return this.catalog.registry.subscribe(this.sessionId, (event) => listener(this.public(publicEvent(event, this.workspace)))); }
    async gitStatus() { if (this.catalog.registry.resolve(this.sessionId).workspace.state !== "active") return { available: false, dirty: false, files: [], error: "Git status unavailable" }; return this.public(publicGitStatus(await this.catalog.registry.gitStatus(this.sessionId), this.workspace)); }
    async gitDiff() { if (this.catalog.registry.resolve(this.sessionId).workspace.state !== "active") return { available: false, dirty: false, files: [], diff: "", truncated: false, error: "Git diff unavailable" }; return this.public(publicGitDiff(await this.catalog.registry.gitDiff(this.sessionId), this.workspace)); }
    /** Configured and already-verified metadata only; status does not run --version or a preflight. */
    async providerStatus(): Promise<AdapterStatus> {
        const provider = this.catalog.registry.resolve(this.sessionId).providerInstance;
        return { provider: provider.provider, transport: provider.provider === "claude" ? "claude-agent-sdk" : "codex-app-server", adapterVersion: "unloaded", executable: provider.executable, runtimeVersion: provider.verification.state === "verified" ? provider.verification.runtimeVersion ?? "unverified" : "unverified", workspace: this.workspace, sandboxRequired: true };
    }
    // Authenticated writes are handled by CatalogRpcPort, carrying its concrete lease/target scope.
    async startTurn(_actor: string, _commandId: string, _prompt: string): Promise<StartTurnResponse> { throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require authenticated Session routing"); }
    async interrupt(_actor: string, _commandId: string): Promise<ControlResponse> { throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require authenticated Session routing"); }
    async respondApproval(_actor: string, _commandId: string, _approvalId: string, _action: "allow_once" | "deny"): Promise<ControlResponse> { throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require authenticated Session routing"); }
    registerTransportShutdown(close: () => Promise<void>): () => void {
        if (this.options.registerTransportShutdown)
            return this.options.registerTransportShutdown(close);
        this.transports.add(close);
        return () => this.transports.delete(close);
    }
    close(): void { void this.closeAndWait().catch(() => undefined); }
    closeAndWait(deadlineMs = 5000): Promise<RuntimeCloseReport> {
        if (this.closing)
            return this.closing;
        if (this.options.closeAndWait) {
            this.closing = this.options.closeAndWait(deadlineMs);
            return this.closing;
        }
        const deadline = Date.now() + Math.max(0, Math.min(deadlineMs, 60000));
        this.closing = (async () => {
            const reports = await this.catalog.closeAndWait(deadlineMs);
            let transportsClosed = true;
            for (const close of this.transports) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const closed = await Promise.race([Promise.resolve().then(close).then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
                    transportsClosed &&= closed;
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            }
            const producerStopped = reports.every((report) => report.producerStopped);
            const clean = transportsClosed && reports.every((report) => report.clean && report.producerStopped);
            if (!clean)
                this.owner.retain("Catalog Host shutdown requires verified recovery");
            return { closed: transportsClosed, producerStopped, clean, state: clean ? "stopped" : "recovery_required", stopped: clean, recoveryRequired: !clean };
        })();
        return this.closing;
    }
}
export function createCatalogLegacyHost(catalog: HostCatalog, options: CatalogLegacyHostOptions = {}): CatalogLegacyHost { return new CatalogLegacyHost(catalog, options); }
