import { AttentionAcknowledgeRequestSchema, AttentionAcknowledgeResponseSchema, AttentionListRequestSchema, AttentionListResponseSchema, AttentionPreferencesSchema, AttentionPresenceRequestSchema, AttentionRegisterPushRequestSchema, AttentionSetPreferencesRequestSchema, AttentionSubscriptionSchema, AttentionUnregisterPushRequestSchema, type AttentionListResponse, type AttentionPreferences, type AttentionRegisterPushRequest, } from "@flyx/mvp-protocol";
export interface AttentionClientOptions {
  hostId: string;
  request(method: string, payload: unknown, commandId?: string): Promise<unknown>;
}
/** Bind this adapter to an authenticated HostRuntime; actor IDs never enter payloads. */
export class AttentionClient {
  constructor(private readonly options: AttentionClientOptions) { }
  async list(value: unknown = {}): Promise<AttentionListResponse> {
    const input = AttentionListRequestSchema.parse(value);
    const response = AttentionListResponseSchema.parse(await this.options.request("attention.list", input));
    if (response.items.some((item) => item.hostId !== this.options.hostId || input.sessionId && item.sessionId !== input.sessionId)) {
      throw new Error("ATTENTION_HOST_OR_SESSION_MISMATCH");
    }
    return response;
  }
  async registerPush(value: AttentionRegisterPushRequest, commandId?: string) {
    const input = AttentionRegisterPushRequestSchema.parse(value);
    return AttentionSubscriptionSchema.parse(await this.options.request("attention.registerPush", input, commandId));
  }
  async unregisterPush(value: unknown, commandId?: string): Promise<void> {
    const input = AttentionUnregisterPushRequestSchema.parse(value);
    const response = await this.options.request("attention.unregisterPush", input, commandId) as {
      subscriptionId?: unknown;
      status?: unknown;
    };
    if (!response || response.subscriptionId !== input.subscriptionId || response.status !== "revoked")
      throw new Error("PUSH_UNREGISTER_RESPONSE_INVALID");
  }
  async acknowledge(value: unknown, commandId?: string) {
    const input = AttentionAcknowledgeRequestSchema.parse(value);
    const response = AttentionAcknowledgeResponseSchema.parse(await this.options.request("attention.acknowledge", input, commandId));
    if (response.attentionId !== input.attentionId || response.version !== input.expectedVersion)
      throw new Error("ATTENTION_ACK_RESPONSE_INVALID");
    return response;
  }
  async getPreferences(): Promise<AttentionPreferences> {
    return AttentionPreferencesSchema.parse(await this.options.request("attention.getPreferences", {}));
  }
  async setPreferences(value: unknown, commandId?: string): Promise<AttentionPreferences> {
    const input = AttentionSetPreferencesRequestSchema.parse(value);
    const response = AttentionPreferencesSchema.parse(await this.options.request("attention.setPreferences", input, commandId));
    if (response.revision !== input.expectedRevision + 1 || response.mode !== input.mode || response.pushEnabled !== input.pushEnabled)
      throw new Error("ATTENTION_PREFERENCES_RESPONSE_INVALID");
    return response;
  }
  async setPresence(value: unknown): Promise<void> {
    const input = AttentionPresenceRequestSchema.parse(value);
    const response = await this.options.request("attention.setPresence", input) as {
      foreground?: unknown;
    };
    if (!response || response.foreground !== input.foreground)
      throw new Error("ATTENTION_PRESENCE_RESPONSE_INVALID");
  }
}
