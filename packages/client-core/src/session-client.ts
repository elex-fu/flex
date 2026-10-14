import {
  SESSION_CATALOG_CAPABILITY,CreateSessionV2Schema,RenameSessionV2Schema,ChangeSessionStatusV2Schema,ListSessionsV2Schema,SessionTargetV2Schema,StartTurnV2Schema,InterruptTurnV2Schema,
  ListSessionsV2ResponseSchema,SessionSnapshotV2Schema,CatalogMutationResponseSchema,ListWorkspacesResponseSchema,ListProviderInstancesResponseSchema,SessionExecutionResponseV2Schema,
  type CatalogMutationResponse,type SessionSummaryV2,type SessionSnapshotV2,type ListSessionsV2Response,type ListWorkspacesResponse,type ListProviderInstancesResponse,type SessionExecutionResponseV2,
} from "@flyx/mvp-protocol";
import {ClientError} from "./common.js";

export interface SessionClientPort {
  supportsCapability(capability:string):boolean;
  request<T=unknown>(method:string,payload?:unknown):Promise<T>;
  command<T=unknown>(method:string,payload?:unknown,commandId?:string):Promise<T>;
}
export type SessionClientOptions = {commandId?:()=>string};
/** Use the public authenticated FlyxClient port; mutations retain its durable Outbox. */
export class SessionClient {
  constructor(private readonly port:SessionClientPort,private readonly options:SessionClientOptions={}) {}
  private requireCapability():void {if(!this.port.supportsCapability(SESSION_CATALOG_CAPABILITY))throw new ClientError("CAPABILITY_UNSUPPORTED","Host has not negotiated the Session catalog");}
  private async read<T>(method:string,input:unknown,schema:{parse(value:unknown):T}):Promise<T> {
    this.requireCapability();const response=await this.port.request<unknown>(method,input);
    try{return schema.parse(response);}catch{throw new ClientError("INVALID_RPC_RESPONSE","Host returned an invalid Session response",{method});}
  }
  private async write<T>(method:string,input:unknown,commandId:string|undefined,schema:{parse(value:unknown):T}):Promise<T> {
    this.requireCapability();const id=commandId??this.options.commandId?.()??globalThis.crypto?.randomUUID?.();
    if(!id)throw new ClientError("COMMAND_ID_UNAVAILABLE","A cryptographic command identity source is required");
    if(!id||id.length>128)throw new ClientError("INVALID_COMMAND_ID","Invalid command identity");
    const response=await this.port.command<unknown>(method,input,id);
    try {
      const parsed=schema.parse(response);
      if(!parsed||typeof parsed!=="object"||!("receipt" in parsed)||!parsed.receipt||typeof parsed.receipt!=="object"||!("commandId" in parsed.receipt)||parsed.receipt.commandId!==id)throw new Error("Receipt identity changed");
      return parsed;
    }catch{throw new ClientError("INVALID_RPC_RESPONSE","Host returned an invalid Session command response",{method});}
  }
  async list(input:unknown={}):Promise<ListSessionsV2Response> {
    const parsed=ListSessionsV2Schema.parse(input);const response=await this.read("session.list",parsed,ListSessionsV2ResponseSchema);
    if(response.sessions.length>parsed.limit||response.sessions.some((session)=>parsed.workspaceId&&session.workspaceId!==parsed.workspaceId||!parsed.includeArchived&&session.status==="archived"||parsed.afterSessionId&&session.sessionId<=parsed.afterSessionId))throw new ClientError("SESSION_TARGET_MISMATCH","Session directory differs from the requested scope");
    const ids=response.sessions.map((session)=>session.sessionId);if(new Set(ids).size!==ids.length||response.nextSessionId&&response.nextSessionId!==ids.at(-1))throw new ClientError("INVALID_RPC_RESPONSE","Session directory cursor is invalid");
    return response;
  }
  async getSnapshot(input:unknown):Promise<SessionSnapshotV2> {
    const parsed=SessionTargetV2Schema.parse(input);const response=await this.read("session.getSnapshot",parsed,SessionSnapshotV2Schema);
    if(response.session.sessionId!==parsed.sessionId||response.activeTurn&&response.activeTurn.sessionId!==parsed.sessionId)throw new ClientError("SESSION_TARGET_MISMATCH","Snapshot belongs to a different Session");return response;
  }
  listWorkspaces():Promise<ListWorkspacesResponse>{return this.read("workspace.list",{},ListWorkspacesResponseSchema);}
  listProviders():Promise<ListProviderInstancesResponse>{return this.read("provider.list",{},ListProviderInstancesResponseSchema);}
  private target(response:CatalogMutationResponse,sessionId:string):CatalogMutationResponse {
    if(response.session.sessionId!==sessionId||response.receipt.targetSessionId!==sessionId)throw new ClientError("SESSION_TARGET_MISMATCH","Mutation belongs to a different Session");return response;
  }
  async createNew(input:unknown,commandId?:string):Promise<CatalogMutationResponse> {
    const parsed=CreateSessionV2Schema.parse(input);const response=await this.write("session.createNew",parsed,commandId,CatalogMutationResponseSchema);
    if(response.session.workspaceId!==parsed.workspaceId||response.session.providerInstanceId!==parsed.providerInstanceId||response.session.sessionId!==response.receipt.targetSessionId)throw new ClientError("SESSION_TARGET_MISMATCH","Created Session differs from its requested binding");return response;
  }
  async rename(input:unknown,commandId?:string):Promise<CatalogMutationResponse> {const parsed=RenameSessionV2Schema.parse(input);return this.target(await this.write("session.rename",parsed,commandId,CatalogMutationResponseSchema),parsed.sessionId);}
  async archive(input:unknown,commandId?:string):Promise<CatalogMutationResponse> {return this.status("session.archive",input,commandId);}
  async unarchive(input:unknown,commandId?:string):Promise<CatalogMutationResponse> {return this.status("session.unarchive",input,commandId);}
  async closeRuntime(input:unknown,commandId?:string):Promise<CatalogMutationResponse> {return this.status("session.closeRuntime",input,commandId);}
  private async status(method:string,input:unknown,commandId?:string):Promise<CatalogMutationResponse>{const parsed=ChangeSessionStatusV2Schema.parse(input);return this.target(await this.write(method,parsed,commandId,CatalogMutationResponseSchema),parsed.sessionId);}
  async startTurn(input:unknown,commandId?:string):Promise<SessionExecutionResponseV2>{const parsed=StartTurnV2Schema.parse(input);return this.execution("session.startTurn",parsed,parsed.sessionId,commandId);}
  async interrupt(input:unknown,commandId?:string):Promise<SessionExecutionResponseV2>{const parsed=InterruptTurnV2Schema.parse(input);return this.execution("session.interrupt",parsed,parsed.sessionId,commandId);}
  private async execution(method:string,input:unknown,sessionId:string,commandId?:string):Promise<SessionExecutionResponseV2> {
    const response=await this.write(method,input,commandId,SessionExecutionResponseV2Schema);
    if(response.sessionId!==sessionId||response.receipt.targetSessionId!==sessionId)throw new ClientError("SESSION_TARGET_MISMATCH","Execution belongs to a different Session");return response;
  }
}
export type {SessionSummaryV2};
