import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { intro, outro, log, select, spinner } from "@clack/prompts";
import chalk from "chalk";
import { VERSION } from "../../config.js";
import { loadOrCreateWallet } from "../../wallet/index.js";
import { getClientConfig, CLIENTS, detectInstalledClients, type ClientId } from "./clients.js";
import { buildClaudeCodeMcpCommand } from "./claude.js";

interface InstallOpts {
  client?: string;
  yes: boolean;
  dev: boolean;
  all?: boolean;
  skipWalletSetup?: boolean;
}

/**
 * Render a client's MCP entry as a Codex-style TOML `[mcp_servers.opendexter]`
 * block. Used for clients we can't safely auto-edit (TOML config), so the
 * "manual" path still hands the user an exact block to paste instead of
 * leaving them to figure out the format.
 */
function renderTomlBlock(entry: Record<string, unknown>): string {
  const command = typeof entry.command === "string" ? entry.command : "npx";
  const args = Array.isArray(entry.args) ? entry.args : [];
  const argsToml = args.map((a) => JSON.stringify(String(a))).join(", ");
  return [
    "[mcp_servers.opendexter]",
    `command = ${JSON.stringify(command)}`,
    `args = [${argsToml}]`,
  ].join("\n");
}

function writeClientConfig(clientId: ClientId, dev: boolean): { ok: boolean; message: string } {
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
        renderTomlBlock(config.entry),
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
      console.error(`Warning: ${config.configPath} contains invalid JSON. Backing up and creating fresh.`);
      copyFileSync(config.configPath, config.configPath + ".bak");
      existing = {};
    }
    // Back up valid configs too
    if (Object.keys(existing).length > 0) {
      copyFileSync(config.configPath, config.configPath + ".bak");
    }
  }

  const section = (existing[config.sectionKey] as Record<string, unknown>) || {};
  section["opendexter"] = config.entry;
  existing[config.sectionKey] = section;

  writeFileSync(config.configPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    ok: true,
    message: `Installed into ${CLIENTS[clientId].name} (${config.configPath})`,
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

function installCursorPlugin(dev: boolean): { ok: boolean; message: string } {
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
    JSON.stringify({ mcpServers: { opendexter: mcpEntry } }, null, 2) + "\n",
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

async function installClaudeCodeMcp(dev: boolean): Promise<{ ok: boolean; message: string }> {
  const command = buildClaudeCodeMcpCommand(dev);
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
    message: "Local OpenDexter stdio MCP added to Claude Code at user scope",
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

export async function runInstall(opts: InstallOpts): Promise<void> {
  // Step 1: ensure wallet exists
  let wallet = null;
  if (!opts.skipWalletSetup) {
    intro(chalk.bold("OpenDexter install"));
    const s = spinner();
    s.start("Activating wallet");
    wallet = await loadOrCreateWallet({ quiet: true });
    if (!wallet) {
      s.stop("Wallet activation failed");
      process.exit(1);
    }
    const statusMessage =
      wallet.status === "created"
        ? "New wallet activated"
        : wallet.status === "migrated"
          ? "Wallet upgraded for multichain use"
          : wallet.status === "env"
            ? "Wallet loaded from environment"
            : "Wallet online";
    s.stop(statusMessage);
    log.info(`Solana rail: ${wallet.info.solanaAddress}`);
    if (wallet.info.evmAddress) log.info(`EVM rail:    ${wallet.info.evmAddress}`);
  } else {
    wallet = await loadOrCreateWallet({ quiet: true });
    if (!wallet) {
      console.error("Failed to load wallet. Exiting.");
      process.exit(1);
    }
  }

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

  for (const clientId of targetClients) {
    if (clientId === "claude-code") {
      // Use Claude Code's supported MCP command. The repository plugin is the
      // separate hosted product and must not be installed by this local CLI.
      const ps = spinner();
      ps.start("Adding local OpenDexter MCP to Claude Code");
      const mcpResult = await installClaudeCodeMcp(opts.dev);
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
      const result = writeClientConfig(clientId, opts.dev);
      if (result.ok) {
        successes.push(result.message);
      }
      try {
        const pluginResult = installCursorPlugin(opts.dev);
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
      const result = writeClientConfig(clientId, opts.dev);
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

  if (!opts.skipWalletSetup) {
    outro("OpenDexter is wired in. Fund your rails when you're ready to settle your first paid call.");
  }
}
