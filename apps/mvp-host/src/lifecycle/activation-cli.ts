import { randomUUID } from "node:crypto";
import type { ActivationOperation, ActivationResourceTarget } from "../storage/activation-store.js";
import { ActivationServiceError, type HostActivationService } from "./host-activation-service.js";

/**
 * Local management CLI for the explicit activation flow (design §6.3). This
 * module owns argument parsing only; main decides when the owner/maintenance
 * scope exists and hands in the constructed service. Nothing here launches a
 * Provider, Git or helper process.
 */

export const ACTIVATION_CLI_USAGE = [
  "usage:",
  "  activation verify --workspace <id> --provider <id> [--command-id <id>]",
  "  activation activate --evidence <operationId> --command-id <id>",
  "  activation inspect <operationId>",
].join("\n");

export type ActivationCliResult =
  | Readonly<{ command: "verify"; operationId: string; evidenceId: string; evidenceDigest: string; validUntil: string }>
  | Readonly<{ command: "activate"; operationId: string; activations: readonly ActivationResourceTarget[]; reused: boolean }>
  | Readonly<{ command: "inspect"; operation: ActivationOperation }>;

export const ACTIVATION_CLI_COMMANDS = Object.freeze(["verify", "activate", "inspect"] as const);
export type ActivationCliCommand = (typeof ACTIVATION_CLI_COMMANDS)[number];

/** Strict `--flag value` pairs: unknown/duplicate/missing values are usage errors. */
function parseFlags(argv: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || !allowed.includes(flag) || flag in flags) usage();
    flags[flag] = value;
  }
  return Object.freeze(flags);
}

function usage(): never {
  throw new ActivationServiceError("ACTIVATION_CLI_USAGE", ACTIVATION_CLI_USAGE);
}

export function isActivationCliCommand(value: string | undefined): value is ActivationCliCommand {
  return value !== undefined && (ACTIVATION_CLI_COMMANDS as readonly string[]).includes(value);
}

/**
 * Run one activation CLI command against an injected service. `verify` defaults
 * to a fresh random command ID; `activate` requires one so a lost response is
 * retried with the original command instead of writing a second receipt.
 */
export async function runActivationCli(argv: readonly string[], service: HostActivationService, options: { commandId?: () => string } = {}): Promise<ActivationCliResult> {
  const [command, ...rest] = argv;
  if (command === "verify") {
    const flags = parseFlags(rest, ["--workspace", "--provider", "--command-id"]);
    const workspaceId = flags["--workspace"];
    const providerInstanceId = flags["--provider"];
    if (!workspaceId || !providerInstanceId) usage();
    const commandId = flags["--command-id"] ?? (options.commandId?.() ?? randomUUID());
    const result = await service.verify({ workspaceId, providerInstanceId, commandId });
    return Object.freeze({ command: "verify" as const, operationId: result.operationId, evidenceId: result.evidenceId, evidenceDigest: result.evidenceDigest, validUntil: result.validUntil });
  }
  if (command === "activate") {
    const flags = parseFlags(rest, ["--evidence", "--command-id"]);
    const evidenceId = flags["--evidence"];
    const commandId = flags["--command-id"];
    if (!evidenceId || !commandId) usage();
    const result = service.activate({ evidenceId, commandId });
    return Object.freeze({ command: "activate" as const, operationId: result.operationId, activations: result.activations, reused: result.reused });
  }
  if (command === "inspect") {
    if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) usage();
    const operation = service.inspect(rest[0]);
    if (!operation) throw new ActivationServiceError("ACTIVATION_OPERATION_NOT_FOUND", "Unknown activation operation ID", ["ACTIVATION_OPERATION_NOT_FOUND"]);
    return Object.freeze({ command: "inspect" as const, operation });
  }
  usage();
}
