import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProviderId } from "@flyx/mvp-protocol";
import QRCode from "qrcode";
import { DeviceRegistry } from "./auth/device-registry.js";
import { parseConnectivityConfig, resolveConnectivityConfig } from "./connectivity/config.js";
import { createPairingConfirmation, parseHostCommand, type HostCommand } from "./connectivity/terminal.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity, publicHostIdentity, rotateHostIdentity, type HostIdentityFileV1 } from "./identity/host-identity.js";
import type { HostServer } from "./server.js";
import { createHostApplication } from "./host-application.js";
import { readHostCatalogBootstrap } from "./catalog/local-host-configuration.js";
import { runOfflineRecovery } from "./connectivity/recovery-cli.js";
import { HOST_OPERATIONS_CLI_USAGE, runHostOperationsCommand } from "./connectivity/operations-cli.js";
import { verifyOfflineHostQuiescence } from "./connectivity/offline-quiescence.js";
import { CATALOG_IMPORT_CLI_USAGE, runCatalogImportCli } from "./catalog/catalog-import-cli.js";
import { ACTIVATION_CLI_USAGE, runActivationCli, type ActivationCliResult } from "./lifecycle/activation-cli.js";
import { HostActivationLoad, localActivationFacts } from "./lifecycle/host-activation-load.js";
import { createHostActivationService, privateRootsFor, type ManagedQueryExecutorFactory } from "./lifecycle/host-activation-service.js";
import { createManagedWorkspaceQuery } from "./lifecycle/managed-workspace-query.js";
import { OperationSnapshotLane } from "./operations/host-operations.js";
import { OperationsError, operationOwnerFromHost, readPrivateFile, assertPrivateDirectory } from "./operations/operation-files.js";
import { RestoreExternalCheckService, runRestoreExternalCheckCli, type RestoreExternalBinding, type RestoreExternalObservation } from "./operations/restore-external-check.js";
import { createRestoreExternalInspector, type RestoreCheckoutReader } from "./operations/restore-external-inspector.js";
import { SUPPORTED_SCHEMA_VERSION } from "./storage/migrations/schema-version.js";
import { writeCompatibilityReadiness } from "./diagnostics/compatibility-readiness.js";
import { createIsolatedCompatibilityRun } from "./diagnostics/compatibility-run.js";
import type { CompatibilityHostIdentity } from "./diagnostics/compatibility-integrity.js";
import { parseCompatibilityCommand, runCompatibilityCommand } from "./diagnostics/compatibility-cli.js";
import { inspectCatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { CatalogStore } from "./storage/catalog-store.js";
import { SqliteStore } from "./storage/db.js";
import { HostOwnerLock, canonicalPath, type HostOwnerHandle } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal, MANAGED_PROCESS_SCHEMA } from "./lifecycle/managed-process-registry.js";
import { managedLaunchOrderLogFor } from "./lifecycle/managed-launch-order-log.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "./storage/migrations/005-process-evidence.js";
import { createNativeHistoryManifestSource } from "./provider/native-history-manifest.js";
import Database from "better-sqlite3";
import { createMacosManagedExecution, macosManagedGitOptions, macosManagedExecutionFacts } from "./lifecycle/macos-managed-execution.js";
import { ManagedGitRunner } from "./lifecycle/managed-git-runner.js";
import { homedir } from "node:os";
import { openForMaintenance, openForManagement, openOwned, openReadOnly } from "./storage/open-store.js";

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Host startup failed");
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const compatibilityCommand = parseCompatibilityCommand(args);
  if (compatibilityCommand) {
    const databasePath = resolve(process.env.FLYX_DB ?? ".flyx/mvp.sqlite");
    const identityDirectory = resolve(process.env.FLYX_IDENTITY_DIR ?? join(dirname(databasePath), "identity"));
    await stat(databasePath);
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" });
    let compatibilityStore: SqliteStore | undefined;
    try {
      compatibilityStore = openForMaintenance({ databasePath: owner.databasePath, owner });
      const mirror = compatibilityStore.getHostIdentityMirror();
      if (!mirror) throw new OperationsError("COMPATIBILITY_MAINTENANCE_REQUIRED");
      const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory!, expectedMirror: mirror });
      console.log(JSON.stringify(await runCompatibilityCommand(compatibilityCommand, { owner: operationOwnerFromHost(owner), identity, store: compatibilityStore }), null, 2));
    } finally { compatibilityStore?.close(); owner.release(); }
    return;
  }
  const restoreCheck = args[0] === "restore" && (args[1] === "inspect-state" || args[1] === "confirm-state");
  if (restoreCheck) {
    const backupDirectory = args[2];
    if (!backupDirectory) throw new OperationsError("OPERATIONS_INVALID_COMMAND");
    const databasePath = resolve(process.env.FLYX_DB ?? ".flyx/mvp.sqlite");
    const identityDirectory = resolve(process.env.FLYX_IDENTITY_DIR ?? join(dirname(databasePath), "identity"));
    await stat(databasePath);
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" });
    let restoredStore: SqliteStore | undefined;
    let inspection: Awaited<ReturnType<typeof openRestoreExternalInspection>> | undefined;
    try {
      restoredStore = openForMaintenance({ databasePath: owner.databasePath, owner });
      inspection = await openRestoreExternalInspection(restoredStore, owner);
      const service = new RestoreExternalCheckService({ db: restoredStore.db, owner, backupDirectory: resolve(backupDirectory),
        identityDirectory: owner.identityDirectory!, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        withSnapshot: new OperationSnapshotLane(() => owner.assertActive()).withSnapshot,
        inspectExternal: inspection.inspectExternal,
      });
      console.log(JSON.stringify(await runRestoreExternalCheckCli([args[1]!, ...args.slice(3)], service), null, 2));
    } finally { inspection?.dispose(); restoredStore?.close(); owner.release(); }
    return;
  }
  const command = parseHostCommand(args);
  if (command.kind === "help") {
    console.log("Flyx Host: start | devices list | devices revoke <deviceId> | devices revoke-all | identity show | identity rotate");
    console.log(`Operations: ${HOST_OPERATIONS_CLI_USAGE}`);
    console.log(`Catalog: ${CATALOG_IMPORT_CLI_USAGE}`);
    console.log(`Activation: ${ACTIVATION_CLI_USAGE}`);
    console.log("Restore external check: restore inspect-state <backupDirectory> <commandId> | restore confirm-state <backupDirectory> <operationId> <evidenceId> <revision>");
    console.log("Recovery: recovery inspect <sessionId> <turnId> [--attempt <attemptId>] [--upgrade-metadata]");
    console.log("Recovery write: recovery reconcile|acknowledge <sessionId> <turnId> <evidenceId> <recoveryRevision> <commandId> [--attempt <attemptId>] [--acknowledge-unknown]");
    console.log("Select the existing Host using FLYX_DB and FLYX_IDENTITY_DIR. Key rotation requires confirmation in a local terminal.");
    console.log("Catalog startup: FLYX_CATALOG_CONFIG selects a local configuration; FLYX_LEGACY_DEFAULT_SESSION_ID selects an existing default when none was migrated.");
    return;
  }
  const defaultDatabase = process.env.FLYX_PROVIDER === "codex" ? ".flyx/mvp-codex.sqlite" : ".flyx/mvp.sqlite";
  const databasePath = resolve(process.env.FLYX_DB ?? resolve(process.cwd(), defaultDatabase));
  const identityDirectory = resolve(process.env.FLYX_IDENTITY_DIR ?? join(dirname(databasePath), "identity"));
  if (command.kind === "operations") {
    if (command.action === "doctor" || command.action === "validate") {
      console.log(JSON.stringify(await runHostOperationsCommand(command, { databasePath }), null, 2));
      return;
    }
    await stat(databasePath);
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" });
    let offlineStore: SqliteStore | undefined;
    const withSnapshot = new OperationSnapshotLane(() => owner.assertActive()).withSnapshot;
    try {
      const config = parseConnectivityConfig();
      const relay = config.relayEnabled && config.relayUrl ? {
        registrationPath: join(owner.identityDirectory!, "relay-registration.json"), relayUrl: config.relayUrl,
      } : undefined;
      if (command.action === "backup") {
        offlineStore = openForMaintenance({ databasePath: owner.databasePath, owner });
        console.log(JSON.stringify(await runHostOperationsCommand(command, { databasePath: owner.databasePath,
          backup: { store: offlineStore, owner, identityDirectory: owner.identityDirectory!, applicationVersion: "0.0.1", withSnapshot, ...(relay ? { relay } : {}) },
        }), null, 2));
      } else {
        let inspecting = false;
        console.log(JSON.stringify(await runHostOperationsCommand(command, { databasePath: owner.databasePath,
          restore: { owner, databasePath: owner.databasePath, identityDirectory: owner.identityDirectory!, applicationVersion: "0.0.1", withSnapshot, ...(relay ? { relay } : {}),
            verification: {
              verifyProducersStopped: (scope) => {
                owner.assertActive(); owner.assertStorePath(scope.databasePath); inspecting = true;
                try { return verifyOfflineHostQuiescence(scope.databasePath); }
                finally { inspecting = false; }
              },
              verifyDatabaseClosed: (scope) => {
                owner.assertActive(); owner.assertStorePath(scope.databasePath);
                return !inspecting && offlineStore?.db.open !== true;
              },
            },
          },
        }), null, 2));
      }
    } finally { offlineStore?.close(); owner.release(); }
    return;
  }
  if (command.kind === "catalog-import") {
    await stat(databasePath);
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" });
    let offlineStore: SqliteStore | undefined;
    try {
      offlineStore = openForMaintenance({ databasePath: owner.databasePath, owner });
      console.log(JSON.stringify(await runCatalogImportCli({ store: offlineStore, owner, backupDirectory: command.backupDirectory }, command.request), null, 2));
    } finally { offlineStore?.close(); owner.release(); }
    return;
  }
  if (command.kind === "activation") {
    await stat(databasePath);
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" });
    let offlineStore: SqliteStore | undefined;
    try {
      offlineStore = openForMaintenance({ databasePath: owner.databasePath, owner });
      console.log(JSON.stringify(await runActivationCommand(offlineStore, owner, command.argv), null, 2));
    } finally { offlineStore?.close(); owner.release(); }
    return;
  }
  if (command.kind === "recovery") {
    console.log(JSON.stringify(await runOfflineRecovery(command, { databasePath, identityDirectory }), null, 2));
    return;
  }
  if (command.kind !== "start") {
    // Read-only commands never migrate, initialize identity or recover leases.
    // Revocation is the sole live local write, through an existing schema and
    // bounded synchronous transaction. Identity rotation requires offline owner.
    const owner = command.kind === "identity-rotate"
      ? HostOwnerLock.acquire({ databasePath, identityDirectory, mode: "maintenance" }) : undefined;
    let store: SqliteStore | undefined;
    try {
      if (owner) {
        await stat(owner.databasePath); // Rotation cannot silently create a Host.
        store = openForMaintenance({ databasePath: owner.databasePath, owner });
      } else {
        store = command.kind === "devices-revoke" || command.kind === "devices-revoke-all"
          ? openForManagement(databasePath) : openReadOnly(databasePath);
      }
      const mirror = store.getHostIdentityMirror();
      if (!mirror) throw new Error("Host has no persisted identity; initialize it through owned Host startup.");
      const directory = owner?.identityDirectory ?? canonicalPath(identityDirectory);
      const identity = await loadOrCreateHostIdentity({ directory, expectedMirror: mirror });
      await manageHost(command, store, identity, directory);
    } finally {
      store?.close();
      owner?.release();
    }
    return;
  }

  const workspace = resolve(process.env.FLYX_WORKSPACE ?? resolve(process.cwd(), "packages/claude-fixtures"));
  const provider = parseProvider(process.env.FLYX_PROVIDER);

  // Acquisition precedes schema, identity, recovery and provider preflight.
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
  const snapshotLane = new OperationSnapshotLane(() => owner.assertActive()).withSnapshot;
  let store: SqliteStore | undefined;
  let application: Awaited<ReturnType<typeof createHostApplication>> | undefined;
  let pairingConfirmation: ReturnType<typeof createPairingConfirmation> | undefined;
  let server: HostServer | undefined;
  try {
    await mkdir(dirname(owner.databasePath), { recursive: true, mode: 0o700 });
    store = openOwned({ databasePath: owner.databasePath, owner });
    const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory!, expectedMirror: store.getHostIdentityMirror() ?? null });
    store.setHostIdentityMirror(getHostIdentityMirror(identity));
    const connectivity = await resolveConnectivityConfig(parseConnectivityConfig());
    const bootstrap = readHostCatalogBootstrap({ store, workspace, provider, environment: process.env });
    const isolatedCompatibility = process.env.FLYX_COMPATIBILITY_MODE === "isolated"
      ? createIsolatedCompatibilityRun({ owner, store, identity, workspace, provider,
        entryPath: fileURLToPath(import.meta.url), compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath),
        authorization: await readControlledCompatibilityJson(process.env.FLYX_COMPATIBILITY_AUTHORIZATION_PATH),
        expectedDestination: parseCompatibilityHostIdentity(await readControlledCompatibilityJson(process.env.FLYX_COMPATIBILITY_DESTINATION_HOST_PATH)),
        candidateVersion: requireCandidateVersion() })
      : undefined;
    const execution = await createMacosManagedExecution({ identity, compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath),
      compatibilityEndorsementPath: compatibilityEndorsementPathFor(owner.databasePath),
      worktreesRoot: resolve(process.env.FLYX_WORKTREES_ROOT ?? join(homedir(), ".flyx-worktrees")),
      ...(isolatedCompatibility ? { compatibility: isolatedCompatibility } : {}) });
    pairingConfirmation = createPairingConfirmation();
    application = await createHostApplication({ store, owner, identity, ...bootstrap, snapshotLane, ...(execution ? { execution } : {}),
      compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath),
      compatibilityEndorsementPath: compatibilityEndorsementPathFor(owner.databasePath),
      server: { pairingConfirmation, connectivity, ...(process.env.FLYX_WEB_ROOT ? { webRoot: process.env.FLYX_WEB_ROOT } : {}) },
    });
    server = application.server;
    const address = await application.start();
    if (isolatedCompatibility) {
      // Real-entry composition (design §6.3 / plan M4): the managed --version
      // probe runs first under explicit probe authority; only its measured
      // artifact may enter the readiness handshake and the scene policy, and
      // only an attached scene constructs the committed-stop recorder.
      // The explicit local configuration step belongs to this entry, never to
      // the SQL/history bootstrap: it resolves the configured executable to
      // its realpath and moves the provider instance to "configured", which
      // both the scene policy's executable binding and the execution
      // admission (PROVIDER_INSTANCE_UNAVAILABLE otherwise) require. Sessions
      // are idle and unloaded at this point, so revalidation is safe.
      await application.catalog.revalidateConfiguration(bootstrap.configuration);
      const artifact = await isolatedCompatibility.start(application, {
        path: resolve(process.env.FLYX_COMPATIBILITY_READINESS_PATH ?? ""), baseUrl: address,
        pairingToken: server.auth.pairingUrlToken, provider, identity, runId: process.env.FLYX_COMPATIBILITY_RUN_ID ?? "",
        entryPath: fileURLToPath(import.meta.url), databasePath: owner.databasePath, identityDirectory: owner.identityDirectory!,
        workspace, authMode: isolatedCompatibility.authMode() });
      const entry = { path: resolve(process.env.FLYX_COMPATIBILITY_READINESS_PATH ?? ""), baseUrl: address,
        pairingToken: server.auth.pairingUrlToken, provider, identity, runId: process.env.FLYX_COMPATIBILITY_RUN_ID ?? "",
        entryPath: fileURLToPath(import.meta.url), databasePath: owner.databasePath, identityDirectory: owner.identityDirectory!,
        workspace, artifact, authMode: isolatedCompatibility.authMode(), sceneVersion: isolatedCompatibility.sceneVersion() };
      const scenePolicy = await application.prepareCompatibilityScene({
        authorization: await readControlledCompatibilityJson(process.env.FLYX_COMPATIBILITY_AUTHORIZATION_PATH),
        expectedDestination: parseCompatibilityHostIdentity(await readControlledCompatibilityJson(process.env.FLYX_COMPATIBILITY_DESTINATION_HOST_PATH)), entry,
        measureArtifact: () => {
          const current = application!.compatibilityArtifact();
          if (!current) throw new OperationsError("COMPATIBILITY_RUNTIME_FACTS_UNAVAILABLE"); return current;
        } });
      isolatedCompatibility.attachScene(scenePolicy);
      await writeCompatibilityReadiness(entry);
    }
    const legacy = application.catalog.registry.resolve(application.catalog.legacySessionId);
    console.log(`Flyx MVP Host listening at ${address}`);
    console.log(`Workspace: ${legacy.workspace.canonicalRoot}`);
    console.log(`Provider: ${providerName(legacy.session.provider)}`);
    console.log("Readiness: history and recovery available; execution requires separately verified workspace, Provider and process contracts.");
    console.log(`Host: ${identity.hostId} (${identity.fingerprint})`);
    console.log(`Connectivity: ${connectivity.mode}${connectivity.publicBaseUrl ? ` — ${connectivity.publicBaseUrl}` : ""}`);
    let shutdownPromise: Promise<void> | undefined;
    const runningServer = server;
    const confirmation = pairingConfirmation;
    const shutdown = () => shutdownPromise ??= (async () => {
      confirmation.close();
      try { await runningServer.stop(); }
      catch (error) {
        process.exitCode = 1;
        console.error(error instanceof Error ? error.message : "Host shutdown failed");
      }
    })();
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    if (process.stdout.isTTY) {
      if (connectivity.publicBaseUrl || connectivity.allowInsecureHttp) {
        await printPairingUrl("Direct pairing", server.getPairingUrl());
      } else {
        console.log("For phone pairing, configure Tailscale Serve and restart with FLYX_CONNECTIVITY_MODE=tailscale.");
      }
      const relayPairingUrl = server.getRelayPairingUrl(connectivity.hostedAppUrl);
      if (relayPairingUrl) await printPairingUrl("Relay pairing", relayPairingUrl);
    } else {
      console.log("Pairing links are shown only in a local terminal. Interactive pairing confirmation is required by default.");
    }
  } catch (error) {
    pairingConfirmation?.close();
    try {
      if (application) await application.stop();
      else { if (store?.db.open) store.close(); owner.release(); }
    } catch (cleanupError) {
      console.error(`Host startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "recovery required"}`);
    }
    throw error;
  }
}

