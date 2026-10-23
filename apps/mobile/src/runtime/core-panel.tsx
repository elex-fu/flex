import { useEffect, useMemo, useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { CoreControls, checkpointReferences } from "@flyx/client-core";
import type { ClientState, FlyxClient, SessionReplicaState } from "@flyx/client-core";
import type { CheckpointFileContent } from "@flyx/mvp-protocol";

function fileText(value: CheckpointFileContent): string {
  if (value.kind === "text") return value.text;
  if (value.kind === "absent") return "File absent";
  if (value.kind === "unsupported") return value.reason;
  return `${value.binary ? "Binary" : "Large file"} · ${value.contentRef.bytes} bytes`;
}
/** Observes the existing native runtime; mounting and backgrounding do not create or stop a Provider. */
export function NativeCorePanel({ client, connection, replica, scopes }: { client: FlyxClient; connection: ClientState; replica?: SessionReplicaState | undefined; scopes: string[] }) {
  const controls = useMemo(() => new CoreControls(client), [client]);
  const [observed, setObserved] = useState(() => ({ controls, state: controls.getState() }));
  const selection = observed.state.selection;
  const state = observed.controls === controls && selection?.hostId === connection.profile?.hostId && selection?.sessionId === replica?.sessionId && selection?.transportGeneration === connection.transportGeneration && selection?.replicaGeneration === (replica?.replicaGeneration ?? 0) ? observed.state : { sessions: [], includeArchived: false, workspaces: [], providers: [], worktrees: [], flows: [] } as ReturnType<CoreControls["getState"]>;
  const [workspaceId, setWorkspaceId] = useState(""), [providerId, setProviderId] = useState(""), [title, setTitle] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const online = connection.connection === "online", busy = Boolean(state.busy), writable = online && connection.sync === "synced" && !busy && scopes.includes("session:write");
  const references = checkpointReferences(replica?.items ?? [], replica?.sessionId ?? "");
  const turns = references.filter((checkpoint) => checkpoint.phase === "after" && checkpoint.turnId && checkpoint.attemptId);
  const recovery = state.recovery;
  useEffect(() => controls.observe((state) => setObserved({ controls, state })), [controls]);
  useEffect(() => {
    const hostId = connection.profile?.hostId;
    controls.select(hostId ? { hostId, sessionId: replica?.sessionId, transportGeneration: connection.transportGeneration, replicaGeneration: replica?.replicaGeneration ?? 0 } : undefined);
    setSelectionError("");
    if (hostId && online && connection.sync === "synced" && controls.supports("sessions")) void controls.refresh();
  }, [controls, connection.profile?.hostId, connection.transportGeneration, connection.sync, online, replica?.sessionId, replica?.replicaGeneration]);
  useEffect(() => { if (replica?.sync === "synced" && !replica.stale && replica.interactionsAuthoritative) controls.acceptSnapshot(replica.snapshot); }, [controls, replica]);
  useEffect(() => {
    setWorkspaceId((value) => state.workspaces.some((workspace) => workspace.workspaceId === value) ? value : state.workspaces[0]?.workspaceId ?? "");
    setProviderId((value) => state.providers.some((provider) => provider.providerInstanceId === value) ? value : state.providers[0]?.providerInstanceId ?? "");
  }, [state.workspaces, state.providers]);
  useEffect(() => setAcknowledged(false), [recovery?.evidenceId]);
  const chooseSession = async (id: string) => { const generation = connection.transportGeneration; try { await client.selectSession(id); } catch (cause) { if (client.getState().transportGeneration === generation) setSelectionError(cause instanceof Error ? cause.message : "Session selection failed"); } };
  const create = async () => { const created = await controls.createSession(workspaceId, providerId, title.trim() || "Mobile session"); if (created) await chooseSession(created.sessionId); };
  return <View style={styles.group}>
    <View style={styles.card}><Text style={styles.title}>Sessions and registered workspaces</Text>
      {!controls.supports("sessions") ? <Text>This Host does not support the Session catalog. Upgrade the Host to create and select sessions.</Text> : <>
        <Button title="Refresh sessions and resources" disabled={!online || busy} onPress={() => void controls.refresh()} />
        {state.sessions.map((session) => <Button key={session.sessionId} title={`${session.sessionId === replica?.sessionId ? "✓ " : ""}${session.title || "Untitled session"} · ${session.provider} · ${session.activityState}`} disabled={!online || busy} onPress={() => void chooseSession(session.sessionId)} />)}
        {state.nextSessionId && <Button title="More sessions" disabled={!online || busy} onPress={() => void controls.refresh(false, true)} />}
        <Text>Choose an existing workspace</Text>{state.workspaces.map((workspace) => <Button key={workspace.workspaceId} title={`${workspaceId === workspace.workspaceId ? "✓ " : ""}${workspace.label} · ${workspace.kind} · ${workspace.state}`} disabled={busy} onPress={() => setWorkspaceId(workspace.workspaceId)} />)}
        <Text>Provider for a new session</Text>{state.providers.map((provider) => <Button key={provider.providerInstanceId} title={`${providerId === provider.providerInstanceId ? "✓ " : ""}${provider.provider} · ${provider.verification.state}`} disabled={busy} onPress={() => setProviderId(provider.providerInstanceId)} />)}
        <TextInput style={styles.input} value={title} maxLength={256} onChangeText={setTitle} placeholder="New session name" />
        <Text>Creating a session records its workspace and Provider binding. Send a task to start execution.</Text>
        <Button title="Check execution readiness" disabled={!online || busy || !workspaceId || !providerId} onPress={() => void controls.readiness(workspaceId, providerId)} />
        {state.readiness?.workspaceId === workspaceId && state.readiness.providerInstanceId === providerId && <Text>{state.readiness.hostState} · {state.readiness.reasonCodes.join(", ") || state.readiness.capabilities.join(", ") || "No verified execution capability"}</Text>}
        <Button title="Create and select session" disabled={!writable || !workspaceId || !providerId} onPress={() => void create()} />
      </>}
    </View>
    {replica?.sessionId && <View style={styles.card}><Text style={styles.title}>Recovery</Text><Text>{online && connection.sync === "synced" ? "Authoritative session" : "Last verified session (offline or syncing)"}: {state.snapshot?.session.activityState ?? "Refresh required"}</Text>
      <Button title="Interrupt active Turn" disabled={!writable || !state.snapshot?.activeTurn || state.snapshot.session.activityState === "outcome_unknown"} onPress={() => void controls.interrupt()} />
      {controls.supports("recovery") ? <>
        <Button title="Inspect original execution" disabled={!online || busy || !state.snapshot?.activeTurn} onPress={() => void controls.inspectRecovery()} />
        {recovery && <><Text>Process {recovery.processState}{recovery.processStopScope === "managed_process_group" ? " (managed group)" : ""} · workspace {recovery.workspaceState} · Provider {recovery.nativeState}{recovery.nativeOutcome ? ` · ${recovery.nativeOutcome}` : ""}</Text><Text>Evidence expires {new Date(recovery.expiresAt).toLocaleString()}</Text>
          {recovery.nextSteps.includes("local_inspection") && <Text>Inspect the original processes and workspace on the Host. Remote evidence cannot yet release recovery.</Text>}
          {recovery.nextSteps.includes("inspect") && <Button title="Refresh original evidence" disabled={!online || busy} onPress={() => void controls.inspectRecovery({ sessionId: recovery.sessionId, turnId: recovery.turnId, ...(recovery.attemptId ? { attemptId: recovery.attemptId } : {}) })} />}
          {recovery.nextSteps.includes("reconcile") && <Button title="Reconcile using this evidence" disabled={!writable || Date.parse(recovery.expiresAt) <= Date.now()} onPress={() => void controls.recover("reconcile", false, recovery.evidenceId)} />}
          {recovery.nextSteps.includes("acknowledge") && <><Button title={acknowledged ? "✓ I accept that the original outcome remains unknown" : "I accept that the original outcome remains unknown"} disabled={busy} onPress={() => setAcknowledged(!acknowledged)} /><Button title="Acknowledge unknown outcome" disabled={!writable || !acknowledged || Date.parse(recovery.expiresAt) <= Date.now()} onPress={() => void controls.recover("acknowledge", acknowledged, recovery.evidenceId)} /></>}
        </>}
        {state.recoveryOperation && <Text>Recovery {state.recoveryOperation.state} · gate {state.recoveryOperation.gate}. Refreshing the authoritative Host snapshot.</Text>}
      </> : <Text>This Host does not support remote recovery. Inspect the original execution on the computer.</Text>}
    </View>}
    {replica?.sessionId && <View style={styles.card}><Text style={styles.title}>Turn file changes · read only</Text>
      {!controls.supports("diff") ? <Text>This Host does not expose checkpoint Diff. Upgrade or inspect changes on the computer.</Text> : <>
        <Text>Changes compare time boundaries. They do not attribute files to one tool.</Text>
        {!turns.length && <Text>No task checkpoints in the loaded timeline. Load older history or complete a task with checkpoints enabled.</Text>}
        {turns.map((checkpoint, index) => <Button key={checkpoint.checkpointId} title={`Task ${index + 1} · ${new Date(checkpoint.capturedAt).toLocaleString()} · ${checkpoint.status}`} disabled={!online || busy} onPress={() => void controls.turnDiff(checkpoint.turnId!, checkpoint.attemptId!)} />)}
        {state.diff && <><Text>{state.diff.status} · {state.diff.before.status} / {state.diff.after.status} · {state.diff.totalFiles} files</Text>{state.diff.unavailableReason && <Text>{state.diff.unavailableReason}</Text>}{state.diff.warnings.map((warning, index) => <Text key={index}>{warning}</Text>)}{state.diff.unsupported.map((file, index) => <Text key={index}>{file.path}: {file.reason}</Text>)}{state.diff.files.map((file) => <Button key={file.fileId} title={`${file.path} · ${file.status}`} disabled={!online || busy || state.diff?.status !== "available"} onPress={() => void controls.readFile(file.fileId)} />)}{state.diff.nextCursor && <Button title="More files" disabled={!online || busy} onPress={() => { const before = state.diff!.before; if (before.turnId && before.attemptId) void controls.turnDiff(before.turnId, before.attemptId, state.diff!.layer, true); }} />}</>}
        {state.file && <><Text style={styles.title}>{state.file.file.path}</Text><Text selectable>{state.fileContents?.patch ?? fileText(state.file.patch)}</Text>{state.file.patch.kind === "contentRef" && state.fileContents?.patch === undefined && <Button title="Read verified full Diff" disabled={!online || busy} onPress={() => void controls.readFileContent("patch")} />}</>}
      </>}
    </View>}
    {state.busy && <Text accessibilityRole="text">Checking Host: {state.busy}</Text>}{state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}{selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
  </View>;
}
const styles = StyleSheet.create({ group: { gap: 12 }, card: { backgroundColor: "white", borderRadius: 8, padding: 12, gap: 8 }, title: { fontSize: 16, fontWeight: "600" }, input: { borderWidth: 1, borderColor: "#a6afbd", borderRadius: 6, padding: 10 }, error: { color: "#a72424" } });
