import { CatalogError } from "../storage/catalog-store.js";
import type { SessionOrchestrator } from "./orchestrator.js";
import type { SessionRegistry,SessionRuntime } from "./session-registry.js";
export type LegacySessionRuntime=SessionRuntime & Pick<SessionOrchestrator,"startTurn"|"interrupt"|"respondApproval"|"subscribe">;

/** All legacy calls resolve the stable host_state default, never the UI selection. */
export class LegacySessionFacade {
  constructor(readonly registry:SessionRegistry<LegacySessionRuntime>) {}
  get sessionId():string {
    const id=this.registry.catalog.legacyDefaultSessionId();
    if(!id)throw new CatalogError("LEGACY_DEFAULT_REQUIRED","Configure one stable legacy default Session locally");
    return id;
  }
  publicSnapshot() {
    const snapshot=this.registry.store.getSnapshot(this.sessionId);if(!snapshot)throw new CatalogError("SESSION_NOT_FOUND");
    const {workspacePath:_path,createdAt:_created,updatedAt:_updated,providerSessionId:_native,baselineHead:_head,baselineDirty:_dirty,baselineStatus:_status,baselineCapturedAt:_captured,...session}=snapshot.session;
    const active=snapshot.activeTurn;
    const {authSubjectId:_actor,providerSessionId:_nativeTurn,attemptId:_attempt,nativeTurnId:_nativeId,...turn}=active??{};
    return {session:{...session,workspaceId:"default" as const},...(active?{activeTurn:turn}:{}),pendingApprovals:snapshot.pendingApprovals};
  }
  /** Compatibility session.create was always a read; preserve that contract. */
  create(){return this.publicSnapshot();}
  timeline(after=0,limit=200,upTo?:number){return this.registry.readEvents(this.sessionId,after,limit,upTo);}
  timelineItems(){return this.registry.store.listTimeline(this.sessionId);}
  async startTurn(authSubjectId:string,commandId:string,prompt:string){return (await this.registry.ensureLoaded(this.sessionId)).startTurn(authSubjectId,commandId,prompt);}
  async interrupt(authSubjectId:string,commandId:string){return (await this.registry.ensureLoaded(this.sessionId)).interrupt(authSubjectId,commandId);}
  async respondApproval(authSubjectId:string,commandId:string,approvalId:string,action:"allow_once"|"deny"){return (await this.registry.ensureLoaded(this.sessionId)).respondApproval(authSubjectId,commandId,approvalId,action);}
  gitStatus(){return this.registry.gitStatus(this.sessionId);}
  gitDiff(){return this.registry.gitDiff(this.sessionId);}
  subscribe(listener:(event:import("@flyx/mvp-protocol").SessionEvent)=>void){return this.registry.subscribe(this.sessionId,listener);}
}
