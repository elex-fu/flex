import {z} from "zod";
import {SessionSummaryV2Schema,WorkspaceSummaryV2Schema,ProviderInstanceSummaryV2Schema,SESSION_CATALOG_METHOD_SCOPES} from "./session-api.js";

const Id=z.string().min(1).max(256);
const CommandId=z.string().min(1).max(128);
export const CatalogReceiptSchema=z.strictObject({commandId:CommandId,targetSessionId:Id,state:z.enum(["accepted","completed","failed","cancelled","outcome_unknown"])});
export const CatalogMutationResponseSchema=z.strictObject({session:SessionSummaryV2Schema,receipt:CatalogReceiptSchema}).refine((value)=>value.session.sessionId===value.receipt.targetSessionId,{message:"Receipt target differs from its Session"});
export type CatalogMutationResponse=z.infer<typeof CatalogMutationResponseSchema>;
export const EmptyCatalogRequestSchema=z.strictObject({});
export const ListWorkspacesResponseSchema=z.strictObject({workspaces:z.array(WorkspaceSummaryV2Schema).max(256)});
export const ListProviderInstancesResponseSchema=z.strictObject({providerInstances:z.array(ProviderInstanceSummaryV2Schema).max(64)});
export type ListWorkspacesResponse=z.infer<typeof ListWorkspacesResponseSchema>;
export type ListProviderInstancesResponse=z.infer<typeof ListProviderInstancesResponseSchema>;
export const SessionEventsV2RequestSchema=z.strictObject({sessionId:Id,afterSequence:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(200),upTo:z.number().int().nonnegative().optional()});
export const SessionDiffV2RequestSchema=z.strictObject({sessionId:Id});
export const SessionExecutionResponseV2Schema=z.strictObject({sessionId:Id,turnId:Id.optional(),approvalId:Id.optional(),status:z.string().min(1).max(128),receipt:CatalogReceiptSchema}).refine((value)=>value.sessionId===value.receipt.targetSessionId,{message:"Receipt target differs from its Session"});
export type SessionExecutionResponseV2=z.infer<typeof SessionExecutionResponseV2Schema>;

/** Concrete method contract; actor identity comes only from authenticated context. */
export const HOST_CATALOG_METHOD_SCOPES=SESSION_CATALOG_METHOD_SCOPES;
