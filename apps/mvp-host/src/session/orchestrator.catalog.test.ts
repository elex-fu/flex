import {mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {createTestHostOwner} from "../lifecycle/host-owner.js";
import {openOwned} from "../storage/open-store.js";
import type {ProviderAdapter,ProviderId} from "../provider/types.js";
import {SessionOrchestrator} from "./orchestrator.js";

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"flyx-selected-session-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const workspace=join(root,"checkout");mkdirSync(workspace);
  const owner=createTestHostOwner();const store=openOwned({databasePath:":memory:",owner});cleanup.push(()=>{store.close();owner.release();});
  const adapter=(provider:ProviderId):ProviderAdapter=>({provider,workspace,status:vi.fn(),preflight:vi.fn(),runTurn:vi.fn(),interrupt:vi.fn(),respondApproval:vi.fn()});
  return {workspace,owner,store,adapter};
}
describe("selected Session runtime constructor",()=>{
  it("selects explicit Claude/Codex Sessions from one Store without recovering a different active Turn",()=>{
    const f=fixture();const claude=f.store.createSession(f.workspace,"claude","claude-session");const codex=f.store.createSession(f.workspace,"codex","codex-session");
    const active=f.store.acceptTurn({authSubjectId:"device",sessionId:claude.id,turnId:"active-turn",commandId:"active-command",requestHash:"hash",prompt:"original",generation:1,attemptId:"original-attempt"});const original=f.store.getTurn(active.turn.id);const recover=vi.spyOn(f.store,"recoverActiveTurns");
    const first=new SessionOrchestrator({workspace:f.workspace,owner:f.owner,store:f.store,adapter:f.adapter("claude"),sessionId:claude.id,ownsStore:false,recoverOnStart:false});
    const second=new SessionOrchestrator({workspace:f.workspace,owner:f.owner,store:f.store,adapter:f.adapter("codex"),sessionId:codex.id,ownsStore:false,recoverOnStart:false});
    expect(first.sessionId).toBe(claude.id);expect(second.sessionId).toBe(codex.id);expect(first.store).toBe(second.store);expect(first.ownsStore).toBe(false);expect(recover).not.toHaveBeenCalled();expect(f.store.getTurn(active.turn.id)).toEqual(original);expect(f.store.getCommandReceipt("device","active-command")?.state).toBe("accepted");
    expect(first.adapter.preflight).not.toHaveBeenCalled();expect(second.adapter.preflight).not.toHaveBeenCalled();
  });
  it("leaves the shared writer and Host owner active after missing/Provider/archived/gate constructor failures",()=>{
    const f=fixture();const session=f.store.createSession(f.workspace,"claude","selected");const base={workspace:f.workspace,owner:f.owner,store:f.store,sessionId:session.id,ownsStore:false,recoverOnStart:false};
    expect(()=>new SessionOrchestrator({...base,sessionId:"absent",adapter:f.adapter("claude")})).toThrow("Selected Session does not exist");
    expect(()=>new SessionOrchestrator({...base,adapter:f.adapter("codex")})).toThrow("Persisted session uses claude");
    f.store.db.prepare("UPDATE sessions SET status='archived' WHERE id=?").run(session.id);expect(()=>new SessionOrchestrator({...base,adapter:f.adapter("claude")})).toThrow("archived");
    f.store.db.prepare("UPDATE sessions SET status='active',recovery_state='blocked' WHERE id=?").run(session.id);expect(()=>new SessionOrchestrator({...base,adapter:f.adapter("claude")})).toThrow("requires recovery");
    f.owner.assertActive();expect(f.store.getSession(session.id)).toBeDefined();
  });
  it("requires explicit shared-store construction and prohibits Host-wide automatic recovery there",()=>{
    const f=fixture();const session=f.store.createSession(f.workspace,"claude","selected");
    expect(()=>new SessionOrchestrator({workspace:f.workspace,ownsStore:false,adapter:f.adapter("claude")})).toThrow("explicit owner, Store and Session ID");
    expect(()=>new SessionOrchestrator({workspace:f.workspace,owner:f.owner,store:f.store,sessionId:session.id,ownsStore:false,adapter:f.adapter("claude")})).toThrow("cannot recover the Host");
    expect(f.store.getSession(session.id)).toBeDefined();f.owner.assertActive();
  });
});