async function manageHost(command: HostCommand, store: SqliteStore, identity: HostIdentityFileV1, directory: string): Promise<void> {
  const devices = new DeviceRegistry(store, identity.hostId, { recoverLeases: false });
  try {
    if (command.kind === "devices-list") {
      console.log(JSON.stringify(devices.listDevices(), null, 2));
    } else if (command.kind === "devices-revoke") {
      const revoked = devices.credentialTransaction(() => devices.revokeFromLocal(command.deviceId));
      if (!revoked) throw new Error("Device does not exist or is already revoked on this Host");
      console.log(`Revoked device ${command.deviceId}; its active connections will close.`);
    } else if (command.kind === "devices-revoke-all") {
      const count = devices.credentialTransaction(() => devices.revokeAllFromLocal());
      console.log(`Revoked ${count} devices and invalidated active pairing grants.`);
    } else if (command.kind === "identity-show") {
      console.log(JSON.stringify(publicHostIdentity(identity), null, 2));
    } else if (command.kind === "identity-rotate") {
      const confirm = createPairingConfirmation({ requireConfirmation: true,
        prompt: "Rotate this Host's keys and revoke all devices? Type rotate to confirm: ", accept: (answer) => answer.trim() === "rotate" });
      let approved: boolean;
      try { approved = await confirm(); } finally { confirm.close(); }
      if (!approved) throw new Error("Key rotation was not confirmed in a local terminal");
      const rotated = await rotateHostIdentity({ directory, expectedMirror: getHostIdentityMirror(identity), authorization: { kind: "local" },
        beforeCommit: (next, previous) => devices.credentialTransaction(() => {
          devices.revokeAllFromLocal();
          store.rotateHostIdentityMirror(next, previous);
        }),
      });
      console.log(`Host key rotated: ${rotated.fingerprint}. Restart the Host and pair each device again.`);
    }
  } finally {
    devices.dispose();
  }
}

