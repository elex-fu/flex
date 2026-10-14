import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { WorkspaceLease } from "./workspace-lease.js";

const roots: string[] = [];
const owners: HostOwnerHandle[] = [];
const leases: WorkspaceLease[] = [];
afterEach(() => {
  for (const lease of leases.splice(0)) { try { lease.release(); } catch { /* retained test */ } }
  for (const owner of owners.splice(0)) owner.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flyx-workspace-lease-"));
  roots.push(root);
  const workspace = join(root, "checkout");
  const isolatedWorktree = join(root, "worktree");
  mkdirSync(workspace);
  mkdirSync(isolatedWorktree);
  symlinkSync(workspace, join(root, "checkout-alias"));
  const coordinationDirectory = join(root, "coordination");
  const owner = (name: string) => {
    const result = HostOwnerLock.acquire({ databasePath: join(root, name, "host.sqlite"), identityDirectory: join(root, name, "identity"), coordinationDirectory });
    owners.push(result);
    return result;
  };
  return { root, workspace, isolatedWorktree, first: owner("one"), second: owner("two") };
}

describe("checkout leases", () => {
  it("blocks a second writer across different DBs and canonical aliases while another worktree remains available", () => {
    const f = fixture();
    const first = WorkspaceLease.acquire({ workspace: f.workspace, owner: f.first, operationId: "turn-one" });
    leases.push(first);
    expect(() => WorkspaceLease.acquire({ workspace: join(f.root, "checkout-alias"), owner: f.second })).toThrow("Another Host");
    const isolated = WorkspaceLease.acquire({ workspace: f.isolatedWorktree, owner: f.second });
    leases.push(isolated);
    first.release();
    const next = WorkspaceLease.acquire({ workspace: f.workspace, owner: f.second });
    leases.push(next);
    next.assertActive();
  });

  it("keeps the original managed key after quarantine/removal and rejects aliases",()=>{
    const f=fixture();const original=realpathSync(f.workspace);
    const held=WorkspaceLease.acquire({workspace:original,owner:f.first,operationId:"archive"});leases.push(held);
    renameSync(f.workspace,join(f.root,"quarantine"));
    expect(()=>WorkspaceLease.acquireReserved({canonicalWorkspace:original,owner:f.second})).toThrow("Another Host");
    held.release();
    const reserved=WorkspaceLease.acquireReserved({canonicalWorkspace:original,owner:f.second});leases.push(reserved);
    expect(reserved.resourceKey).toBe(`workspace:${original}`);
    expect(()=>WorkspaceLease.acquireReserved({canonicalWorkspace:join(f.root,"checkout-alias"),owner:f.first})).toThrow();
    rmSync(join(f.root,"quarantine"),{recursive:true});reserved.assertActive();
  });

  it("retains a checkout gate after an unknown execution outcome", () => {
    const f = fixture();
    const lease = WorkspaceLease.acquire({ workspace: f.workspace, owner: f.first });
    leases.push(lease);
    lease.retain("provider_tree_exit_unknown");
    expect(() => lease.release()).toThrow("must remain in place");
    expect(() => WorkspaceLease.acquire({ workspace: f.workspace, owner: f.second })).toThrow("Another Host");
  });

  it("uses operation-bound evidence to clear a retained checkout while the Host remains alive", () => {
    const f = fixture();
    const lease = WorkspaceLease.acquire({ workspace: f.workspace, owner: f.first, operationId: "retained-turn" });
    leases.push(lease);
    lease.retain("provider_tree_unknown");
    const proof = { ownerId: f.first.ownerId, ownerGeneration: f.first.generation,
      evidenceId: "evidence", turnId: "retained-turn", attemptId: "attempt", resourceKeys: [lease.resourceKey] };
    expect(() => lease.clearRetention({ ...proof, turnId: "different-turn" }, () => true)).toThrow("different checkout operation");
    expect(() => lease.clearRetention(proof, () => false)).toThrow("did not prove");
    lease.clearRetention(proof, () => true);
    lease.release();
    const next = WorkspaceLease.acquire({ workspace: f.workspace, owner: f.second });
    leases.push(next);
  });
});
