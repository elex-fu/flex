export interface WebBootstrapPreference {
  isBlocked(): boolean;
  block(): void;
  allow(): void;
}
export const WEB_BOOTSTRAP_PREFERENCE_KEY = "flyx:web:automatic-bootstrap:v1";
export type WebPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** A non-secret application preference. It contains neither a Host ID nor a credential. */
export class StoredWebBootstrapPreference implements WebBootstrapPreference {
  constructor(private readonly storage: () => WebPreferenceStorage) {}
  isBlocked(): boolean { try { return this.storage().getItem(WEB_BOOTSTRAP_PREFERENCE_KEY) === "blocked"; } catch { throw new Error("无法读取自动连接设置，请手动选择 Host 或配对"); } }
  block(): void {
    try { const storage = this.storage(); storage.setItem(WEB_BOOTSTRAP_PREFERENCE_KEY,"blocked"); if (storage.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY) !== "blocked") throw new Error("not persisted"); }
    catch { throw new Error("无法保存停止自动连接的设置，本地记录尚未删除"); }
  }
  allow(): void {
    try { const storage = this.storage(); storage.removeItem(WEB_BOOTSTRAP_PREFERENCE_KEY); if (storage.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY) !== null) throw new Error("not persisted"); }
    catch { throw new Error("手动连接已完成，自动连接偏好无法保存"); }
  }
}