/** Host-private compatibility evidence log shared by the Host graph and the activation CLI (design §6.3). */
function compatibilityEvidencePathFor(databasePath: string): string {
  return resolve(process.env.FLYX_COMPATIBILITY_EVIDENCE_PATH ?? join(dirname(databasePath), "compatibility-evidence.jsonl"));
}
function compatibilityEndorsementPathFor(databasePath: string): string {
  return resolve(process.env.FLYX_COMPATIBILITY_ENDORSEMENT_PATH ?? join(dirname(databasePath), "compatibility-endorsement.json"));
}
/** Private controlled JSON (destination authorization / destination host), never an environment-supplied value. */
async function readControlledCompatibilityJson(path: string | undefined): Promise<unknown> {
  if (!path) throw new OperationsError("COMPATIBILITY_AUTHORIZATION_REQUIRED");
  await assertPrivateDirectory(dirname(resolve(path)));
  return JSON.parse((await readPrivateFile(resolve(path), 64 * 1024)).toString("utf8"));
}
/** Independently pinned local destination identity; never taken from the ticket itself. */
function parseCompatibilityHostIdentity(value: unknown): CompatibilityHostIdentity {
  if (typeof value !== "object" || value === null) throw new OperationsError("COMPATIBILITY_DESTINATION_INVALID");
  const record = value as Record<string, unknown>;
  for (const key of ["hostId", "hostPublicKey", "signingPublicKey", "fingerprint"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) throw new OperationsError("COMPATIBILITY_DESTINATION_INVALID");
  }
  return { hostId: record.hostId as string, hostPublicKey: record.hostPublicKey as string, signingPublicKey: record.signingPublicKey as string, fingerprint: record.fingerprint as string };
}
function requireCandidateVersion(): string {
  const value = process.env.FLYX_COMPATIBILITY_CANDIDATE_VERSION ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value)) throw new OperationsError("COMPATIBILITY_CANDIDATE_VERSION_REQUIRED");
  return value;
}

