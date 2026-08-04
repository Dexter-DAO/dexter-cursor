import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getClientConfig, type ClientId } from "./clients.js";

export type ExistingMcpState = "absent" | "present" | "unknown";
export type ExistingMcpKind =
  | "none"
  | "local_stdio"
  | "remote_http"
  | "other"
  | "unknown";
export type ExistingMcpDisposition =
  | "name_available"
  | "upgrade_local"
  | "replace_existing"
  | "inspect_manually";

export interface ExistingMcpProbe {
  state: ExistingMcpState;
  kind: ExistingMcpKind;
  disposition: ExistingMcpDisposition;
  detail: string;
  /** Exact registration that triggered the result, when known. */
  registrationName?: string;
}

interface CommandProbe {
  command: string;
  args: string[];
}

const REGISTRATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function requireRegistrationName(value: string): string {
  const name = value.trim();
  if (!REGISTRATION_NAME_RE.test(name)) {
    throw new Error(
      "Registration name must be 1-64 letters, numbers, underscores, or hyphens.",
    );
  }
  return name;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function presentProbe(
  kind: ExistingMcpKind,
  registrationName?: string,
): ExistingMcpProbe {
  const identity = registrationName ? ` named ${registrationName}` : "";
  if (kind === "local_stdio") {
    return {
      state: "present",
      kind,
      disposition: "upgrade_local",
      detail: `A local stdio MCP registration${identity} already exists.`,
      ...(registrationName ? { registrationName } : {}),
    };
  }
  if (kind === "remote_http") {
    return {
      state: "present",
      kind,
      disposition: "replace_existing",
      detail: `A remote HTTP MCP registration${identity} already exists.`,
      ...(registrationName ? { registrationName } : {}),
    };
  }
  return {
    state: "present",
    kind: kind === "none" ? "other" : kind,
    disposition: "inspect_manually",
    detail: `An MCP registration${identity} already exists; its transport was not recognized.`,
    ...(registrationName ? { registrationName } : {}),
  };
}

function kindFromValue(value: unknown): ExistingMcpKind {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  if (!output) return "other";
  const normalized = output.toLowerCase();
  if (
    normalized.includes("@dexterai/opendexter")
    || /\btransport\s*[:=]\s*stdio\b/.test(normalized)
    || /\bcommand\s*[:=]\s*(?:npx|node)\b/.test(normalized)
    || /"transport"\s*:\s*"stdio"/.test(normalized)
    || /"command"\s*:\s*"(?:npx|node)"/.test(normalized)
  ) {
    return "local_stdio";
  }
  if (
    /\b(?:streamable[_ -]?http|sse|http)\b/.test(normalized)
    || /https?:\/\//.test(normalized)
  ) {
    return "remote_http";
  }
  return "other";
}

function isOpenDexterRegistration(value: unknown): boolean {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  if (!output) return false;
  const normalized = output.toLowerCase();
  return normalized.includes("@dexterai/opendexter")
    || normalized.includes("https://open.dexter.cash/mcp")
    || normalized.includes("opendexter@opendexter");
}

export function existingMcpCommand(
  clientId: ClientId,
  registrationName = "opendexter",
): CommandProbe | null {
  const name = requireRegistrationName(registrationName);
  if (clientId === "codex") {
    return { command: "codex", args: ["mcp", "get", name] };
  }
  return null;
}

export function existingMcpListCommand(clientId: ClientId): CommandProbe | null {
  if (clientId === "codex") {
    return { command: "codex", args: ["mcp", "list", "--json"] };
  }
  return null;
}

export function classifyExistingMcpProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  registrationName = "opendexter",
): ExistingMcpProbe {
  const name = requireRegistrationName(registrationName);
  const output = `${stdout}\n${stderr}`.trim();
  if (exitCode === 0) {
    return presentProbe(kindFromValue(output), name);
  }
  if (new RegExp(`No MCP server named ["']?${escaped(name)}["']?`, "i").test(output)) {
    return {
      state: "absent",
      kind: "none",
      disposition: "name_available",
      detail: "No registration uses this name.",
    };
  }
  return {
    state: "unknown",
    kind: "unknown",
    disposition: "inspect_manually",
    detail: "The client could not safely confirm whether this MCP name is already registered.",
  };
}

