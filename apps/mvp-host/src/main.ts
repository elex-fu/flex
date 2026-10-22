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
import { RestoreExternalCheckService, runRestoreExternalCheckCli } from "./operations/restore-external-check.js";
import { SUPPORTED_SCHEMA_VERSION } from "./storage/migrations/schema-version.js";
import { writeCompatibilityReadiness } from "./diagnostics/compatibility-readiness.js";
import { parseCompatibilityCommand, runCompatibilityCommand } from "./diagnostics/compatibility-cli.js";
import { inspectCatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { CatalogStore } from "./storage/catalog-store.js";
import { SqliteStore } from "./storage/db.js";
import { HostOwnerLock, canonicalPath, type HostOwnerHandle } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal } from "./lifecycle/managed-process-registry.js";
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
    try {
      restoredStore = openForMaintenance({ databasePath: owner.databasePath, owner });
      const service = new RestoreExternalCheckService({ db: restoredStore.db, owner, backupDirectory: resolve(backupDirectory),
        identityDirectory: owner.identityDirectory!, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        withSnapshot: new OperationSnapshotLane(() => owner.assertActive()).withSnapshot,
        // An incomplete platform ledger cannot establish coverage since backup.
        // Keep the exact restore gate until an installed inspector can prove it.
        inspectExternal: async () => { throw new OperationsError("RESTORE_EXTERNAL_INSPECTOR_UNAVAILABLE"); },
      });
      console.log(JSON.stringify(await runRestoreExternalCheckCli([args[1]!, ...args.slice(3)], service), null, 2));
    } finally { restoredStore?.close(); owner.release(); }
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
    pairingConfirmation = createPairingConfirmation();
    application = await createHostApplication({ store, owner, identity, ...bootstrap, snapshotLane,
      compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath),
      compatibilityEndorsementPath: compatibilityEndorsementPathFor(owner.databasePath),
      server: { pairingConfirmation, connectivity, ...(process.env.FLYX_WEB_ROOT ? { webRoot: process.env.FLYX_WEB_ROOT } : {}) },
    });
    server = application.server;
    const address = await application.start();
    if (process.env.FLYX_COMPATIBILITY_MODE === "isolated") {
      const artifact = application.compatibilityArtifact();
      if (!artifact) throw new OperationsError("COMPATIBILITY_RUNTIME_FACTS_UNAVAILABLE");
      const entry = { path: resolve(process.env.FLYX_COMPATIBILITY_READINESS_PATH ?? ""), baseUrl: address,
        pairingToken: server.auth.pairingUrlToken, provider, identity, runId: process.env.FLYX_COMPATIBILITY_RUN_ID ?? "",
        entryPath: fileURLToPath(import.meta.url), databasePath: owner.databasePath, identityDirectory: owner.identityDirectory!,
        workspace, artifact, authMode: "unknown" as const };
      const readControlledJson = async (path: string | undefined) => {
        if (!path) throw new OperationsError("COMPATIBILITY_AUTHORIZATION_REQUIRED");
        await assertPrivateDirectory(dirname(resolve(path)));
        return JSON.parse((await readPrivateFile(resolve(path), 64 * 1024)).toString("utf8"));
      };
      await application.prepareCompatibilityScene({ authorization: await readControlledJson(process.env.FLYX_COMPATIBILITY_AUTHORIZATION_PATH),
        expectedDestination: await readControlledJson(process.env.FLYX_COMPATIBILITY_DESTINATION_HOST_PATH), entry,
        measureArtifact: () => {
          const current = application!.compatibilityArtifact();
          if (!current) throw new OperationsError("COMPATIBILITY_RUNTIME_FACTS_UNAVAILABLE"); return current;
        } });
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

/**
 * Offline execution activation (design §6.3). The maintenance owner is the only
 * live writer while the Host is stopped; the managed query executor is composed
 * exactly like the Host read path, so a platform without a proven process-birth
 * contract refuses instead of launching raw Git. Installed supervisor/adapter
 * facts arrive with their own contracts and stay absent until then, which keeps
 * verify fail-closed instead of inferring readiness.
 */
async function runActivationCommand(store: SqliteStore, owner: HostOwnerHandle, argv: readonly string[]): Promise<ActivationCliResult> {
  const privateDirectories = [dirname(owner.databasePath), owner.identityDirectory!, owner.coordinationDirectory!];
  const privateRoots = privateRootsFor({ owner }, privateDirectories);
  const mirror = store.getHostIdentityMirror();
  if (!mirror) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
  const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory!, expectedMirror: mirror });
  const observation = localActivationFacts({ compatibilityEvidencePath: compatibilityEvidencePathFor(owner.databasePath), privateRoots,
    compatibilityTrust: { destination: publicHostIdentity(identity), endorsementPath: compatibilityEndorsementPathFor(owner.databasePath) } });
  const catalog = new CatalogStore(store);
  try {
    const operations = createActivationOperationStore(
      { db: store.db, workspace: (id) => catalog.workspace(id), provider: (id) => catalog.provider(id) },
      { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
    );
    const load = new HostActivationLoad(operations, observation);
    const executorFactory: ManagedQueryExecutorFactory = async () => {
      const managed = createManagedWorkspaceQuery({
        journal: new SqliteProcessJournal(store.db), privateRoots,
        assertActive: () => { owner.assertActive(); store.assertWriterOwner(); },
        context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
          runtimeId: "activation-query", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }),
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
