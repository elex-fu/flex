import { AttentionRouteSchema, AttentionRegisterPushRequestSchema, ExpoPushTokenSchema, type AttentionRoute } from "@flyx/mvp-protocol";
import type { PushSubscription } from "./store.js";
export type AttentionDeliveryResult = {
  status: "accepted";
  receiptId: string;
  code: "PUSH_SERVICE_ACCEPTED";
} | {
  status: "presented";
  code: "IN_APP_PRESENTED";
} | {
  status: "unavailable";
  code: string;
  invalidateSubscription?: boolean;
} | {
  status: "retryable";
  code: string;
} | {
  status: "outcome_unknown";
  code: string;
};
export interface AttentionDeliveryDriver {
  readonly configured: boolean;
  send(subscription: PushSubscription, payload: AttentionRoute, signal?: AbortSignal): Promise<AttentionDeliveryResult>;
}
export class DisabledAttentionDriver implements AttentionDeliveryDriver {
  readonly configured = false;
  async send(): Promise<AttentionDeliveryResult> { return { status: "unavailable", code: "PUSH_SINK_UNAVAILABLE" }; }
}
export const EXPO_PUSH_SEND_ENDPOINT = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPT_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";
export type PushReceiptResult = {
  status: "pending" | "provider_delivered" | "unavailable";
  code: string;
  invalidateSubscription?: boolean;
};
export interface ExpoAttentionDriverOptions {
  enabled: boolean;
  /** Exact fixed endpoint is required; no client-selected destinations. */
  endpoint: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
  accessToken?: string;
  timeoutMs?: number;
  now?: () => Date;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new Error("PUSH_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done)
        break;
      length += part.value.byteLength;
      if (length > 16384)
        throw new Error("PUSH_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Ticket acceptance and provider handoff are distinct from actual device delivery.
* Endpoint/message/ticket semantics: https://docs.expo.dev/push-notifications/sending-notifications/ */
export class ExpoAttentionDriver implements AttentionDeliveryDriver {
  readonly configured: boolean;
  private readonly timeoutMs: number;
  constructor(private readonly options: ExpoAttentionDriverOptions) {
    this.configured = options.enabled;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (options.endpoint !== EXPO_PUSH_SEND_ENDPOINT || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000
      || !AttentionRegisterPushRequestSchema.shape.projectId.safeParse(options.projectId).success || options.accessToken && /[\r\n]/.test(options.accessToken))
      throw new Error("PUSH_CONFIGURATION_INVALID");
  }
  private headers(): Record<string, string> { return { "content-type": "application/json", accept: "application/json", ...(this.options.accessToken ? { authorization: "Bearer " + this.options.accessToken } : {}) }; }
  async send(subscription: PushSubscription, value: AttentionRoute, signal?: AbortSignal): Promise<AttentionDeliveryResult> {
    if (!this.configured)
      return { status: "unavailable", code: "PUSH_SINK_UNAVAILABLE" };
    const payload = AttentionRouteSchema.parse(value);
    if (!ExpoPushTokenSchema.safeParse(subscription.token).success || subscription.project_id !== this.options.projectId || subscription.host_id !== payload.hostId || subscription.revoked_at)
      return { status: "unavailable", code: "PUSH_SUBSCRIPTION_INVALID" };
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const remaining = Math.min(Date.parse(payload.expiresAt), Date.parse(subscription.expires_at)) - now;
    if (!Number.isFinite(remaining) || remaining <= 0)
      return { status: "unavailable", code: "ATTENTION_EXPIRED" };
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const response = await (this.options.fetch ?? globalThis.fetch)(EXPO_PUSH_SEND_ENDPOINT, {
        method: "POST", redirect: "error", headers: this.headers(),
        // Data-only wakeup. No prompt, title, reason, body, path, Diff or action.
        body: JSON.stringify({ to: subscription.token, data: payload, ttl: Math.max(1, Math.ceil(remaining / 1000)), priority: "normal", contentAvailable: true, collapseId: payload.attentionId }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 429) {
        await response.body?.cancel();
        return { status: "retryable", code: "PUSH_RATE_LIMITED" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return response.status >= 500 ? { status: "outcome_unknown", code: "PUSH_SERVICE_UNCONFIRMED" } : { status: "unavailable", code: "PUSH_SERVICE_REJECTED" };
      }
      const data = object((object(await boundedJson(response))).data);
      if (data.status === "ok" && typeof data.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.id))
        return { status: "accepted", receiptId: data.id, code: "PUSH_SERVICE_ACCEPTED" };
      if (object(data.details).error === "DeviceNotRegistered")
        return { status: "unavailable", code: "PUSH_DEVICE_UNREGISTERED", invalidateSubscription: true };
      if (data.status === "error")
        return { status: "unavailable", code: "PUSH_SERVICE_REJECTED" };
      return { status: "outcome_unknown", code: "PUSH_RESPONSE_UNCONFIRMED" };
    }
    catch {
      return { status: "outcome_unknown", code: "PUSH_DISPATCH_UNCONFIRMED" };
    }
  }
  async inspectReceipt(subscription: PushSubscription, receiptId: string, signal?: AbortSignal): Promise<PushReceiptResult> {
    if (!this.configured || subscription.project_id !== this.options.projectId || subscription.revoked_at)
      return { status: "unavailable", code: "PUSH_SINK_UNAVAILABLE" };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receiptId))
      return { status: "unavailable", code: "PUSH_RECEIPT_INVALID" };
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const response = await (this.options.fetch ?? globalThis.fetch)(EXPO_PUSH_RECEIPT_ENDPOINT, { method: "POST", redirect: "error", headers: this.headers(), body: JSON.stringify({ ids: [receiptId] }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: "pending", code: "PUSH_RECEIPT_UNAVAILABLE" };
      }
      const receipt = object(object(object(await boundedJson(response)).data)[receiptId]);
      if (receipt.status === "ok")
        return { status: "provider_delivered", code: "PUSH_PROVIDER_HANDOFF" };
      if (object(receipt.details).error === "DeviceNotRegistered")
        return { status: "unavailable", code: "PUSH_DEVICE_UNREGISTERED", invalidateSubscription: true };
      if (receipt.status === "error")
        return { status: "unavailable", code: "PUSH_PROVIDER_REJECTED" };
      return { status: "pending", code: "PUSH_RECEIPT_PENDING" };
    }
    catch {
      return { status: "pending", code: "PUSH_RECEIPT_UNAVAILABLE" };
    }
  }
}
