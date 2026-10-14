import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { fetch as expoFetch } from "expo/fetch";
import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import { NativePlatformSignals } from "./signals";
import { NativeClientStore } from "./store";
import type { NativeDatabase, SqlExecutor } from "./store";
import { createNativeFetch, createNativeSocketFactory } from "./transport";
import type { NativeSocketConstructor } from "./transport";
function executor(db: SQLite.SQLiteDatabase): SqlExecutor { return { runAsync: (sql, ...params) => db.runAsync(sql, ...params), getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) => db.getFirstAsync<T>(sql, ...params), getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) => db.getAllAsync<T>(sql, ...params) }; }
export async function openExpoStore(): Promise<NativeClientStore> {
  const db = await SQLite.openDatabaseAsync("flyx-native.db");
  const bridge: NativeDatabase = { ...executor(db), execAsync: (sql) => db.execAsync(sql), closeAsync: () => db.closeAsync(), withExclusiveTransactionAsync: (task) => db.withExclusiveTransactionAsync((tx) => task(executor(tx))) };
  return NativeClientStore.open(bridge, {
    getItemAsync: (key) => SecureStore.getItemAsync(key), deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  });
}
export const expoPlatformSignals = new NativePlatformSignals({ get currentState() { return AppState.currentState; }, addEventListener: (_event, handler) => AppState.addEventListener("change", handler) }, NetInfo);
export const expoFetchImplementation = async (url: string, init: RequestInit): Promise<Response> => await expoFetch(url, init as Parameters<typeof expoFetch>[1]) as unknown as Response;
export const nativeFetch = createNativeFetch(expoFetchImplementation);
export const nativeSocketFactory = createNativeSocketFactory(WebSocket as unknown as NativeSocketConstructor, process.env.EXPO_PUBLIC_RELAY_CLIENT_ORIGIN);