/**
 * Offline execution activation (design §6.3). The maintenance owner is the only
 * live writer while the Host is stopped; the managed query executor is composed
 * exactly like the Host read path, using the ordinary macOS contract or refusing
 * when no trusted backend is available. Installed supervisor/adapter
 * facts arrive with their own contracts and stay absent until then, which keeps
 * verify fail-closed instead of inferring readiness.
 */
async function runActivationCommand(store: SqliteStore, owner: HostOwnerHandle, argv: readonly string[]): Promise<ActivationCliResult> {
  const privateDirectories = [dirname(owner.databasePath), owner.identityDirectory!, owner.coordinationDirectory!];
  const privateRoots = privateRootsFor({ owner }, privateDirectories);
  const mirror = store.getHostIdentityMirror();
  if (!mirror) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
  const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory!, expectedMirror: mirror });
  const ordinaryFacts = process.platform === "darwin" ? macosManagedExecutionFacts({ compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath),
    trust: { destination: publicHostIdentity(identity), endorsementPath: compatibilityEndorsementPathFor(owner.databasePath) } }) : {};
  const observation = localActivationFacts({ compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath), privateRoots, ...ordinaryFacts,
    compatibilityTrust: { destination: publicHostIdentity(identity), endorsementPath: compatibilityEndorsementPathFor(owner.databasePath) } });
  const catalog = new CatalogStore(store);
  // The order ledger is anchored before any activation producer can launch.
  const orderLog = managedLaunchOrderLogFor(owner.databasePath);
  orderLog?.ensureOpen();
  try {
    const operations = createActivationOperationStore(
      { db: store.db, workspace: (id) => catalog.workspace(id), provider: (id) => catalog.provider(id) },
      { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
    );
    const load = new HostActivationLoad(operations, observation);
    const executorFactory: ManagedQueryExecutorFactory = async () => {
      const runner = process.platform === "darwin" ? new ManagedGitRunner({ ...macosManagedGitOptions(), journal: new SqliteProcessJournal(store.db, orderLog),
        roots: () => catalog.workspaces().flatMap((workspace) => [workspace.canonicalRoot, workspace.worktreeRoot]), privateRoots,
        context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
          runtimeId: "activation-query", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }) }) : undefined;
      const managed = createManagedWorkspaceQuery({
        journal: new SqliteProcessJournal(store.db, orderLog), privateRoots,
        assertActive: () => { owner.assertActive(); store.assertWriterOwner(); },
        context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
          runtimeId: "activation-query", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }),
        ...(runner ? { executor: runner.workspaceQueryPort() } : {}),
      });
      return { readOnlyGit: managed.readOnlyGit, prepare: () => managed.prepare(),
        closeAndWait: async (deadlineMs) => { const report = await managed.drain(deadlineMs); return { producerStopped: report.producerStopped, clean: report.clean }; } };
    };
    const service = createHostActivationService({
      facts: { db: store.db, owner, catalog, readiness: () => inspectCatalogStartupReadiness({ store, catalog, owner }) },
      operations, load, observation, actorId: "local-maintenance", executorFactory,
    });
    try { return await runActivationCli(argv, service); }
    finally { await service.close(); }
  } finally {
    catalog.dispose();
  }
}

