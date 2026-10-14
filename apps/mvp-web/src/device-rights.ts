import { isRecord } from "./timeline.js";
/** Rights are usable only from a fresh authenticated directory for this Host. */
export function currentApprovalWrite(value: unknown, hostId: string): boolean {
  if (!isRecord(value) || typeof value.currentDeviceId !== "string" || !Array.isArray(value.devices)) return false;
  const self = value.devices.find((device) => isRecord(device) && device.id === value.currentDeviceId);
  return isRecord(self) && self.hostId === hostId && !self.revokedAt && Array.isArray(self.scopes) && self.scopes.includes("approval:write");
}