export function classifyOpenDexterListProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): ExistingMcpProbe {
  const output = `${stdout}\n${stderr}`.trim();
  if (exitCode === 0 && !isOpenDexterRegistration(output)) {
    return {
      state: "absent",
      kind: "none",
      disposition: "name_available",
      detail: "No other recognizable OpenDexter registration was listed.",
    };
  }
  if (exitCode === 0) {
    return presentProbe(kindFromValue(output), "another OpenDexter entry");
  }
  return {
    state: "unknown",
    kind: "unknown",
    disposition: "inspect_manually",
    detail:
      "The client could not safely list registrations to rule out another OpenDexter entry.",
  };
}

function inspectJsonRegistration(
  clientId: ClientId,
  registrationName: string,
): ExistingMcpProbe {
  const config = getClientConfig(clientId, false);
  if (!existsSync(config.configPath)) {
    return {
      state: "absent",
      kind: "none",
      disposition: "name_available",
      detail: "No registration uses this name.",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(config.configPath, "utf8"));
    const section = parsed?.[config.sectionKey];
    if (
      !section
      || typeof section !== "object"
      || Array.isArray(section)
      || !Object.prototype.hasOwnProperty.call(section, registrationName)
    ) {
      return {
        state: "absent",
        kind: "none",
        disposition: "name_available",
        detail: "No registration uses this name.",
      };
    }
    return presentProbe(kindFromValue(section[registrationName]), registrationName);
  } catch {
    return {
      state: "unknown",
      kind: "unknown",
      disposition: "inspect_manually",
      detail: "The client configuration could not be parsed safely; it was not changed.",
    };
  }
}

function inspectJsonOpenDexterRegistrations(
  clientId: ClientId,
  registrationName: string,
): ExistingMcpProbe {
  const config = getClientConfig(clientId, false);
  if (!existsSync(config.configPath)) {
    return {
      state: "absent",
      kind: "none",
      disposition: "name_available",
      detail: "No other recognizable OpenDexter registration was found.",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(config.configPath, "utf8"));
    const section = parsed?.[config.sectionKey];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return {
        state: "absent",
        kind: "none",
        disposition: "name_available",
        detail: "No other recognizable OpenDexter registration was found.",
      };
    }
    for (const [name, value] of Object.entries(section)) {
      if (name === registrationName || name === "opendexter") continue;
      if (isOpenDexterRegistration(value)) {
        return presentProbe(kindFromValue(value), name);
      }
    }
    return {
      state: "absent",
      kind: "none",
      disposition: "name_available",
      detail: "No other recognizable OpenDexter registration was found.",
    };
  } catch {
    return {
      state: "unknown",
      kind: "unknown",
      disposition: "inspect_manually",
      detail: "The client configuration could not be parsed safely; it was not changed.",
    };
  }
}

function findOpenDexterConfigEntry(
  value: unknown,
  requestedName: string,
): { name: string; value: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "mcpServers" || key === "mcp_servers")
      && child
      && typeof child === "object"
      && !Array.isArray(child)
    ) {
      for (const [name, entry] of Object.entries(child)) {
        if (
          name === requestedName
          || name === "opendexter"
          || isOpenDexterRegistration(entry)
        ) {
          return { name, value: entry };
        }
      }
    }
    const nested = findOpenDexterConfigEntry(child, requestedName);
    if (nested) return nested;
  }
  return null;
}

export function classifyStaticClaudeDocuments(
  registrationName: string,
  documents: unknown[],
): ExistingMcpProbe {
  const name = requireRegistrationName(registrationName);
  for (const document of documents) {
    const entry = findOpenDexterConfigEntry(document, name);
    if (entry) return presentProbe(kindFromValue(entry.value), entry.name);
    if (isOpenDexterRegistration(document)) {
      return presentProbe("remote_http", "installed OpenDexter plugin");
    }
  }
  return {
    state: "absent",
    kind: "none",
    disposition: "name_available",
    detail: "No recognizable OpenDexter registration was found in static Claude configuration.",
  };
}

function inspectStaticClaudeRegistrations(
  registrationName: string,
): ExistingMcpProbe {
  const paths = [
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "plugins", "installed_plugins.json"),
    resolve(process.cwd(), ".mcp.json"),
    resolve(process.cwd(), ".claude", "settings.json"),
    resolve(process.cwd(), ".claude", "settings.local.json"),
  ];
  const documents: unknown[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      documents.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return {
        state: "unknown",
        kind: "unknown",
        disposition: "inspect_manually",
        detail:
          "A Claude configuration file could not be parsed safely; no command was run and nothing was changed.",
      };
    }
  }
  return classifyStaticClaudeDocuments(registrationName, documents);
}