/**
 * Production restore-check inspection (design §8.3). Inspection git launches
 * journal into a scratch in-memory database so the restored database's binding
 * facts stay byte-stable; only the host-private order ledger, which the
 * restore swap never touches, grows — under a dedicated inspection runtime
 * identity the supervisor view filters out. Checkouts re-verify through the
 * same managed macOS git contract as the Host; provider histories re-verify
 * through the trusted compatibility manifest.
 */
async function openRestoreExternalInspection(store: SqliteStore, owner: HostOwnerHandle): Promise<{ inspectExternal(binding: RestoreExternalBinding): Promise<RestoreExternalObservation>; dispose(): void }> {
  const mirror = store.getHostIdentityMirror();
  if (!mirror) throw new OperationsError("COMPATIBILITY_MAINTENANCE_REQUIRED");
  const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory!, expectedMirror: mirror });
  const orderLog = managedLaunchOrderLogFor(owner.databasePath);
  if (!orderLog) throw new OperationsError("RESTORE_EXTERNAL_INSPECTOR_UNAVAILABLE");
  const scratch = new Database(":memory:");
  // The scratch journal carries the same facts-table shape so inspection launches
  // commit the same way they do on the live database — never into the restored one.
  scratch.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA);
  const journal = new SqliteProcessJournal(scratch, orderLog);
  const catalog = new CatalogStore(store);
  const inspectionRuntimeId = "restore-check-git";
  const trust = { destination: publicHostIdentity(identity), endorsementPath: compatibilityEndorsementPathFor(owner.databasePath) };
  const privateRoots = privateRootsFor({ owner }, [dirname(owner.databasePath), owner.identityDirectory!, owner.coordinationDirectory!]);
  const ordinaryFacts: Partial<ReturnType<typeof macosManagedExecutionFacts>> = process.platform === "darwin" ? macosManagedExecutionFacts({ compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath), trust }) : {};
  const manifests = createNativeHistoryManifestSource({
    compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath), compatibilityTrust: trust,
    ...(ordinaryFacts.supervision ? { supervision: ordinaryFacts.supervision } : {}),
    ...(ordinaryFacts.runtime ? { runtime: ordinaryFacts.runtime } : {}),
    resolveProvider: (providerInstanceId) => catalog.provider(providerInstanceId),
  });
  try {
    const inspectExternal = createRestoreExternalInspector({
      orderLog, inspectionRuntimeId, closeDeadlineMs: 10_000,
      openCheckoutReader: (roots) => process.platform === "darwin"
        ? new ManagedGitRunner({ ...macosManagedGitOptions(), journal, roots: () => [...roots], privateRoots,
          context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
            runtimeId: inspectionRuntimeId, runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }) })
        : unavailableCheckoutReader(),
      manifestForInstance: (provider, providerInstanceId) => {
        if (provider !== "claude" && provider !== "codex") return undefined;
        return manifests.verifiedManifestForInstance(provider, providerInstanceId);
      },
    });
    return { inspectExternal, dispose: () => { catalog.dispose(); scratch.close(); } };
  } catch (error) {
    catalog.dispose(); scratch.close(); throw error;
  }
}

/** Non-darwin hosts cannot host the managed macOS checkout contract: every read fails closed. */
function unavailableCheckoutReader(): RestoreCheckoutReader {
  return {
    run: async () => { throw new OperationsError("MANAGED_MACOS_PLATFORM_REQUIRED"); },
    closeAndWait: async () => ({ closed: true as const, producerStopped: false, clean: false, runs: 0 }),
  };
}

async function printPairingUrl(label: string, url: string): Promise<void> {
  console.log(`${label} URL (single use, expires in 5 minutes): ${url}`);
  // QR generation stays on this machine; the fragment contains the one-use
  // grant and public identity only, and is never sent to a QR service.
  console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
}

function parseProvider(value: string | undefined): ProviderId {
  if (value === undefined || value === "" || value === "claude") return "claude";
  if (value === "codex") return "codex";
  throw new Error(`FLYX_PROVIDER must be \"claude\" or \"codex\", received: ${value}`);
}

function providerName(value: ProviderId): string {
  return value === "codex" ? "Codex" : "Claude";
}
