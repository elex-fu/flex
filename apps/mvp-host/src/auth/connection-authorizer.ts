import type { DeviceRegistry, ConnectionPrincipal } from "./device-registry.js";

export const DEVICE_SCOPES = [
  "host:read",
  "session:read",
  "session:write",
  "approval:write",
  "access:self",
  "access:admin",
] as const;

export type DeviceScope = typeof DEVICE_SCOPES[number];

/** Local confirmation grants the legacy owner role unless it approves a
 * narrower explicit scope set. A client can only reduce the grant's scopes. */
export const DEFAULT_DEVICE_SCOPES: readonly DeviceScope[] = DEVICE_SCOPES;

const SCOPE_ALIASES: Readonly<Record<string, DeviceScope>> = Object.freeze({
  "host.read": "host:read",
  "session.read": "session:read",
  "session.write": "session:write",
  "session.control": "session:write",
  "approval.respond": "approval:write",
  "approval.write": "approval:write",
  "access.admin": "access:admin",
  "host.admin": "access:admin",
});

export class AccessError extends Error {
  readonly retryable = false;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AccessError";
  }
}

const METHOD_SCOPES: Readonly<Record<string, DeviceScope>> = Object.freeze({
  "host.bootstrap": "host:read",
  "host.getDescriptor": "host:read",
  "host.getSnapshot": "session:read",
  "host.getStatus": "host:read",
  "host.probe": "host:read",
  "session.create": "session:read",
  "session.getEvents": "session:read",
  "session.openView": "session:read",
  "timeline.getPage": "session:read",
  "timeline.subscribe": "session:read",
  "timeline.unsubscribe": "session:read",
  "session.getDiff": "session:read",
  "content.getChunk": "session:read",
  "session.subscribe": "session:read",
  "command.getReceipt": "session:read",
  "session.recovery.inspect": "session:read",
  "session.recovery.reconcile": "session:write",
  "session.recovery.acknowledge": "session:write",
  "session.startTurn": "session:write",
  "session.interrupt": "session:write",
  "approval.respond": "approval:write",
  "access.refresh": "access:self",
  "access.revokeSelf": "access:self",
  "access.listDevices": "access:admin",
  "access.revokeDevice": "access:admin",
  "access.revokeAll": "access:admin",
  "access.revokeAllDevices": "access:admin",
});

export function requiredScopeForMethod(method: string): DeviceScope | undefined {
  return Object.hasOwn(METHOD_SCOPES, method) ? METHOD_SCOPES[method] : undefined;
}

export function validateScopes(input: readonly string[]): DeviceScope[] {
  if (!Array.isArray(input) || input.length > DEVICE_SCOPES.length) {
    throw new AccessError("INVALID_SCOPES", "Device scopes contain an unsupported permission");
  }
  const canonical = input.map((scope) => {
    if (typeof scope !== "string") throw new AccessError("INVALID_SCOPES", "Device scopes contain an unsupported permission");
    if ((DEVICE_SCOPES as readonly string[]).includes(scope)) return scope as DeviceScope;
    const alias = Object.hasOwn(SCOPE_ALIASES, scope) ? SCOPE_ALIASES[scope] : undefined;
    if (!alias) throw new AccessError("INVALID_SCOPES", "Device scopes contain an unsupported permission");
    return alias;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new AccessError("INVALID_SCOPES", "Device scopes contain duplicate permissions");
  }
  return DEVICE_SCOPES.filter((scope) => canonical.includes(scope));
}

export function assertMethodScope(principal: { scopes: ReadonlySet<string> } | ReadonlySet<string>, method: string): void {
  const scope = requiredScopeForMethod(method);
  // Pairing and refresh-token authentication use separate explicit admission
  // paths. An unknown method must never acquire the permissions of its prefix.
  if (!scope) throw new AccessError("METHOD_NOT_FOUND", "RPC method is not supported");
  const scopes = "scopes" in principal ? principal.scopes : principal;
  if (!scopes.has(scope)) throw new AccessError("FORBIDDEN", `This device does not have ${scope} permission`);
}

export class ConnectionAuthorizer {
  constructor(private readonly devices: DeviceRegistry) {}

  authorize(leaseId: string, method: string, generation?: number): ConnectionPrincipal {
    const principal = this.devices.assertLease(leaseId, generation);
    try {
      assertMethodScope(principal, method);
      return principal;
    } catch (error) {
      if (error instanceof AccessError && error.code === "FORBIDDEN") this.devices.auditScopeDenied(principal.deviceId, method);
      throw error;
    }
  }
}
