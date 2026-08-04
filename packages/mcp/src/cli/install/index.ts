import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { intro, outro, log, select, spinner } from "@clack/prompts";
import chalk from "chalk";
import { VERSION } from "../../config.js";
import { getClientConfig, CLIENTS, detectInstalledClients, type ClientId } from "./clients.js";
import { buildClaudeCodeMcpCommand } from "./claude.js";
import {
  existingRegistrationMessage,
  inspectExistingMcp,
  requireRegistrationName,
} from "./collision.js";

export interface InstallOpts {
  client?: string;
  yes: boolean;
  dev: boolean;
  all?: boolean;
  registrationName?: string;
  /** Suppress nested intro/outro when setup owns the surrounding flow. */
  skipWalletSetup?: boolean;
}

export interface InstallResult {
  complete: boolean;
  successes: string[];
  failures: string[];
}

/**
 * Render a client's MCP entry as a Codex-style TOML `[mcp_servers.opendexter]`
 * block. Used for clients we can't safely auto-edit (TOML config), so the
 * "manual" path still hands the user an exact block to paste instead of
 * leaving them to figure out the format.
 */
function renderTomlBlock(
  entry: Record<string, unknown>,
  registrationName: string,
): string {
  const command = typeof entry.command === "string" ? entry.command : "npx";
  const args = Array.isArray(entry.args) ? entry.args : [];
  const argsToml = args.map((a) => JSON.stringify(String(a))).join(", ");
  return [
    `[mcp_servers.${registrationName}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${argsToml}]`,
  ].join("\n");
}

export function writeClientConfig(
  clientId: ClientId,
  dev: boolean,
  registrationName = "opendexter",
): { ok: boolean; message: string } {
  const name = requireRegistrationName(registrationName);
  const config = getClientConfig(clientId, dev);

  if (config.manual) {
    // We don't auto-edit TOML configs. Hand the user the exact block to
    // paste rather than just naming the file and walking away.
    return {
      ok: false,
      message: [
        `${CLIENTS[clientId].name} uses a TOML config that the installer does not edit automatically.`,
        `Add this block to ${config.configPath}:`,
        "",
        renderTomlBlock(config.entry, name),
      ].join("\n"),
    };
  }

  mkdirSync(dirname(config.configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(config.configPath)) {
    const raw = readFileSync(config.configPath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        message:
          `${config.configPath} contains invalid JSON. Setup left it unchanged; repair it and rerun install.`,
      };
    }

    const existingSection = existing[config.sectionKey];
    if (
      existingSection
      && typeof existingSection === "object"
      && !Array.isArray(existingSection)
      && Object.prototype.hasOwnProperty.call(existingSection, name)
    ) {
      return {
        ok: false,
        message: existingRegistrationMessage(
          CLIENTS[clientId].name,
          "present",
          name,
        ),
      };
    }

    // Back up valid configs too
    if (Object.keys(existing).length > 0) {
      copyFileSync(config.configPath, config.configPath + ".bak");
    }
  }

  const section = (existing[config.sectionKey] as Record<string, unknown>) || {};
  section[name] = config.entry;
  existing[config.sectionKey] = section;

  writeFileSync(config.configPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    ok: true,
    message: `Installed ${name} into ${CLIENTS[clientId].name} (${config.configPath})`,
  };
}

// ---------------------------------------------------------------------------
// Package root resolution (for copying plugin assets)
// ---------------------------------------------------------------------------

function getPackageRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  let dir = dirname(__filename);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "skills"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate opendexter package root");
}

// ---------------------------------------------------------------------------
// Cursor full plugin installation (MCP + skills + rules + agents + commands)
// ---------------------------------------------------------------------------

