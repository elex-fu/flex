import { parseRecoveryCommand, type RecoveryCliCommand } from "./recovery-cli.js";
import { parseHostOperationsCommand, HOST_OPERATIONS_CLI_USAGE, type HostOperationsCliCommand } from "./operations-cli.js";
import { parseCatalogImportCommand, CATALOG_IMPORT_CLI_USAGE, type CatalogImportCliCommand } from "../catalog/catalog-import-cli.js";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

type PairingDetails = { displayName?: string; platform?: string; proposedDevicePublicKey?: string };
export type TerminalConfirmation = ((proposal?: PairingDetails) => Promise<boolean>) & { close(): void };

export interface TerminalConfirmationOptions {
  interactive?: boolean;
  requireConfirmation?: boolean;
  timeoutMs?: number;
  prompt?: string;
  accept?: (answer: string) => boolean;
  ask?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

/** One prompt owns stdin at a time. Time spent waiting in the queue counts
 * against a request's deadline, so abandoned phone requests cannot linger. */
export function createPairingConfirmation(options: TerminalConfirmationOptions = {}): TerminalConfirmation {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const requireConfirmation = options.requireConfirmation ?? process.env.FLYX_REQUIRE_PAIRING_CONFIRM !== "0";
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) throw new Error("Confirmation timeout must be between 1 ms and 5 minutes");
  const accept = options.accept ?? ((answer: string) => /^(y|yes)$/i.test(answer.trim()));
  const ask = options.ask ?? askTerminal;
  let closed = false;
  let queue = Promise.resolve();
  let active: AbortController | undefined;
  const confirmation = ((proposal?: PairingDetails) => {
    if (closed) return Promise.resolve(false);
    if (!requireConfirmation) return Promise.resolve(true);
    if (!interactive) return Promise.resolve(false);
    const expiresAt = Date.now() + timeoutMs;
    const result = queue.then(async () => {
      const remaining = expiresAt - Date.now();
      if (closed || remaining <= 0) return false;
      const controller = new AbortController();
      active = controller;
      let cancel: (() => void) | undefined;
      const aborted = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      const timer = setTimeout(() => controller.abort(), remaining);
      timer.unref();
      try {
        return await Promise.race([
          ask(options.prompt ?? pairingPrompt(proposal), controller.signal).then(accept).catch(() => false),
          aborted,
        ]);
      } finally {
        clearTimeout(timer);
        if (cancel) controller.signal.removeEventListener("abort", cancel);
        active = undefined;
      }
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }) as TerminalConfirmation;
  confirmation.close = () => { closed = true; active?.abort(); };
  return confirmation;
}

function pairingPrompt(proposal: PairingDetails | undefined): string {
  if (!proposal?.proposedDevicePublicKey) return "Approve this phone pairing? [y/N] ";
  const label = (proposal.displayName ?? proposal.platform ?? "phone").replace(/\p{C}/gu, "").slice(0, 80);
  const keyFingerprint = createHash("sha256").update(proposal.proposedDevicePublicKey).digest("hex").slice(0, 16);
  return `Approve pairing for ${JSON.stringify(label)} (device key ${keyFingerprint})? [y/N] `;
}

async function askTerminal(prompt: string, signal: AbortSignal): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return await readline.question(prompt, { signal }); }
  finally { readline.close(); }
}

export type HostCommand = { kind: "start" | "help" | "devices-list" | "devices-revoke-all" | "identity-show" | "identity-rotate" }
  | { kind: "devices-revoke"; deviceId: string } | RecoveryCliCommand | HostOperationsCliCommand | CatalogImportCliCommand;

export function parseHostCommand(args: readonly string[]): HostCommand {
  const operations = parseHostOperationsCommand(args);
  if (operations) return operations;
  const catalog = parseCatalogImportCommand(args);
  if (catalog) return catalog;
  const recovery = parseRecoveryCommand(args);
  if (recovery) return recovery;
  if (!args.length || args.length === 1 && args[0] === "start") return { kind: "start" };
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0]!)) return { kind: "help" };
  if (args.length === 2 && args[0] === "devices" && args[1] === "list") return { kind: "devices-list" };
  if (args.length === 2 && args[0] === "devices" && args[1] === "revoke-all") return { kind: "devices-revoke-all" };
  if (args.length === 2 && args[0] === "identity" && args[1] === "show") return { kind: "identity-show" };
  if (args.length === 2 && args[0] === "identity" && args[1] === "rotate") return { kind: "identity-rotate" };
  if (args.length === 3 && args[0] === "devices" && args[1] === "revoke" && /^[a-zA-Z0-9_-]{1,128}$/.test(args[2]!)) {
    return { kind: "devices-revoke", deviceId: args[2]! };
  }
  throw new Error(`Usage: start | devices list | devices revoke <deviceId> | devices revoke-all | identity show | identity rotate | ${HOST_OPERATIONS_CLI_USAGE} | ${CATALOG_IMPORT_CLI_USAGE}`);
}
