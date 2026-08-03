import { execFile } from "node:child_process";

import type { ClientId } from "./clients.js";

export type ExistingMcpState = "absent" | "present" | "unknown";

export interface ExistingMcpProbe {
  state: ExistingMcpState;
  detail: string;
}

interface CommandProbe {
  command: string;
  args: string[];
}

export function existingMcpCommand(clientId: ClientId): CommandProbe | null {
  if (clientId === "claude-code") {
    return { command: "claude", args: ["mcp", "get", "opendexter"] };
  }
  if (clientId === "codex") {
    return { command: "codex", args: ["mcp", "get", "opendexter"] };
  }
  return null;
}

export function classifyExistingMcpProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): ExistingMcpProbe {
  const output = `${stdout}\n${stderr}`.trim();
  if (exitCode === 0) {
    return { state: "present", detail: output || "Existing registration found." };
  }
  if (/No MCP server named ["']?opendexter["']?/i.test(output)) {
    return { state: "absent", detail: output };
  }
  return {
    state: "unknown",
    detail: output || "The client could not confirm whether OpenDexter is already registered.",
  };
}

export async function inspectExistingMcp(clientId: ClientId): Promise<ExistingMcpProbe> {
  const probe = existingMcpCommand(clientId);
  if (!probe) return { state: "absent", detail: "No client CLI probe is required." };

  return new Promise((resolve) => {
    execFile(probe.command, probe.args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
      resolve(classifyExistingMcpProbe(exitCode, stdout || "", stderr || ""));
    });
  });
}

export function existingRegistrationMessage(clientName: string, state: ExistingMcpState): string {
  const reason = state === "present"
    ? `An OpenDexter MCP registration already exists in ${clientName}.`
    : `${clientName} could not prove that the OpenDexter MCP name is unused.`;
  return [
    reason,
    "Setup left the client unchanged.",
    "The hosted connector and local package use different wallet authority and must not share one client registration name.",
    "Remove or rename the existing registration intentionally before installing the local package.",
  ].join(" ");
}
