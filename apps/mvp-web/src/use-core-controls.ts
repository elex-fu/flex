import { useEffect, useState } from "react";
import type { CoreControlState } from "@flyx/client-core";
import type { useHost } from "./use-host.js";

export function useCoreControls(host: ReturnType<typeof useHost>) {
  // The Host hook owns the single CoreControls instance so every Web surface (panels, unified interrupt) shares one selection fence and Outbox view.
  const controls = host.controls;
  const [observed, setObserved] = useState(() => ({ controls, state: controls.getState() }));
  useEffect(() => controls.observe((state) => setObserved({ controls, state })), [controls]);
  useEffect(() => {
    const hostId = host.connection.profile?.hostId;
    controls.select(hostId ? { hostId, sessionId: host.selectedSessionId, transportGeneration: host.connection.transportGeneration, replicaGeneration: host.replicaState?.replicaGeneration ?? 0 } : undefined);
    if (hostId && host.online && host.connection.sync === "synced" && controls.supports("sessions")) void controls.refresh();
  }, [controls, host.connection.profile?.hostId, host.selectedSessionId, host.connection.transportGeneration, host.replicaState?.replicaGeneration, host.online, host.connection.sync]);
  useEffect(() => {
    if (host.replicaState?.sync === "synced" && !host.replicaState.stale && host.replicaState.interactionsAuthoritative) controls.acceptSnapshot(host.replicaState.snapshot);
  }, [controls, host.replicaState]);
  const selected = observed.state.selection;
  const current = observed.controls === controls && selected?.hostId === host.connection.profile?.hostId && selected?.sessionId === host.selectedSessionId && selected?.transportGeneration === host.connection.transportGeneration && selected?.replicaGeneration === (host.replicaState?.replicaGeneration ?? 0);
  const empty: CoreControlState = { sessions: [], includeArchived: false, workspaces: [], providers: [], worktrees: [], flows: [] };
  return { controls, state: current ? observed.state : empty };
}
