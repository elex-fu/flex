import { z, ZodError } from "zod";
import { ProtocolVersion, SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, CreateSessionV2Schema, RenameSessionV2Schema, ChangeSessionStatusV2Schema, ListSessionsV2Schema, SessionTargetV2Schema, StartTurnV2Schema, InterruptTurnV2Schema, RespondApprovalV2Schema, EmptyCatalogRequestSchema, SessionEventsV2RequestSchema, SessionDiffV2RequestSchema, HOST_CATALOG_METHOD_SCOPES, OpenViewRequestSchema, TimelinePageRequestSchema, TimelineSubscribeRequestSchema, TimelineUnsubscribeRequestSchema, ContentChunkRequestSchema, InteractionSchema, type CatalogMutationResponse, type SessionSummaryV2, type SessionEvent, type SessionExecutionResponseV2, type Bootstrap, } from "@flyx/mvp-protocol";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { assertHostOwner } from "../lifecycle/host-owner.js";
import type { ActivationReadinessPort } from "../lifecycle/host-activation-load.js";
import { ActivationServiceError } from "../lifecycle/host-activation-service.js";
import type { CompatibilityScenePolicy, CompatibilityScenePermit } from "../diagnostics/compatibility-scene-policy.js";
import type { SqliteStore, CommandReceiptRow } from "../storage/db.js";
import { CatalogError, CatalogStore, publicSessionSummary, type CatalogCommit, type CatalogSession, type ProviderVerification, type ProviderInstanceRecord } from "../storage/catalog-store.js";
import { validateCatalogSchema } from "../storage/migrations/007-catalog.js";
import { registerConfiguredCatalog, LocalCatalogConfigurationSchema, type LocalCatalogConfiguration } from "../session/configured-catalog.js";
import { SessionRegistry, type SessionRuntimeContext, type RuntimeCloseReport, type ResolvedSession } from "../session/session-registry.js";
import { LegacySessionFacade } from "../session/legacy-session-facade.js";
import { SessionOrchestrator, OrchestratorError, type OrchestratorOptions, type StartTurnResponse, type ControlResponse } from "../session/orchestrator.js";
import { assertReceiptRequest, type CommandRequest } from "../orchestration/command-contract.js";
import { hashCommandRequest } from "../orchestration/command-engine.js";
import { digest } from "../storage/recovery-store.js";
import { HostViews, type ViewInteractionReader, type ViewResource } from "../timeline/host-views.js";
import { publicValue, publicEvent, publicGitDiff } from "../api/public-projection.js";
import type { RpcContext, RpcRequest } from "../api/rpc-dispatcher.js";
import type { WorkspaceRegistry, WorkspaceGitQuery } from "../workspace/workspace-registry.js";
import type { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import type { InteractionRpcPort } from "../interaction/host-interactions.js";
import { CatalogInteractionReader } from "./catalog-interaction-reader.js";
import { CatalogLegacyHost } from "./catalog-legacy-host.js";
import { invalidateCatalogResourceReadiness, registerCatalogReadMetadata } from "./catalog-read-bootstrap.js";
export type CatalogAccessScope = "session:read" | "session:write" | "approval:write";
export interface CatalogExecutionRuntime {
    readonly sessionId: string;
    readonly runtimeId: string;
    readonly store: SqliteStore;
    readonly owner: HostOwnerHandle;
    readonly ownsStore: boolean;
    readonly recoverOnStart: boolean;
    readonly requestFormatVersions: readonly number[];
    readonly interactionRpcPort?: InteractionRpcPort | undefined;
    closeAndWait(deadlineMs?: number): Promise<RuntimeCloseReport>;
    /** Idempotent synchronous fence of callbacks and journals, with no SQL or stop claim. */
    sealBeforeStoreClose(): void;
    subscribe(listener: (event: SessionEvent) => void): () => void;
    startTurn(actor: string, commandId: string, prompt: string, request?: CommandRequest): Promise<StartTurnResponse>;
    interrupt(actor: string, commandId: string, request?: CommandRequest): Promise<ControlResponse>;
    respondApproval(actor: string, commandId: string, approvalId: string, action: "allow_once" | "deny", request?: CommandRequest): Promise<ControlResponse>;
}
export type CatalogRuntimeServices = {
    views?: HostViews;
    registry: SessionRegistry<CatalogExecutionRuntime>;
    catalog: CatalogStore;
    workspaces: WorkspaceRegistry;
    providers: ProviderInstanceRegistry;
};
export type CatalogRuntimeOptions = Pick<OrchestratorOptions, "executionSetup" | "executionHooks" | "checkpoints" | "genericOperations" | "onExecutionBlocked" | "nativeStateRoots" | "nativeBoundaryFactory" | "revalidateDevice" | "interactionEvents" | "recovery" | "assertWriteReady" | "assertNativeReady" | "gitRunner" | "executionPermits" | "canReleaseAdditionalProducers" | "nativeScenePolicy" | "adapter" | "canReleaseWorkspace">;
export type HostCatalogOptions = {
    store: SqliteStore;
    owner: HostOwnerHandle;
    configuration: LocalCatalogConfiguration;
    privateDirectories?: readonly string[];
    initialLegacySession?: {
        workspaceId: string;
        providerInstanceId: string;
        title?: string;
    };
    readOnlyGit?: WorkspaceGitQuery;
    /**
     * Explicit execution-activation readiness (design §6.3 step 5). Receives the
     * freshly opened CatalogStore so the port reads exactly the records the
     * metadata bootstrap registers; supplied only for the metadata read path,
     * where the bootstrap withdraws the verdicts the recorded facts no longer
     * support instead of invalidating unconditionally.
     */
    activationReadiness?: (catalog: CatalogStore) => ActivationReadinessPort;
    /** Local trusted integrations only. No RPC path can supply runtime options. */
    runtimeOptions?: (context: SessionRuntimeContext, services: CatalogRuntimeServices) => CatalogRuntimeOptions;
    runtimeFactory?: (context: SessionRuntimeContext, services: CatalogRuntimeServices) => Promise<CatalogExecutionRuntime> | CatalogExecutionRuntime;
    verifyProvider?: (context: SessionRuntimeContext, runtime: CatalogExecutionRuntime) => Promise<ProviderVerification>;
    restoreWriteReady?: (db: SqliteStore["db"]) => void;
    /** New prompts only; controls act on their original loaded attempt. */
    assertNativeReady?: (target: ResolvedSession, authorization?: CompatibilityScenePermit) => void;
    nativeScenePolicy?: () => CompatibilityScenePolicy | undefined;
    assertSessionAccess?: (subjectId: string, target: ResolvedSession, scope: CatalogAccessScope) => void;
    assertWorkspaceAccess?: (subjectId: string, workspaceId: string, scope: "session:read" | "session:write") => void;
    readViewInteractions?: ViewInteractionReader;
    interactionsForSession?: (sessionId: string) => InteractionRpcPort | undefined;
    hostViews?: HostViews;
    globalServices?: readonly {
        drain(deadlineMs: number): Promise<void | boolean>;
        seal?(): void;
        close?(): Promise<void> | void;
    }[];
    runtimeCloseDeadlineMs?: number;
};
export type CatalogConfigurationRevalidationOptions = {
    readOnlyGit?: WorkspaceGitQuery;
    /** Trusted installed-contract evidence; a Native boundary assessment is insufficient. */
    verifyProviderConfiguration?: (provider: ProviderInstanceRecord) => ProviderVerification | Promise<ProviderVerification>;
};
export interface CatalogRpcContext extends RpcContext {
    assertSessionScope?(sessionId: string, scope: CatalogAccessScope): void;
}
export type CatalogDispatchResult = {
    handled: false;
} | {
    handled: true;
    payload: unknown;
};
const empty = (value: unknown) => EmptyCatalogRequestSchema.parse(value ?? {});
const legacyPrompt = z.object({ prompt: z.string().min(1).max(16 * 1024) });
const legacyEvents = z.object({ sessionId: z.string().min(1).max(256).optional(), afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(200), upTo: z.number().int().nonnegative().optional() });
const legacyApproval = z.object({ approvalId: z.string().min(1).max(256), action: z.enum(["allow_once", "deny"]) });
const interactionPage = z.strictObject({interactions:z.array(InteractionSchema).max(50),hasMore:z.boolean(),nextAfterInteractionId:z.string().min(1).max(256).optional()});
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const openCatalogStores = new WeakSet<SqliteStore>();
const unknownClose = (): RuntimeCloseReport => ({ closed: false, producerStopped: false, clean: false, state: "recovery_required", recoveryRequired: true });
/** One Host owner/writer/Views graph; Provider processes are per-Session and lazy. */
export class HostCatalog {
    readonly registry: SessionRegistry<CatalogExecutionRuntime>;
    readonly legacy: LegacySessionFacade;
    readonly legacyHost: CatalogLegacyHost;
    readonly views: HostViews | undefined;
    get ready() { return this.capabilities().includes(SESSION_CATALOG_CAPABILITY); }
    private readonly ownsViews: boolean;
    private readonly interactionReader: CatalogInteractionReader | undefined;
    private closed = false;
    private runtimeCompletionsSealed = false;
    private storeSealed = false;
    private readonly sealedRuntimes = new WeakSet<CatalogExecutionRuntime>();
    private closing: Promise<RuntimeCloseReport[]> | undefined;
    private readonly preparing = new Map<string, {
        context: SessionRuntimeContext;
        runtime: CatalogExecutionRuntime;
    }>();
    constructor(readonly catalog: CatalogStore, readonly workspaces: WorkspaceRegistry, readonly providers: ProviderInstanceRegistry, private readonly options: HostCatalogOptions) {
        assertHostOwner(options.owner);options.owner.assertStorePath(options.store.db.name);
        if(catalog.store!==options.store||workspaces.catalog!==catalog||providers.catalog!==catalog)throw new CatalogError("CATALOG_SHARED_STORE_MISMATCH");
        if(options.owner.recoveryOnly||options.owner.mode==="maintenance")throw new CatalogError("HOST_RECOVERY_ONLY");
        if(!options.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get())throw new CatalogError("CATALOG_SCHEMA_UNAVAILABLE");
        validateCatalogSchema(options.store.db);
        if (options.runtimeCloseDeadlineMs !== undefined && (!Number.isSafeInteger(options.runtimeCloseDeadlineMs) || options.runtimeCloseDeadlineMs < 1 || options.runtimeCloseDeadlineMs > 60000))
            throw new CatalogError("CATALOG_CONFIGURATION_INVALID");
        this.registry = new SessionRegistry(catalog, workspaces, providers, { owner: options.owner, runtimeFactory: (context) => this.loadRuntime(context), sealRuntime: (runtime) => this.sealRuntime(runtime), ...(options.nativeScenePolicy ? { nativeScenePolicy: options.nativeScenePolicy } : {}) });
        this.legacy = new LegacySessionFacade(this.registry);
        this.legacyHost = new CatalogLegacyHost(this);
        this.interactionReader = CatalogInteractionReader.isAvailable(this.store) ? new CatalogInteractionReader(this.store, (id) => { this.owner.assertActive(); this.registry.resolve(id); }) : undefined;
        this.ownsViews = !options.hostViews;
        this.views = options.hostViews ?? (HostViews.isAvailable(options.store) ? new HostViews(options.store, options.owner, { resolveResource: (id) => this.viewResource(id), assertSessionAccess: (owner, resource) => this.assertActorSession(owner.subjectId, resource.sessionId, "session:read") }) : undefined);
        if (this.views && (this.views.store !== options.store || this.views.owner !== options.owner))
            throw new CatalogError("CATALOG_SHARED_VIEWS_MISMATCH");
        this.views?.prepareStoredSessions();
    }
    get store() { return this.options.store; }
    get owner() { return this.options.owner; }
    get legacySessionId() { return this.legacy.sessionId; }
    assertExecutionResources(sessionId: string): ResolvedSession { return this.registry.assertExecutionResources(sessionId); }
    /** Explicit local configuration step; SQL/history startup never calls it. */
    async revalidateConfiguration(configuration: LocalCatalogConfiguration, options: CatalogConfigurationRevalidationOptions = {}): Promise<void> {
        this.owner.assertActive();
        if (this.closed) throw new CatalogError("HOST_CLOSING");
        const parsed = LocalCatalogConfigurationSchema.parse(configuration);
        if (parsed.legacyDefaultSessionId && parsed.legacyDefaultSessionId !== this.legacySessionId) throw new CatalogError("LEGACY_DEFAULT_CONFLICT");
        for (const session of this.catalog.allSessions()) {
            this.catalog.assertIdle(session.sessionId);
            if (session.residency !== "unloaded") throw new CatalogError("CATALOG_RESOURCES_BUSY");
        }
        this.store.db.transaction(() => invalidateCatalogResourceReadiness(this.catalog, this.owner))();
        const readOnlyGit = options.readOnlyGit ?? this.options.readOnlyGit;
        await registerConfiguredCatalog(this.catalog, this.owner, parsed, { ...(this.options.privateDirectories ? { privateDirectories: this.options.privateDirectories } : {}), ...(readOnlyGit ? { readOnlyGit } : {}) });
        if (this.closed) throw new CatalogError("HOST_CLOSING");
        for (const input of parsed.providerInstances) {
            if (!options.verifyProviderConfiguration) continue;
            const verification = await options.verifyProviderConfiguration(this.providers.require(input.providerInstanceId));
            this.owner.assertActive();
            if (this.closed) throw new CatalogError("HOST_CLOSING");
            this.providers.recordVerification(input.providerInstanceId, verification);
        }
    }
    capabilities(): readonly string[] { try {
        this.owner.assertActive();
        return this.closed ? [] : [SESSION_CATALOG_CAPABILITY];
    }
    catch {
        return [];
    } }
    private services(): CatalogRuntimeServices { return { registry: this.registry, catalog: this.catalog, workspaces: this.workspaces, providers: this.providers, ...(this.views ? { views: this.views } : {}) }; }
    private async loadRuntime(context: SessionRuntimeContext): Promise<CatalogExecutionRuntime> {
        this.owner.assertActive();
        if (this.closed)
            throw new CatalogError("HOST_CLOSING");
        this.options.assertNativeReady?.(this.registry.resolve(context.session.sessionId), context.nativeSceneAuthorization);
        const services = this.services();
        let runtime: CatalogExecutionRuntime | undefined;
        try {
            if (this.options.runtimeFactory)
                runtime = await this.options.runtimeFactory(context, services);
            else {
                const integrations = this.options.runtimeOptions?.(context, services) ?? {};
                const host = new SessionOrchestrator({ ...integrations, owner: this.owner, store: this.store, sessionId: context.session.sessionId, ownsStore: false, recoverOnStart: false, runtimeId: context.runtimeId,
                    workspace: context.workspace.canonicalRoot, checkoutRoot: context.workspace.worktreeRoot, provider: context.providerInstance.provider,
                    providerOptions: { executable: context.providerInstance.executable, environment: context.providerInstance.config.environment, ...(context.providerInstance.config.model ? { model: context.providerInstance.config.model } : {}) },
                    ...(this.views ? { hostViews: this.views } : {}), ...(this.options.privateDirectories ? { privateDirectories: this.options.privateDirectories } : {}), assertWriteReady: () => { syncAssertion(integrations.assertWriteReady?.() as unknown); },
                    assertNativeReady: (input) => { this.assertRestoreReady(); this.options.assertNativeReady?.(this.registry.resolve(context.session.sessionId), input?.authorization); syncAssertion(integrations.assertNativeReady?.(input) as unknown); } });
                runtime = host;
                this.preparing.set(context.session.sessionId, { context, runtime });
                const assessment = await host.prepareNativeRuntime();
                if (assessment && !assessment.ready)
                    throw new CatalogError("NATIVE_RUNTIME_UNAVAILABLE", "Native execution boundary is unavailable");
            }
            if (!this.runtimeMatches(runtime, context))
                throw new CatalogError("CATALOG_RUNTIME_BINDING_INVALID");
            this.sealRuntime(runtime);
            this.preparing.set(context.session.sessionId, { context, runtime });
            if (this.closed)
                throw new CatalogError("HOST_CLOSING");
            if (this.options.verifyProvider) {
                const verification = await this.options.verifyProvider(context, runtime);
                if (this.closed)
                    throw new CatalogError("HOST_CLOSING");
                this.providers.recordVerification(context.providerInstance.providerInstanceId, verification);
            }
            return runtime;
        }
        catch (error) {
            if (runtime) {
                // A foreign runtime is not ours to stop, and an owning facade could close the shared writer.
                const matches = this.runtimeMatches(runtime, context);
                if (matches) this.sealRuntime(runtime);
                const report = matches ? await runtime.closeAndWait().catch(() => undefined) : undefined;
                if (!this.runtimeCompletionsSealed && (!report?.clean || !report.producerStopped)) {
                    this.catalog.setResidency(context.session.sessionId, "blocked");
                    this.owner.retain("Catalog runtime preparation has unverified process cleanup");
                }
            }
            throw error;
        }
        finally {
            if (this.preparing.get(context.session.sessionId)?.context.runtimeId === context.runtimeId)
                this.preparing.delete(context.session.sessionId);
        }
    }
    private runtimeMatches(runtime: CatalogExecutionRuntime, context: SessionRuntimeContext): boolean {
        return runtime.sessionId === context.session.sessionId && runtime.runtimeId === context.runtimeId && runtime.store === this.store && runtime.owner === this.owner && !runtime.ownsStore && !runtime.recoverOnStart && runtime.requestFormatVersions?.includes(2) === true && typeof runtime.sealBeforeStoreClose === "function";
    }
    private assertRestoreReady(): void {
        if (this.options.restoreWriteReady) {
            this.options.restoreWriteReady(this.store.db);
            return;
        }
        if (this.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get())
            throw new CatalogError("RESTORE_EXTERNAL_STATE_UNVERIFIED");
    }
    private assertActor(subjectId: string, scope: CatalogAccessScope): void {
        if (this.closed)
            throw new CatalogError("HOST_CLOSED");
        this.assertActorFacts(subjectId, scope);
    }
    private assertActorFacts(subjectId: string, scope: CatalogAccessScope): void {
        if (!this.store.db.open)
            throw new CatalogError("HOST_CLOSED");
        this.owner.assertActive();
        const mirror = this.store.getHostIdentityMirror();
        const device = this.store.getDevice(subjectId);
        if (!mirror || !device || device.hostId !== mirror.hostId || device.revokedAt || device.expiresAt && device.expiresAt <= new Date().toISOString())
            throw new CatalogError("DEVICE_REVOKED");
        if (!device.scopes.includes(scope))
            throw new CatalogError("SCOPE_REQUIRED");
    }
    assertActorSession(subjectId: string, sessionId: string, scope: CatalogAccessScope): void {
        this.assertActor(subjectId, scope);
        const target = this.registry.resolve(sessionId);
        const result = this.options.assertSessionAccess?.(subjectId, target, scope) as unknown;
        syncAssertion(result);
    }
    /** Capture while open; only this admitted call may recheck current SQL authority during drain. */
    captureSessionAuthorization(subjectId: string, sessionId: string, scope: CatalogAccessScope): () => void {
        this.assertActorSession(subjectId, sessionId, scope);
        const db = this.store.db;
        const ownerId = this.owner.ownerId;
        const ownerGeneration = this.owner.generation;
        const identity = authorizationIdentity(this.registry.resolve(sessionId));
        return () => {
            // Logical Catalog close denies new admission, while a captured
            // continuation still checks fresh authority on the original Store.
            if (!db.open || this.store.db !== db)
                throw new CatalogError("HOST_CLOSED");
            if (this.owner.ownerId !== ownerId || this.owner.generation !== ownerGeneration)
                throw new CatalogError("HOST_OWNER_CHANGED");
            this.assertActorFacts(subjectId, scope);
            const current = this.registry.resolve(sessionId);
            if (authorizationIdentity(current) !== identity)
                throw new CatalogError("SESSION_BINDING_CHANGED");
            syncAssertion(this.options.assertSessionAccess?.(subjectId, current, scope) as unknown);
        };
    }
    private target(context: CatalogRpcContext, sessionId: string, scope: CatalogAccessScope): ResolvedSession {
        this.assertActorSession(context.subjectId, sessionId, scope);
        if (!context.assertSessionScope)
            throw new CatalogError("SESSION_SCOPE_REQUIRED", "A concrete Session resource grant is required");
        syncAssertion(context.assertSessionScope(sessionId, scope) as unknown);
        return this.registry.resolve(sessionId);
    }
    private requireCatalog(context: CatalogRpcContext): void { if (!context.capabilities?.has(SESSION_CATALOG_CAPABILITY) || !this.capabilities().length)
        throw new CatalogError("CAPABILITY_REQUIRED", "Session catalog capability is required"); }
    private commandFor(frame: RpcRequest, context: RpcContext) { if (!frame.commandId || frame.commandId.length > 128)
        throw new CatalogError("COMMAND_ID_REQUIRED"); return { authSubjectId: context.subjectId, commandId: frame.commandId }; }
    private publicForSession(value: unknown, sessionId: string): unknown { const target = this.registry.resolve(sessionId); const projected = publicValue(value, target.workspace.canonicalRoot); return target.workspace.worktreeRoot ? publicValue(projected, target.workspace.worktreeRoot) : projected; }
    private summary(session: CatalogSession): SessionSummaryV2 {
        const raw = this.store.getSession(session.sessionId);
        const blocked = raw?.recoveryState === "blocked" || this.catalog.runtimeCloseForSession(session.sessionId)?.state === "outcome_unknown" || Boolean(this.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get());
        return { ...publicSessionSummary(session), ...(blocked ? { residency: "blocked" as const } : {}) };
    }
    snapshot(sessionId: string): unknown { const snapshot = this.registry.readSnapshot(sessionId); return this.publicForSession({ ...snapshot, session: this.summary(this.catalog.requireSession(sessionId)) }, sessionId); }
    private mutation(commit: CatalogCommit, commandId: string, subjectId: string): CatalogMutationResponse {
        const receipt = this.store.getCommandReceipt(subjectId, commandId);
        if (!receipt || receipt.targetSessionId !== commit.summary.sessionId || receipt.requestFormatVersion !== 2)
            throw new CatalogError("COMMAND_RECEIPT_INVALID");
        return { session: { ...commit.summary, ...(this.summary(this.catalog.requireSession(commit.summary.sessionId)).residency === "blocked" ? { residency: "blocked" as const } : {}) }, receipt: { commandId: receipt.commandId, targetSessionId: receipt.targetSessionId, state: receipt.state } };
    }
    interactionsForSession(sessionId: string): InteractionRpcPort | undefined {
        this.registry.resolve(sessionId);
        const port = this.options.interactionsForSession?.(sessionId) ?? this.registry.loaded(sessionId)?.interactionRpcPort;
        if (!port&&!this.interactionReader)
            return undefined;
        return { rpc: (method, payload, actor) => {
                const read=method==="interaction.get"||method==="interaction.list";
                this.assertActorSession(actor.authSubjectId, sessionId, read?"session:read":"approval:write");
                if (!isRecord(payload) || payload.sessionId !== sessionId)
                    throw new CatalogError("SESSION_SCOPE_MISMATCH");
                if(!read){
                    const target=this.registry.resolveControlContext(sessionId);
                    const required=method==="question.respond"?"structuredQuestions":"interactiveApprovals";
                    const device=this.store.getDevice(actor.authSubjectId)!;
                    if(!target.providerInstance.policyCapabilities.includes(required)||!target.workspace.capabilities.includes(required)||!device.scopes.includes("approval:write"))throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
                }
                const readable=read&&this.summary(this.catalog.requireSession(sessionId)).residency!=="loaded"?this.interactionReader:undefined;
                const selected=readable??port??this.interactionReader;
                if(!selected)throw new CatalogError("INTERACTIONS_UNAVAILABLE");
                return this.publicForSession(selected.rpc(method, payload, actor), sessionId);
            } };
    }
    readViewInteractions: ViewInteractionReader = (sessionId, after) => {
        this.owner.assertActive();
        this.registry.resolve(sessionId);
        const runtime=this.registry.loaded(sessionId);
        const page = this.options.readViewInteractions?.(sessionId, after) ?? (runtime instanceof SessionOrchestrator&&this.summary(this.catalog.requireSession(sessionId)).residency==="loaded"?runtime.interactionRpcPort?.rpc("interaction.list",{sessionId,...(after?{afterInteractionId:after}:{})},{authSubjectId:"host-view-reader"}):undefined) ?? this.interactionReader?.list(sessionId, after);
        if (!page)
            throw new CatalogError("INTERACTIONS_UNAVAILABLE");
        const parsed=interactionPage.safeParse(this.publicForSession(page, sessionId));
        if(!parsed.success||parsed.data.hasMore&&!parsed.data.nextAfterInteractionId)throw new CatalogError("INTERACTION_DIRECTORY_INVALID");
        if(parsed.data.interactions.some((item)=>item.sessionId!==sessionId))throw new CatalogError("SESSION_SCOPE_MISMATCH");
        return {interactions:parsed.data.interactions,hasMore:parsed.data.hasMore,...(parsed.data.nextAfterInteractionId?{nextAfterInteractionId:parsed.data.nextAfterInteractionId}:{})};
    };
    viewResource(sessionId: string): ViewResource | undefined {
        try {
            const target = this.registry.resolve(sessionId);
            return { sessionId, workspace: target.workspace.canonicalRoot, source: { subscribe: (listener) => this.registry.subscribe(sessionId, listener) }, readSnapshot: () => this.snapshot(sessionId), ...(this.options.readViewInteractions || this.interactionReader ? { readInteractions: (after?: string) => this.readViewInteractions(sessionId, after) } : {}) };
        }
        catch (error) {
            if (error instanceof CatalogError && error.code === "SESSION_NOT_FOUND")
                return undefined;
            throw error;
        }
    }
    bootstrap(): Bootstrap {
        const target = this.registry.resolve(this.legacySessionId);
        const capabilities = target.workspace.state === "active" && target.providerInstance.state === "configured" && target.providerInstance.verification.state === "verified" ? this.providers.effectiveCapabilities(target.providerInstance.providerInstanceId, { adapter: target.providerInstance.verification.capabilities, workspace: target.workspace.capabilities, deviceScopes: ["session:read", "session:write", "approval:write"] }) : [];
        return { protocolVersion: ProtocolVersion, provider: target.session.provider, capabilities: { streamingText: capabilities.includes("streamingText"), structuredToolCalls: capabilities.includes("structuredToolCalls"), interactiveApprovals: capabilities.includes("interactiveApprovals"), resumeConversation: capabilities.includes("resumeConversation"), interrupt: capabilities.includes("interrupt"), gitDiff: capabilities.includes("gitDiff"), sandboxRequired: true } };
    }
    async dispatchCatalog(frame: RpcRequest, context: CatalogRpcContext): Promise<CatalogDispatchResult> {
        try {
            return await this.dispatch(frame, context);
        }
        catch (error) {
            if (error instanceof CatalogError)
                throw new OrchestratorError(error.code, error.message, error.retryable);
            // The activation write gate throws precise activation reason codes;
            // they must surface as typed RPC errors, never as INTERNAL_ERROR.
            if (error instanceof ActivationServiceError)
                throw new OrchestratorError(error.code, error.message, false);
            if (error instanceof ZodError)
                throw new OrchestratorError("INVALID_PARAMS", "Invalid Catalog request");
            throw error;
        }
    }
    private async dispatch(frame: RpcRequest, context: CatalogRpcContext): Promise<CatalogDispatchResult> {
        const method = frame.method;
        const handled = (payload: unknown): CatalogDispatchResult => ({ handled: true, payload });
        if (Object.hasOwn(HOST_CATALOG_METHOD_SCOPES, method))
            this.requireCatalog(context);
        switch (method) {
            case "workspace.list":
                empty(frame.payload);
                this.assertActor(context.subjectId, "session:read");
                return handled({ workspaces: this.workspaces.listPublic() });
            case "provider.list":
                empty(frame.payload);
                this.assertActor(context.subjectId, "session:read");
                return handled({ providerInstances: this.providers.listPublic() });
            case "session.list": {
                this.assertActor(context.subjectId, "session:read");
                if (!context.assertSessionScope)
                    throw new CatalogError("SESSION_SCOPE_REQUIRED");
                const input = ListSessionsV2Schema.parse(frame.payload);
                const page = this.registry.list(input);
                for (const session of page.sessions)
                    this.target(context, session.sessionId, "session:read");
                return handled({ ...page, sessions: page.sessions.map((session) => this.summary(this.catalog.requireSession(session.sessionId))) });
            }
            case "session.getSnapshot": {
                const input = SessionTargetV2Schema.parse(frame.payload);
                this.target(context, input.sessionId, "session:read");
                return handled(this.snapshot(input.sessionId));
            }
            case "session.createNew": {
                this.assertActor(context.subjectId, "session:write");
                this.assertRestoreReady();
                const input = CreateSessionV2Schema.parse(frame.payload);
                this.workspaces.requireControl(input.workspaceId);
                this.providers.require(input.providerInstanceId);
                syncAssertion(this.options.assertWorkspaceAccess?.(context.subjectId, input.workspaceId, "session:write") as unknown);
                const command = this.commandFor(frame, context);
                return handled(this.mutation(this.registry.createNew(command, input), command.commandId, context.subjectId));
            }
            case "session.rename":
            case "session.archive":
            case "session.unarchive":
            case "session.closeRuntime": {
                const input = method === "session.rename" ? RenameSessionV2Schema.parse(frame.payload) : ChangeSessionStatusV2Schema.parse(frame.payload);
                this.target(context, input.sessionId, "session:write");
                this.assertRestoreReady();
                const command = this.commandFor(frame, context);
                const result = method === "session.rename" ? this.registry.rename(command, input) : method === "session.archive" ? this.registry.archive(command, input) : method === "session.unarchive" ? this.registry.unarchive(command, input) : await this.closeRuntimeCommand(command, input);
                return handled(this.mutation(result, command.commandId, context.subjectId));
            }
            case "host.getSnapshot":
            case "session.create":
                this.target(context, this.legacySessionId, "session:read");
                return handled(this.publicForSession(this.legacy.publicSnapshot(), this.legacySessionId));
            case "session.getEvents": {
                const input = legacyEvents.parse(frame.payload);
                const sessionId = input.sessionId ?? this.legacySessionId;
                if (sessionId !== this.legacySessionId)
                    this.requireCatalog(context);
                this.target(context, sessionId, "session:read");
                if (sessionId !== this.legacySessionId)
                    SessionEventsV2RequestSchema.parse(frame.payload);
                const page = this.registry.readEvents(sessionId, input.afterSequence, input.limit, input.upTo);
                return handled({ ...page, events: page.events.map((event) => this.publicForSession(publicEvent(event, this.registry.resolve(sessionId).workspace.canonicalRoot), sessionId)) });
            }
            case "session.getDiff": {
                const input = z.object({ sessionId: z.string().optional() }).parse(frame.payload);
                const sessionId = input.sessionId ?? this.legacySessionId;
                if (sessionId !== this.legacySessionId) {
                    this.requireCatalog(context);
                    SessionDiffV2RequestSchema.parse(frame.payload);
                }
                this.target(context, sessionId, "session:read");
                return handled(this.publicForSession(publicGitDiff(await this.registry.gitDiff(sessionId), this.registry.resolve(sessionId).workspace.canonicalRoot), sessionId));
            }
            case "session.startTurn":
            case "session.interrupt":
            case "approval.respond": return handled(await this.execution(frame, context));
            case "session.openView":
            case "timeline.getPage":
            case "timeline.subscribe":
            case "timeline.unsubscribe": {
                if (!this.views || !context.capabilities?.has(TIMELINE_PROJECTION_CAPABILITY) || !context.capabilities.has(BOUNDED_CONTENT_CAPABILITY))
                    throw new CatalogError("CAPABILITY_REQUIRED");
                if (method === "timeline.unsubscribe") {
                    const input = TimelineUnsubscribeRequestSchema.parse(frame.payload);
                    if (!context.timelineUnsubscribe)
                        throw new CatalogError("CAPABILITY_REQUIRED");
                    return handled(context.timelineUnsubscribe(input.subscriptionId));
                }
                const input = method === "session.openView" ? OpenViewRequestSchema.parse(frame.payload) : method === "timeline.getPage" ? TimelinePageRequestSchema.parse(frame.payload) : TimelineSubscribeRequestSchema.parse(frame.payload);
                this.target(context, input.sessionId, "session:read");
                if (!this.views.ready(input.sessionId))
                    throw new CatalogError("TIMELINE_UNAVAILABLE");
                const result = method === "session.openView" ? context.openView?.(input as ReturnType<typeof OpenViewRequestSchema.parse>) : method === "timeline.getPage" ? context.timelinePage?.(input as ReturnType<typeof TimelinePageRequestSchema.parse>) : context.timelineSubscribe?.(input as ReturnType<typeof TimelineSubscribeRequestSchema.parse>);
                if (result === undefined)
                    throw new CatalogError("CAPABILITY_REQUIRED");
                return handled(result);
            }
            case "content.getChunk": {
                if (!this.views || !context.capabilities?.has(BOUNDED_CONTENT_CAPABILITY))
                    throw new CatalogError("CAPABILITY_REQUIRED");
                const input = ContentChunkRequestSchema.parse(frame.payload);
                this.target(context, input.sessionId, "session:read");
                if (context.viewOwner)
                    this.views.resource(input.sessionId, context.viewOwner());
                return handled(this.views.content.getChunk(input, { subjectId: context.subjectId, ...(context.frameBudget ? { budget: context.frameBudget } : {}), ...(context.responseEnvelope ? { envelope: context.responseEnvelope } : {}), ...(context.assertContentScope ? { assertScope: context.assertContentScope } : {}) }));
            }
            case "command.getReceipt": {
                this.assertActor(context.subjectId, "session:read");
                const input = z.strictObject({ commandId: z.string().min(1).max(128) }).parse(frame.payload);
                const receipt = this.store.getCommandReceipt(context.subjectId, input.commandId);
                if (!receipt || receipt.method.startsWith("access."))
                    return handled({ found: false, commandId: input.commandId });
                if (receipt.targetSessionId)
                    this.target(context, receipt.targetSessionId, "session:read");
                return handled({ found: true, commandId: receipt.commandId, method: receipt.method, state: receipt.state, response: receipt.targetSessionId ? this.publicForSession(receipt.response, receipt.targetSessionId) : receipt.response, updatedAt: receipt.updatedAt });
            }
            default: return { handled: false };
        }
    }
    private async execution(frame: RpcRequest, context: CatalogRpcContext): Promise<unknown> {
        const explicit = isRecord(frame.payload) && Object.hasOwn(frame.payload, "sessionId");
        if (explicit)
            this.requireCatalog(context);
        const input = frame.method === "session.startTurn" ? (explicit ? StartTurnV2Schema.parse(frame.payload) : legacyPrompt.parse(frame.payload)) : frame.method === "session.interrupt" ? (explicit ? InterruptTurnV2Schema.parse(frame.payload) : {}) : (explicit ? RespondApprovalV2Schema.parse(frame.payload) : legacyApproval.parse(frame.payload));
        const sessionId = "sessionId" in input && typeof input.sessionId === "string" ? input.sessionId : this.legacySessionId;
        const scope = frame.method === "approval.respond" ? "approval:write" : "session:write";
        this.target(context, sessionId, scope);
        const starting = frame.method === "session.startTurn";
        if (starting) this.assertRestoreReady();
        let resolved = this.registry.resolve(sessionId);
        const required = frame.method === "session.startTurn" ? "workspaceWrite" : frame.method === "session.interrupt" ? "interrupt" : "interactiveApprovals";
        const device = this.store.getDevice(context.subjectId)!;
        const command = this.commandFor(frame, context);
        const legacyPayload = frame.method === "session.startTurn" ? { prompt: (input as {
                prompt: string;
            }).prompt } : frame.method === "session.interrupt" ? {} : { approvalId: (input as {
                approvalId: string;
            }).approvalId, action: (input as {
                action: "allow_once" | "deny";
            }).action };
        const request: CommandRequest = { ...command, method: frame.method, requestHash: explicit ? this.registry.hashRequest(frame.method, input, sessionId) : hashCommandRequest(frame.method, legacyPayload), requestFormatVersion: explicit ? 2 : 1, targetSessionId: sessionId };
        const prior = this.store.getCommandReceipt(command.authSubjectId, command.commandId);
        if (prior) {
            try {
                assertReceiptRequest(prior, request);
            }
            catch {
                throw new CatalogError("COMMAND_ID_REUSED");
            }
            return this.executionResponse(prior.response, prior, sessionId, explicit);
        }
        const scene = starting ? this.options.nativeScenePolicy?.() : undefined;
        const authorization = scene?.authorizeStart({ actorId: command.authSubjectId, commandId: command.commandId,
          method: frame.method, prompt: (input as { prompt: string }).prompt, requestHash: request.requestHash, sessionId });
        if (starting) {
            this.options.assertNativeReady?.(resolved, authorization);
            resolved = this.registry.assertExecutionResources(sessionId, authorization);
            if (!authorization && !this.providers.effectiveCapabilities(resolved.providerInstance.providerInstanceId, { adapter: resolved.providerInstance.verification.capabilities, workspace: resolved.workspace.capabilities, deviceScopes: device.scopes }).includes(required)) throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
        }
        const snapshot = this.store.getSession(sessionId);
        if (starting && snapshot?.recoveryState === "blocked")
            throw new CatalogError("RECOVERY_BLOCKED");
        if ("expectedRevision" in input && input.expectedRevision !== undefined && snapshot?.revision !== input.expectedRevision)
            throw new CatalogError("SESSION_REVISION_CONFLICT");
        const runtime = starting ? await this.registry.ensureLoaded(sessionId, authorization) : this.registry.loaded(sessionId);
        if (!runtime) throw new CatalogError("RUNTIME_NOT_LOADED", "The original control channel is unavailable");
        this.target(context, sessionId, scope);
        let current = this.registry.resolve(sessionId);
        if (starting) { this.options.assertNativeReady?.(current, authorization); current = this.registry.assertExecutionResources(sessionId, authorization); }
        const currentDevice = this.store.getDevice(context.subjectId)!;
        if (starting && !authorization && !this.providers.effectiveCapabilities(current.providerInstance.providerInstanceId, { adapter: current.providerInstance.verification.capabilities, workspace: current.workspace.capabilities, deviceScopes: currentDevice.scopes }).includes(required))
            throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
        const result = frame.method === "session.startTurn" ? await runtime.startTurn(command.authSubjectId, command.commandId, (input as {
            prompt: string;
        }).prompt, request) : frame.method === "session.interrupt" ? await runtime.interrupt(command.authSubjectId, command.commandId, request) : await runtime.respondApproval(command.authSubjectId, command.commandId, (input as {
            approvalId: string;
        }).approvalId, (input as {
            action: "allow_once" | "deny";
        }).action, request);
        const receipt = this.store.getCommandReceipt(command.authSubjectId, command.commandId);
        if (!receipt)
            throw new CatalogError("COMMAND_RECEIPT_INVALID");
        return this.executionResponse(result, receipt, sessionId, explicit);
    }
    private executionResponse(result: unknown, receipt: CommandReceiptRow, sessionId: string, explicit: boolean): unknown {
        if (!isRecord(result) || typeof result.status !== "string" || receipt.targetSessionId !== undefined && receipt.targetSessionId !== sessionId)
            throw new CatalogError("COMMAND_RECEIPT_INVALID");
        if (result.turnId !== undefined && (typeof result.turnId !== "string" || this.store.getTurn(result.turnId)?.sessionId !== sessionId))
            throw new CatalogError("COMMAND_RECEIPT_INVALID");
        if (!explicit)
            return this.publicForSession(result, sessionId);
        if (receipt.requestFormatVersion !== 2 || receipt.targetSessionId !== sessionId)
            throw new CatalogError("COMMAND_RECEIPT_INVALID");
        const response: SessionExecutionResponseV2 = { sessionId, status: result.status, ...(typeof result.turnId === "string" ? { turnId: result.turnId } : {}), ...(typeof result.approvalId === "string" ? { approvalId: result.approvalId } : {}), receipt: { commandId: receipt.commandId, targetSessionId: sessionId, state: receipt.state } };
        return this.publicForSession(response, sessionId);
    }
    private async closeRuntimeCommand(command: {
        authSubjectId: string;
        commandId: string;
    }, input: {
        sessionId: string;
        expectedRevision: number;
    }): Promise<CatalogCommit> {
        const duration = Math.max(1, Math.min(this.options.runtimeCloseDeadlineMs ?? 5000, 60000));
        const closing = this.registry.closeRuntimeCommand(command, input, duration);
        // The accepted journal exists before any attempt to stop a still-preparing runtime.
        const operation = this.catalog.runtimeCloseForSession(input.sessionId);
        const pending = this.preparing.get(input.sessionId);
        if (operation?.state === "accepted" && operation.authSubjectId === command.authSubjectId && operation.commandId === command.commandId && pending
            && operation.runtimeId === pending.context.runtimeId && operation.ownerContext.ownerId === this.owner.ownerId && operation.ownerContext.ownerGeneration === this.owner.generation)
            void pending.runtime.closeAndWait(duration).catch(() => undefined);
        const result = await withinDeadline(closing, Date.now() + duration);
        if (this.runtimeCompletionsSealed)
            throw new CatalogError("HOST_CLOSING", undefined, true);
        if (result.ok)
            return result.value;
        if ("error" in result)
            throw result.error;
        const row = this.store.db.prepare("SELECT id FROM catalog_runtime_operations WHERE auth_subject_id=? AND command_id=?").get(command.authSubjectId, command.commandId) as {
            id: string;
        } | undefined;
        if (!row)
            throw new CatalogError("RUNTIME_CLOSE_INCOMPLETE");
        const settled = this.catalog.settleRuntimeClose(row.id, false);
        this.registry.publishCommittedEvents(settled.events);
        this.owner.retain("Runtime close exceeded its deadline without verified stop proof");
        return settled;
    }
    private sealRuntimeCompletions(): void {
        this.runtimeCompletionsSealed = true;
        this.registry.sealRuntimeCompletions();
    }
    private sealRuntime(runtime: CatalogExecutionRuntime): void {
        if (!this.storeSealed || this.sealedRuntimes.has(runtime)) return;
        this.sealedRuntimes.add(runtime);
        runtime.sealBeforeStoreClose();
    }
    /** Final Host-owned fence. Logical close still permits admitted Recovery SQL/events. */
    sealBeforeStoreClose(): void {
        this.closed = true;
        this.storeSealed = true;
        this.sealRuntimeCompletions();
        const errors: unknown[] = [];
        try { this.registry.sealBeforeStoreClose(); } catch (error) { errors.push(error); }
        for (const { runtime } of this.preparing.values())
            try { this.sealRuntime(runtime); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Catalog runtime Store fence failed");
    }
    closeAndWait(deadlineMs = 5000): Promise<RuntimeCloseReport[]> {
        if (this.closing)
            return this.closing;
        this.closed = true;
        const duration = Number.isFinite(deadlineMs) ? Math.max(0, Math.min(deadlineMs, 60000)) : 5000;
        const deadline = Date.now() + duration;
        this.closing = (async () => {
            if (this.storeSealed) return [unknownClose()];
            for (const { runtime } of this.preparing.values())
                void runtime.closeAndWait(duration).catch(() => undefined);
            const stopped = await withinDeadline(this.registry.closeAll(duration), deadline);
            this.sealRuntimeCompletions();
            if (this.storeSealed) return [unknownClose()];
            const reports = stopped.ok ? stopped.value : [unknownClose()];
            for (const session of this.catalog.allSessions())
                if (session.residency !== "unloaded" && !reports.some((report) => !report.clean))
                    reports.push(unknownClose());
            for (const service of this.options.globalServices ?? []) {
                const drained = await withinDeadline(Promise.resolve().then(() => service.drain(Math.max(0, deadline - Date.now()))), deadline);
                if (this.storeSealed) return [...reports, unknownClose()];
                try {
                    service.seal?.();
                }
                catch {
                    reports.push(unknownClose());
                }
                if (!drained.ok || drained.value === false) {
                    reports.push(unknownClose());
                    continue;
                }
                if (service.close) {
                    const closed = await withinDeadline(Promise.resolve().then(() => service.close!()), deadline);
                    if (this.storeSealed) return [...reports, unknownClose()];
                    if (!closed.ok)
                        reports.push(unknownClose());
                }
            }
            if (this.ownsViews)
                this.views?.close();
            if (reports.every((report) => report.clean && report.producerStopped)) {
                this.catalog.dispose();
                openCatalogStores.delete(this.store);
            }
            else
                this.owner.retain("Catalog shutdown has unverified Session or service work");
            return reports;
        })();
        return this.closing;
    }
}
export async function createHostCatalogBindings(options: HostCatalogOptions): Promise<HostCatalog> {
    return openHostCatalog(options, false);
}
/** Trusted owner-only SQL bootstrap, with no local Git or Provider admission. */
export async function createHostCatalogReadBindings(options: HostCatalogOptions): Promise<HostCatalog> {
    return openHostCatalog(options, true);
}
async function openHostCatalog(options: HostCatalogOptions, metadataOnly: boolean): Promise<HostCatalog> {
    assertHostOwner(options.owner);
    options.owner.assertStorePath(options.store.db.name);
    if (options.owner.recoveryOnly || options.owner.mode === "maintenance")
        throw new CatalogError("HOST_RECOVERY_ONLY");
    options.store.assertWriterOwner();
    if (!options.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get())
        throw new CatalogError("CATALOG_SCHEMA_UNAVAILABLE");
    validateCatalogSchema(options.store.db);
    // Central 007 backfills pre-existing Sessions. A raw legacy insert after
    // that migration has no trusted Workspace/Provider binding to adopt here.
    if (options.store.db.prepare("SELECT 1 FROM sessions s LEFT JOIN session_catalog c ON c.session_id=s.id WHERE c.session_id IS NULL LIMIT 1").get())
        throw new CatalogError("CATALOG_SESSION_BINDING_MISSING", "A Session has no catalog binding; reconcile it during offline maintenance");
    const configuration = LocalCatalogConfigurationSchema.parse(options.configuration);
    const hasSessions = Boolean(options.store.db.prepare("SELECT 1 FROM sessions LIMIT 1").get());
    if (openCatalogStores.has(options.store))
        throw new CatalogError("CATALOG_ALREADY_OPEN");
    openCatalogStores.add(options.store);
    const catalog = new CatalogStore(options.store, { ...(options.restoreWriteReady ? { restoreWriteReady: options.restoreWriteReady } : {}) });
    try {
        const legacyDefault = catalog.legacyDefaultSessionId();
        if (!legacyDefault && hasSessions && !configuration.legacyDefaultSessionId)
            throw new CatalogError("LEGACY_DEFAULT_REQUIRED", "Choose the existing default Session in local Host configuration");
        if (legacyDefault && configuration.legacyDefaultSessionId && legacyDefault !== configuration.legacyDefaultSessionId)
            throw new CatalogError("LEGACY_DEFAULT_CONFLICT");
        const readiness = metadataOnly ? options.activationReadiness?.(catalog) : undefined;
        const configured = metadataOnly
            ? registerCatalogReadMetadata(catalog, options.owner, configuration, { ...(options.privateDirectories ? { privateDirectories: options.privateDirectories } : {}), ...(options.readOnlyGit ? { readOnlyGit: options.readOnlyGit } : {}), ...(options.initialLegacySession ? { initialLegacySession: options.initialLegacySession } : {}), ...(options.restoreWriteReady ? { restoreWriteReady: options.restoreWriteReady } : {}), ...(readiness ? { readiness } : {}) })
            : await registerConfiguredCatalog(catalog, options.owner, configuration, { ...(options.privateDirectories ? { privateDirectories: options.privateDirectories } : {}), ...(options.readOnlyGit ? { readOnlyGit: options.readOnlyGit } : {}) });
        const initial = options.initialLegacySession;
        if (!metadataOnly && !catalog.legacyDefaultSessionId() && !hasSessions && initial)
            options.store.db.transaction(() => { const input = { ...initial, title: initial.title ?? "Untitled session" }; const created = catalog.create({ authSubjectId: "host-bootstrap", commandId: "catalog-legacy-default" }, input, { workspace: configured.workspaces.require(input.workspaceId), provider: configured.providers.require(input.providerInstanceId) }); catalog.setLegacyDefaultOnce(created.summary.sessionId); })();
        if (!catalog.legacyDefaultSessionId())
            throw new CatalogError("LEGACY_DEFAULT_REQUIRED");
        return new HostCatalog(catalog, configured.workspaces, configured.providers, options);
    }
    catch (error) {
        catalog.dispose();
        openCatalogStores.delete(options.store);
        throw error;
    }
}
function syncAssertion(result: unknown): void { if (result === false)
    throw new CatalogError("SCOPE_REQUIRED"); if (result && typeof result === "object" && "then" in result) {
    void Promise.resolve(result).catch(() => undefined);
    throw new CatalogError("SYNCHRONOUS_SESSION_SCOPE_REQUIRED");
} }
async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<{
    ok: true;
    value: T;
} | {
    ok: false;
    error?: unknown;
}> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })), new Promise<{
                ok: false;
            }>((resolve) => { timer = setTimeout(() => resolve({ ok: false }), Math.max(0, deadline - Date.now())); })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}

function authorizationIdentity(target: ResolvedSession): string {
    const { session, workspace, providerInstance } = target;
    return digest({ sessionId: session.sessionId, workspaceId: session.workspaceId, provider: session.provider,
        providerInstanceId: session.providerInstanceId, canonicalRoot: workspace.canonicalRoot, checkoutRoot: workspace.worktreeRoot,
        checkoutKey: workspace.checkoutKey, repositoryId: workspace.repositoryId, kind: workspace.kind,
        executable: providerInstance.executable, configuration: providerInstance.config, policyVersion: providerInstance.policyVersion,
        policyCapabilities: [...providerInstance.policyCapabilities].sort() });
}
