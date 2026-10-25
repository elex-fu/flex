import { constants, accessSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { CatalogError, CatalogStore, type ProviderInstanceRecord, type ProviderVerification } from "../storage/catalog-store.js";
import type { CompatibilityScenePermit, CompatibilityScenePolicy } from "../diagnostics/compatibility-scene-policy.js";

export type CompatibilitySceneAuthority = Readonly<{ policy: CompatibilityScenePolicy; permit: CompatibilityScenePermit }>;

const ENVIRONMENT_KEYS=new Set(["PATH","LANG","LC_ALL","LC_CTYPE","TERM","NO_COLOR"]);
const Config=z.strictObject({model:z.string().min(1).max(256).optional(),environment:z.record(z.string(),z.string()).default({}),sandboxRequired:z.literal(true).default(true)});
export const LocalProviderInstanceConfig=z.strictObject({providerInstanceId:z.string().min(1).max(256),provider:z.enum(["claude","codex"]),executable:z.string().min(1),config:Config.default({environment:{},sandboxRequired:true}),policyVersion:z.number().int().positive().default(1),policyCapabilities:z.array(z.string().min(1).max(128)).max(64).default([])});
export type LocalProviderInstanceConfig=z.input<typeof LocalProviderInstanceConfig>;
export function parseLocalProviderInstance(input:LocalProviderInstanceConfig) {
  const config=LocalProviderInstanceConfig.parse(input);
  if(config.executable.includes("\0"))throw new CatalogError("PROVIDER_ENVIRONMENT_REJECTED");
  for(const [key,value] of Object.entries(config.config.environment))if(!ENVIRONMENT_KEYS.has(key)||value.includes("\0"))throw new CatalogError("PROVIDER_ENVIRONMENT_REJECTED","Provider configuration may not persist secrets or inherit arbitrary Host environment");
  return config;
}

function resolveExecutable(executable:string):string {
  const candidates=isAbsolute(executable)?[executable]:(process.env.PATH??"").split(delimiter).filter(Boolean).map((directory)=>join(directory,executable));
  for(const candidate of candidates) {try {accessSync(candidate,constants.X_OK);return realpathSync(candidate);} catch {/* Continue configured PATH only. */}}
  throw new CatalogError("PROVIDER_EXECUTABLE_NOT_FOUND","Configured Provider executable is unavailable");
}
const CAPABILITY_SCOPES:Readonly<Record<string,string>>={streamingText:"session:read",structuredToolCalls:"session:read",gitDiff:"session:read",resumeConversation:"session:write",workspaceWrite:"session:write",interrupt:"session:write",interactiveApprovals:"approval:write",structuredQuestions:"approval:write",checkpointCapture:"session:write"};

export class ProviderInstanceRegistry {
  constructor(readonly catalog:CatalogStore) {}
  get(id:string) {return this.catalog.provider(id);}
  require(id:string):ProviderInstanceRecord {const provider=this.get(id);if(!provider)throw new CatalogError("PROVIDER_INSTANCE_NOT_FOUND");if(provider.state!=="configured")throw new CatalogError("PROVIDER_INSTANCE_UNAVAILABLE",`PROVIDER_INSTANCE_UNAVAILABLE (state=${provider.state})`);return provider;}
  /** Current local executable plus trusted verification, before Native preparation. */
  requireExecution(id:string,scene?:CompatibilitySceneAuthority):ProviderInstanceRecord {
    const provider=this.require(id);
    if(scene)scene.policy.assertProvider(scene.permit,provider);
    if(!scene&&(provider.verification.state!=="verified"||!provider.verification.runtimeVersion))throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
    try {if(!isAbsolute(provider.executable)||realpathSync(provider.executable)!==provider.executable)throw new Error("changed");accessSync(provider.executable,constants.X_OK);}
    catch {throw new CatalogError("PROVIDER_EXECUTABLE_CHANGED","Configured Provider executable must be revalidated locally");}
    return provider;
  }
  list() {return this.catalog.providers();}
  listPublic() {return this.list().map((provider)=>({providerInstanceId:provider.providerInstanceId,provider:provider.provider,state:provider.state,verification:{state:provider.verification.state,...(provider.verification.state==="verified"&&provider.verification.runtimeVersion?{runtimeVersion:provider.verification.runtimeVersion}:{})}}));}
  registerLocal(input:LocalProviderInstanceConfig):ProviderInstanceRecord {
    const config=parseLocalProviderInstance(input);
    const executable=resolveExecutable(config.executable);
    const previous=this.get(config.providerInstanceId);
    if(previous&&(previous.executable!==executable||JSON.stringify(previous.config)!==JSON.stringify(config.config)||previous.policyVersion!==config.policyVersion)) {
      const inUse=this.catalog.allSessions({providerInstanceId:previous.providerInstanceId}).some((session)=>session.residency!=="unloaded");
      if(inUse)throw new CatalogError("PROVIDER_INSTANCE_BUSY","Close its runtimes before changing Provider configuration",true);
    }
    const unchanged=previous?.executable===executable&&JSON.stringify(previous.config)===JSON.stringify(config.config)&&previous.policyVersion===config.policyVersion;
    return this.catalog.putProvider({...config,config:{environment:config.config.environment,sandboxRequired:true,...(config.config.model?{model:config.config.model}:{})},executable,state:"configured",verification:unchanged?previous!.verification:{state:"unverified",capabilities:[]}});
  }
  recordVerification(id:string,verification:ProviderVerification):ProviderInstanceRecord {
    const provider=this.require(id);
    if(verification.state==="verified"&&!verification.runtimeVersion)throw new CatalogError("PROVIDER_VERIFICATION_INVALID");
    if(verification.capabilities.length>64||verification.capabilities.some((capability)=>!Object.hasOwn(CAPABILITY_SCOPES,capability)))throw new CatalogError("PROVIDER_VERIFICATION_INVALID");
    return this.catalog.putProvider({...provider,verification});
  }
  effectiveCapabilities(id:string,context:{adapter:readonly string[];workspace:readonly string[];deviceScopes:ReadonlySet<string>|readonly string[];scene?:CompatibilitySceneAuthority}):string[] {
    const provider=this.require(id);if(context.scene)context.scene.policy.assertProvider(context.scene.permit,provider);else if(provider.verification.state!=="verified")return [];
    const scopes=context.deviceScopes instanceof Set?context.deviceScopes:new Set(context.deviceScopes);
    const capabilities=context.scene?["streamingText","resumeConversation"]:provider.verification.capabilities;
    return capabilities.filter((capability)=>Boolean(CAPABILITY_SCOPES[capability])&&context.adapter.includes(capability)&&context.workspace.includes(capability)&&provider.policyCapabilities.includes(capability)&&scopes.has(CAPABILITY_SCOPES[capability]!));
  }
}
