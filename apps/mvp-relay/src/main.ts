import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRelayServer } from "./server.js";
import { FileRelayRouteStore } from "./file-route-store.js";

const port = Number(process.env.FLYX_RELAY_PORT ?? 4483);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FLYX_RELAY_PORT");
const certificatePath = process.env.FLYX_RELAY_TLS_CERT;
const keyPath = process.env.FLYX_RELAY_TLS_KEY;
if (!!certificatePath !== !!keyPath) throw new Error("Set both FLYX_RELAY_TLS_CERT and FLYX_RELAY_TLS_KEY");
const tls = certificatePath && keyPath ? { cert: await readFile(certificatePath), key: await readFile(keyPath) } : undefined;
const relay = createRelayServer({
  host: process.env.FLYX_RELAY_HOST ?? "127.0.0.1",
  port,
  ...(tls ? { tls } : {}),
  allowInsecureLoopback: process.env.FLYX_RELAY_INSECURE_LOOPBACK === "1",
  routeStore: new FileRelayRouteStore(resolve(process.env.FLYX_RELAY_DATA_DIR ?? ".flyx/relay-routes")),
  ...(process.env.FLYX_RELAY_REGISTRATION_TOKEN ? { registrationToken: process.env.FLYX_RELAY_REGISTRATION_TOKEN } : {}),
  ...(process.env.FLYX_RELAY_METRICS_TOKEN ? { metricsToken: process.env.FLYX_RELAY_METRICS_TOKEN } : {}),
  ...(process.env.FLYX_RELAY_ALLOWED_ORIGINS ? { allowedClientOrigins: process.env.FLYX_RELAY_ALLOWED_ORIGINS.split(",").map(value => value.trim()).filter(Boolean) } : {}),
  logger: event => process.stdout.write(`${JSON.stringify(event)}\n`),
});
await relay.listen();
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void relay.close().then(() => { process.exitCode = 0; });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