function installCursorPlugin(
  dev: boolean,
  registrationName: string,
): { ok: boolean; message: string } {
  const pkgRoot = getPackageRoot();
  const target = join(homedir(), ".cursor", "plugins", "opendexter");

  mkdirSync(target, { recursive: true });

  // Copy plugin content directories
  const dirs = ["skills", "rules", "agents", "commands", "assets"];
  for (const d of dirs) {
    const src = join(pkgRoot, d);
    if (existsSync(src)) {
      const dest = join(target, d);
      cpSync(src, dest, { recursive: true, force: true });
    }
  }

  // Copy .cursor-plugin/plugin.json
  const cursorPluginSrc = join(pkgRoot, ".cursor-plugin", "plugin.json");
  if (existsSync(cursorPluginSrc)) {
    mkdirSync(join(target, ".cursor-plugin"), { recursive: true });
    copyFileSync(cursorPluginSrc, join(target, ".cursor-plugin", "plugin.json"));
  }

  // Write mcp.json inside the plugin directory
  const mcpEntry = dev
    ? { command: "node", args: [process.cwd() + "/dist/index.js", "--dev"] }
    : { command: "npx", args: ["-y", `@dexterai/opendexter@${VERSION}`] };

  writeFileSync(
    join(target, "mcp.json"),
    JSON.stringify(
      { mcpServers: { [registrationName]: mcpEntry } },
      null,
      2,
    ) + "\n",
  );

  const skillCount = existsSync(join(target, "skills"))
    ? readdirSync(join(target, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;

  return {
    ok: true,
    message: `Full plugin installed into Cursor (${skillCount} skills, rules, agent, commands) at ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Claude Code local MCP installation via CC CLI
// ---------------------------------------------------------------------------

async function tryExec(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (stderr || stdout || err.message).trim() });
      } else {
        resolve({ ok: true, output: (stdout || "").trim() });
      }
    });
  });
}

async function installClaudeCodeMcp(
  dev: boolean,
  registrationName: string,
): Promise<{ ok: boolean; message: string }> {
  const command = buildClaudeCodeMcpCommand(
    dev,
    process.cwd(),
    registrationName,
  );
  const result = await tryExec(command.command, command.args);
  if (!result.ok) {
    return {
      ok: false,
      message: [
        `Could not add the local OpenDexter MCP through Claude Code: ${result.output}`,
        "",
        "Run this command manually:",
        `  ${command.command} ${command.args.join(" ")}`,
      ].join("\n"),
    };
  }

  return {
    ok: true,
    message: `Local OpenDexter stdio MCP added to Claude Code as ${registrationName} at user scope`,
  };
}

async function promptForClient(): Promise<ClientId> {
  const ids = Object.keys(CLIENTS) as ClientId[];
  const answer = await select({
    message: "Choose a client to install OpenDexter into",
    options: ids.map((id) => ({
      value: id,
      label: CLIENTS[id].name,
      hint: CLIENTS[id].description,
    })),
  });
  if (typeof answer !== "string" || !CLIENTS[answer as ClientId]) {
    throw new Error("No client selected.");
  }
  return answer as ClientId;
}

export async function runInstall(opts: InstallOpts): Promise<InstallResult> {
  const registrationName = requireRegistrationName(
    opts.registrationName ?? "opendexter",
  );
  if (!opts.skipWalletSetup) intro(chalk.bold("OpenDexter install"));

  let targetClients: ClientId[] = [];

  if (opts.all) {
    targetClients = detectInstalledClients();
    if (targetClients.length === 0) {
      console.error("No supported AI clients were auto-detected on this machine.");
      process.exit(1);
    }
    log.step(`Detected clients: ${targetClients.map((id) => CLIENTS[id].name).join(", ")}`);
  } else {
    let clientId = opts.client as ClientId | undefined;

    if (!clientId) {
      if (opts.yes) {
        console.error("--client is required when using --yes, unless you pass --all");
        process.exit(1);
      }
      clientId = await promptForClient();
    }

    if (!CLIENTS[clientId]) {
      console.error(`Unknown client: ${clientId}`);
      console.error(`Available: ${Object.keys(CLIENTS).join(", ")}`);
      process.exit(1);
    }

    targetClients = [clientId];
  }

  const successes: string[] = [];
  const failures: string[] = [];

  // Read every target before touching a client config or wallet. Partial
  // installs may proceed only for names proven absent; present/unknown names
  // remain untouched and receive an exact next action.
  const preflight = await Promise.all(
    targetClients.map(async (clientId) => ({
      clientId,
      probe: await inspectExistingMcp(clientId, registrationName),
    })),
  );
  const eligible = new Set<ClientId>();
  for (const { clientId, probe } of preflight) {
    if (probe.state === "absent") {
      eligible.add(clientId);
    } else {
      failures.push(
        existingRegistrationMessage(
          CLIENTS[clientId].name,
          probe,
          registrationName,
        ),
      );
    }
  }

  for (const clientId of targetClients) {
    if (!eligible.has(clientId)) continue;

    if (clientId === "claude-code") {
      // Use Claude Code's supported MCP command. The repository plugin is the
      // separate hosted product and must not be installed by this local CLI.
      const ps = spinner();
      ps.start("Adding local OpenDexter MCP to Claude Code");
      const mcpResult = await installClaudeCodeMcp(
        opts.dev,
        registrationName,
      );
      if (mcpResult.ok) {
        ps.stop("Local MCP added through Claude Code");
        successes.push(mcpResult.message);
      } else {
        ps.stop("Automatic Claude Code MCP setup unavailable");
        failures.push(mcpResult.message);
      }
    } else if (clientId === "cursor") {
      // Cursor gets full plugin install (skills, rules, agents, commands, MCP)
      // into ~/.cursor/plugins/opendexter/ — plus MCP config in ~/.cursor/mcp.json
      const s = spinner();
      s.start("Installing OpenDexter plugin into Cursor");
      const result = writeClientConfig(clientId, opts.dev, registrationName);
      if (!result.ok) {
        s.stop("Existing OpenDexter registration left unchanged");
        failures.push(result.message);
        continue;
      }
      successes.push(result.message);
      try {
        const pluginResult = installCursorPlugin(
          opts.dev,
          registrationName,
        );
        s.stop("Cursor plugin installed (MCP + skills)");
        successes.push(pluginResult.message);
      } catch (err: any) {
        s.stop("Cursor MCP installed (skills copy failed)");
        failures.push(`Skills install failed: ${err.message}`);
      }
    } else {
      // All other clients: write MCP server entry to their config file
      const s = spinner();
      s.start(`Installing into ${CLIENTS[clientId].name}`);
      const result = writeClientConfig(clientId, opts.dev, registrationName);
      if (result.ok) {
        s.stop(`${CLIENTS[clientId].name} installed`);
        successes.push(result.message);
      } else {
        s.stop(`${CLIENTS[clientId].name} needs manual setup`);
        failures.push(result.message);
      }
    }
  }

  log.step("Install summary");
  for (const line of successes) log.success(line);
  for (const line of failures) log.warn(line);

  const result = {
    complete: failures.length === 0,
    successes,
    failures,
  } satisfies InstallResult;

  if (!opts.skipWalletSetup) {
    if (result.complete) {
      outro(
        "OpenDexter is wired in. Search and check work without a wallet or funding; configure payment authority only before the user's instruction or delegated policy authorizes a paid call.",
      );
    } else if (successes.length > 0) {
      outro("OpenDexter installation is incomplete. Resolve the client setup failures above, then rerun install.");
    } else {
      outro("OpenDexter was not installed. Resolve the client registration issue above, then rerun install.");
    }
  }

  return result;
}
