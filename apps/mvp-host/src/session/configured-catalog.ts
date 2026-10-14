import {readFileSync,statSync} from "node:fs";
import {z} from "zod";
import type {HostOwnerHandle} from "../lifecycle/host-owner.js";
import {CatalogStore,CatalogError} from "../storage/catalog-store.js";
import {WorkspaceRegistry,type LocalWorkspaceConfig,type WorkspaceGitQuery} from "../workspace/workspace-registry.js";
import {ProviderInstanceRegistry,LocalProviderInstanceConfig} from "../provider/provider-instance-registry.js";

const ConfiguredWorkspace=z.strictObject({workspaceId:z.string().min(1).max(256),root:z.string().min(1),repositoryId:z.string().min(1).max(256).optional(),capabilities:z.array(z.string().min(1).max(128)).max(64).optional()});
export const LocalCatalogConfigurationSchema=z.strictObject({workspaces:z.array(ConfiguredWorkspace).max(256).default([]),providerInstances:z.array(LocalProviderInstanceConfig).max(64).default([]),legacyDefaultSessionId:z.string().min(1).max(256).optional()});
export type LocalCatalogConfiguration=z.input<typeof LocalCatalogConfigurationSchema>;

/** A Host-local configuration file, never a client supplied cwd or environment. */
export function readLocalCatalogConfiguration(path:string):LocalCatalogConfiguration {
  if(!statSync(path).isFile()||statSync(path).size>256*1024)throw new CatalogError("CATALOG_CONFIGURATION_INVALID");
  return LocalCatalogConfigurationSchema.parse(JSON.parse(readFileSync(path,"utf8")) as unknown);
}
export async function registerConfiguredCatalog(catalog:CatalogStore,owner:HostOwnerHandle,configuration:LocalCatalogConfiguration,options:{privateDirectories?:readonly string[];readOnlyGit?:WorkspaceGitQuery}={}) {
  catalog.store.assertWriterOwner();
  const parsed=LocalCatalogConfigurationSchema.parse(configuration);
  const workspaces=new WorkspaceRegistry(catalog,{owner,...(options.privateDirectories?{privateDirectories:options.privateDirectories}:{}),...(options.readOnlyGit?{readOnlyGit:options.readOnlyGit}:{})});
  const providers=new ProviderInstanceRegistry(catalog);
  for(const workspace of parsed.workspaces)await workspaces.registerLocal({workspaceId:workspace.workspaceId,root:workspace.root,...(workspace.repositoryId?{repositoryId:workspace.repositoryId}:{}),...(workspace.capabilities?{capabilities:workspace.capabilities}:{})} satisfies LocalWorkspaceConfig);
  for(const provider of parsed.providerInstances)providers.registerLocal(provider);
  if(parsed.legacyDefaultSessionId)catalog.setLegacyDefaultOnce(parsed.legacyDefaultSessionId);
  return {catalog,workspaces,providers};
}