function runCommandProbe(
  probe: CommandProbe,
  classify: (exitCode: number | null, stdout: string, stderr: string) => ExistingMcpProbe,
): Promise<ExistingMcpProbe> {
  return new Promise((resolve) => {
    execFile(probe.command, probe.args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
      resolve(classify(exitCode, stdout || "", stderr || ""));
    });
  });
}

async function inspectOneMcp(
  clientId: ClientId,
  registrationName: string,
): Promise<ExistingMcpProbe> {
  const name = requireRegistrationName(registrationName);
  const probe = existingMcpCommand(clientId, name);
  if (!probe) return inspectJsonRegistration(clientId, name);
  return runCommandProbe(probe, (exitCode, stdout, stderr) =>
    classifyExistingMcpProbe(exitCode, stdout, stderr, name));
}

/**
 * Reduce requested-name and canonical-name probes without depending on probe
 * order. Any present registration wins, then any uncertain read; only every
 * name being proven absent makes installation eligible.
 */
export function combineOpenDexterProbes(
  registrationName: string,
  probes: ExistingMcpProbe[],
): ExistingMcpProbe {
  const requested = requireRegistrationName(registrationName);
  const present = probes
    .filter((probe) => probe.state === "present")
    .sort((left, right) => {
      const priority = (probe: ExistingMcpProbe) =>
        probe.registrationName === "opendexter"
          ? 0
          : probe.registrationName === requested
            ? 1
            : 2;
      return priority(left) - priority(right);
    })[0];
  if (present) return present;
  const unknown = probes.find((probe) => probe.state === "unknown");
  if (unknown) return unknown;
  return {
    state: "absent",
    kind: "none",
    disposition: "name_available",
    detail: "No OpenDexter registration was found under the requested or canonical name.",
  };
}

export async function inspectExistingMcp(
  clientId: ClientId,
  registrationName = "opendexter",
): Promise<ExistingMcpProbe> {
  const name = requireRegistrationName(registrationName);
  const names = name === "opendexter" ? [name] : [name, "opendexter"];
  const listCommand = existingMcpListCommand(clientId);
  const additional = listCommand
    ? [runCommandProbe(listCommand, classifyOpenDexterListProbe)]
    : [
        Promise.resolve(inspectJsonOpenDexterRegistrations(clientId, name)),
        ...(clientId === "claude-code"
          ? [Promise.resolve(inspectStaticClaudeRegistrations(name))]
          : []),
      ];
  return combineOpenDexterProbes(
    name,
    await Promise.all([
      ...names.map((candidate) => inspectOneMcp(clientId, candidate)),
      ...additional,
    ]),
  );
}

export function existingRegistrationMessage(
  clientName: string,
  probeOrState: ExistingMcpProbe | ExistingMcpState,
  registrationName = "opendexter",
): string {
  const name = requireRegistrationName(registrationName);
  const probe = typeof probeOrState === "string"
    ? probeOrState === "present"
      ? presentProbe("other", name)
      : {
          state: probeOrState,
          kind: "unknown" as const,
          disposition: "inspect_manually" as const,
          detail: "The client could not safely confirm this registration.",
        }
    : probeOrState;
  const existingName = probe.registrationName ?? name;
  const existingIdentity = existingName === "another OpenDexter entry"
    ? "Another recognizable OpenDexter MCP registration"
    : `An MCP registration named ${existingName}`;
  const reason = probe.state === "present"
    ? `${existingIdentity} already exists in ${clientName}. ${probe.detail}`
    : `${clientName} could not prove that the requested name ${name} and canonical name opendexter are free of an existing OpenDexter registration.`;
  const next = probe.disposition === "upgrade_local"
    ? "Upgrade or remove that local registration intentionally before installing another OpenDexter registration."
    : probe.disposition === "replace_existing"
      ? "Keep the remote registration, or remove it intentionally before installing the local package."
      : "Inspect the existing client configuration, then keep one OpenDexter registration or remove it intentionally before installing another.";
  return [
    reason,
    "Setup left the client unchanged.",
    "The hosted connector and local package use different wallet authority and must not share one client registration name.",
    "Aliasing does not make two OpenDexter registrations safe in a client whose duplicate tool-name namespacing has not been proven.",
    next,
  ].join(" ");
}
